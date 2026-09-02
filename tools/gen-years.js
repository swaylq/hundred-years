'use strict';
/* 生成 100 张年卡。
 *
 *   secret exec OPENROUTER_API_KEY -- node tools/gen-years.js [选项]
 *     --years 1930,1948-1952   只做这些年（默认 1926-2025）
 *     --model  <id>            换模型（默认 google/gemini-3.1-flash-lite）
 *     --jobs N                 并发，默认 6
 *     --force                  忽略缓存和已有文件，重新生成
 *     --dry                    只打印一份提示词就退出，不花钱
 *
 * 生成完当场跑 tools/check-years.js 的 checkCard；不过就把错误清单贴回去让它重写，
 * 最多三次。三次都不过的年份留在 data/years/_failed/ 里，不写进正式目录。
 */
const fs = require('fs');
const path = require('path');
const OR = require('./or.js');
const { checkCard, MIN, FLAVOR } = require('./check-years.js');

const ROOT = path.join(__dirname, '..');
const SPINE = require(path.join(ROOT, 'data', 'spine.json'));
const TL = require(path.join(ROOT, 'data', 'tech-timeline.json'));
const DIR = path.join(ROOT, 'data', 'years');
const FAIL = path.join(DIR, '_failed');
const CACHE = new OR.Cache(path.join(ROOT, 'data', '.gen-cache.json'));

const PROMPT_VER = 'v1';
const CN = { SILVER: '银元', FABI: '法币', GOLDYUAN: '金圆券', RMB1: '第一套人民币', RMB: '人民币' };

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : (i >= 0 ? true : d); };
const MODEL = String(arg('model', 'deepseek/deepseek-v4-flash'));
const JOBS = Number(arg('jobs', 6));
const FORCE = !!arg('force');
const DRY = !!arg('dry');

function parseYears(s) {
  if (!s || s === true) return SPINE.years.map(y => y.year);
  const out = [];
  for (const part of String(s).split(',')) {
    const m = part.match(/^(\d{4})-(\d{4})$/);
    if (m) for (let y = +m[1]; y <= +m[2]; y++) out.push(y);
    else out.push(Number(part));
  }
  return out.filter(y => y >= 1926 && y <= 2025);
}
const YEARS = parseYears(arg('years'));

/* ── 提示词 ────────────────────────────────────────── */

const SYS = `你在给一个叫《这一百年》的游戏写背景资料。

【这是个什么游戏】
玩家挑 1926 到 2025 之间的一年一个月，落进那时候的中国，在一座城里过 30 天。
每天写一份自己要做的事的清单，模型照那一年真实的条件演算当天发生了什么。
三十天以后结算他攒下多少家底，换算成「相当于那一年多少年的中位收入」进排行榜。

【你写的东西干什么用】
你写的是一整年的背景资料。它是**约束**，不是介绍。
玩家会在 1930 年说「我做个手机应用」，在 1962 年说「我注册家公司」——
把他顶回去的就是你写的这张卡。所以每一条都要能拿来当尺子量，不要写成百科词条。

【怎么写】
白描，短句，具体。用数目、价钱、时辰、器物、谁说了哪一句说话。
不抒情，不替读者下判断，不总结时代意义，不用四字排比。

照这个感觉写：
  「一斤大米六分钱，一个纱厂女工一个月挣十二块，够一家四口糊口，不够生病。」
  「码头上招工不看本事，看你认不认识那个拿名册的。」
  「粮站的米按本供应，本上写着几口人。多出来的嘴，得自己想办法。」
别写成这样：
  「这一年是中国近代史的重要转折点。」——总结陈词
  「人民的生活水平有了显著提高。」——公文腔
  「机遇与挑战并存。」——什么也没说

【几条不许犯的】
1. 不许写这一年还没有的东西。资料里会给你一张「这一年有什么、没什么」的清单，照它写。
2. 不许出现游戏用语：玩家、系统、机制、数值、属性、加成、触发、解锁、副本、难度。
3. 物价一律用那一年真正流通的钱。给你写清楚了是哪一种。
4. 政治敏感的年份照实写事，写发生了什么、对一个普通人的日子有什么影响，不做评论，
   不站队，不用宣传腔，也不回避。

【输出】
只输出一个 JSON 对象，不要有别的话，不要包在 \`\`\` 里。`;

function techFor(year) {
  const has = [], hasRare = [], gone = [], soon = [];
  for (const it of TL.items) {
    const on = it.from <= year && !(it.until && it.until < year);
    if (on) (it.tier === '日常' ? has : hasRare).push(it.name + (it.note ? `（${it.note}）` : ''));
    else if (it.until && it.until < year && year - it.until <= 12) gone.push(`${it.name}（${it.until} 年就没了）`);
    else if (it.from > year) soon.push({ name: it.name, from: it.from });
  }
  soon.sort((a, b) => a.from - b.from);
  return { has, hasRare, gone, soon: soon.slice(0, 22).map(s => `${s.name}（要到 ${s.from} 年）`) };
}

function userPrompt(sy) {
  const y = sy.year;
  const t = techFor(y);
  const jan = sy.months[0];
  const curNames = sy.currencies.map(c => CN[c]);
  const sw = sy.switch;
  const monthly = sy.months.map(m => `${m.month}月 ${CN[m.currency]} 年收入约 ${fmtNum(m.income)}`).join('；');

  return `【要写哪一年】${y} 年，落点城市：${sy.city}

【钱】这一年流通的是：${curNames.join(' 和 ')}
一个普通城里人的中位年收入，1 月大约 ${fmtNum(jan.income)} ${CN[jan.currency]}（一个月约 ${fmtNum(jan.income / 12)}）。
年内逐月：${monthly}
当年物价${sy.inflation > 3 ? `涨了 ${(1 + sy.inflation).toFixed(0)} 倍` : sy.inflation < 0 ? `跌了 ${(-sy.inflation * 100).toFixed(1)}%` : `涨了 ${(sy.inflation * 100).toFixed(1)}%`}。
${sw ? `**这一年 ${sw.month} 月 ${sw.day} 日换钱**：${sw.say}\n换完之后手里的旧钱按 ${fmtNum(sw.playerRate)} 比 1 折算。` : ''}

【这一年已经有的东西】（这张清单只列会出岔子的东西，不是全部。
米面油盐、黄包车、澡堂子、当铺、戏园子这类日常起居，你按那一年的常识自己写。）
普通人用得上：${t.has.join('、') || '（无）'}
有钱或有门路的才有：${t.hasRare.join('、') || '（无）'}
${t.gone.length ? `刚刚没了的：${t.gone.join('、')}` : ''}

【这一年还没有的东西——写「没有」那一栏就从这里挑】
${t.soon.join('、')}

【这一年赚钱的现实上限】
一个**从一成年收入的本钱起步、没背景没关系**的人，三十天里最多能挣到大约 ${sy.ceiling} 年的中位收入。
这是白手起家的顶，不是这一行做到顶的人能挣多少——两者差得很远。

money 那一栏里每条都要写 ceilingYears：**干满三十天，挣到的钱相当于几年的中位收入**。

先把这笔算术记牢，这一年的数是：
  中位年收入 ${fmtNum(jan.income)} ${CN[jan.currency]}，一个月的口粮就是 ${fmtNum(jan.income / 12)}。
  ceilingYears = 0.08  →  一个月挣 ${fmtNum(jan.income / 12)}（一个普通人的正常月钱）
  ceilingYears = 0.25  →  一个月挣 ${fmtNum(jan.income / 4)}（能干的，三个月的口粮）
  ceilingYears = 1     →  一个月挣 ${fmtNum(jan.income)}（一个月挣够一年）
  ceilingYears = ${sy.ceiling}  →  一个月挣 ${fmtNum(jan.income * sy.ceiling)}（这一年白手起家的顶）
**ceiling 那句话里的数目必须跟这张表对得上，差过一倍就是写错了。**

条数上的要求：
· 每条的 ceilingYears 都要 **大于 0 且不超过 ${sy.ceiling}**
· 至少两条是**卖力气那一档**：ceilingYears 在 0.04 到 0.35 之间
  （干一个月，挣到半个月到四个月的口粮——绝大多数人一辈子就在这一档）
· 最多只有一条可以接近上限 ${sy.ceiling}，而且那一条必须是要命的：抓、赔光、被抢
· 别把大商号、大老板的进项写成一条路子——他一个刚落地的人做不到

【输出这个形状的 JSON，键名一个字都不要改】
{
  "year": ${y},
  "era": "一句话说这一年是什么光景，8 到 40 字",
  "events": [
    { "month": 1, "text": "这个月发生的一件事，一句话说清楚，至少 10 字" }
  ],
  "economy": { "mood": "一句话说经济什么温度", "number": "一个能查的数，比如失业率或者物价涨幅" },
  "prices": [
    { "item": "一斤大米", "price": "0.06 ${curNames[0]}" }
  ],
  "tech": {
    "日常": ["普通人天天在用的东西"],
    "稀罕": ["有钱或有门路才碰得到的"],
    "没有": ["这一年还不存在的东西，从上面那张清单里挑"]
  },
  "money": [
    { "way": "一条真实存在的挣钱路子", "who": "什么样的人干得了这个",
      "ceiling": "干到头大概能挣多少，用当年的钱说",
      "ceilingYears": 这个数折合几年的中位收入，写成数字 }
  ],
  "forbidden": [
    { "what": "这一年干不了的一件事", "why": "为什么干不了——法律不许、技术上没有、还是身份上不可能" }
  ],
  "risks": [
    { "month": 10, "what": "这一年会突然吃掉一个人家底的事", "hit": "撞上了会怎样" }
  ],
  "flavor": "${FLAVOR[0]} 到 ${FLAVOR[1]} 字。玩家挑中这一年，进游戏读到的第一屏。写他睁开眼看到的这座城：街上什么样、什么声音、什么味道、身上有什么、兜里多少钱。第二人称「你」。不要交代历史背景，不要写他要去干什么。"
}

【条数下限，少一条就退回】
events 至少 ${MIN.events} 条，且月份要分散开，不要都堆在同一个月
prices 至少 ${MIN.prices} 条：口粮、副食、房租、交通、一件衣裳、一样奢侈品，都要有
tech.日常 至少 ${MIN.techDaily} 条，tech.稀罕 至少 ${MIN.techRare} 条，tech.没有 至少 ${MIN.techNone} 条
money 至少 ${MIN.money} 条，从卖力气到冒险的都要有，别全是一类
forbidden 至少 ${MIN.forbidden} 条
risks 至少 ${MIN.risks} 条
flavor ${FLAVOR[0]}–${FLAVOR[1]} 字，平均句长不超过 48 字`;
}

function fmtNum(n) {
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  if (n >= 100) return String(Math.round(n));
  return n.toFixed(2);
}

/* ── 跑 ────────────────────────────────────────────── */
async function makeOne(year) {
  const sy = SPINE.years.find(x => x.year === year);
  const out = path.join(DIR, `${year}.json`);
  if (!FORCE && fs.existsSync(out)) {
    const card = JSON.parse(fs.readFileSync(out, 'utf8'));
    if (checkCard(card, sy).length === 0) return { year, status: 'skip' };
  }

  const base = userPrompt(sy);
  let feedback = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const user = base + feedback;
    let text, card;
    try {
      text = await OR.call(MODEL, SYS, user, {
        json: true, maxTokens: 4500, temperature: 0.8,
        cache: (attempt === 1 && !FORCE) ? CACHE : null,
      });
      card = OR.parseJson(text);
    } catch (err) {
      const why = String(err.message).slice(0, 300);
      if (attempt === 3) return { year, status: 'fail', errs: ['三次都没回出能解析的 JSON：' + why] };
      feedback = `\n\n【上一次没写对】${why}\n重写一遍，只输出 JSON。`;
      continue;
    }
    card.year = year;
    const errs = checkCard(card, sy);
    if (errs.length === 0) {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(out, JSON.stringify(card, null, 1));
      return { year, status: attempt === 1 ? 'ok' : `ok(第${attempt}次)` };
    }
    feedback = `\n\n【上一版没过检查，${errs.length} 条毛病，逐条改掉再给我】\n` +
      errs.map(e => '- ' + e).join('\n') +
      `\n\n把整个 JSON 重新输出一遍，别的地方保持原样。`;
    if (attempt === 3) {
      fs.mkdirSync(FAIL, { recursive: true });
      fs.writeFileSync(path.join(FAIL, `${year}.json`), JSON.stringify({ card, errs }, null, 1));
      return { year, status: 'fail', errs };
    }
  }
}

(async () => {
  if (DRY) {
    const sy = SPINE.years.find(x => x.year === YEARS[0]);
    console.log('=== 系统提示词 ===\n' + SYS + '\n\n=== 用户提示词（' + sy.year + '）===\n' + userPrompt(sy));
    return;
  }
  console.log(`模型 ${MODEL}，要做 ${YEARS.length} 年，并发 ${JOBS}`);
  const t0 = Date.now();
  let done = 0;
  const res = await OR.pool(YEARS, JOBS, async y => {
    const r = await makeOne(y);
    done++;
    if (r.status === 'fail') console.log(`  ${y} 三次都没过：${r.errs.slice(0, 3).join(' / ')}`);
    if (done % 10 === 0 || done === YEARS.length) {
      CACHE.flush();
      console.log(`  ${done}/${YEARS.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${OR.report()}`);
    }
    return r;
  });
  CACHE.flush();
  const by = {};
  for (const r of res) by[r.status.replace(/\(.*/, '')] = (by[r.status.replace(/\(.*/, '')] || 0) + 1;
  console.log(`\n完成：${Object.entries(by).map(([k, v]) => `${k} ${v}`).join('，')}`);
  console.log(OR.report());
  const failed = res.filter(r => r.status === 'fail').map(r => r.year);
  if (failed.length) { console.log(`没过的年份：${failed.join(' ')}（半成品在 data/years/_failed/）`); process.exit(1); }
})();
