'use strict';
/* 一天怎么算出来的：拼提示词、调模型、把回来的东西查一遍再落账。
 *
 * 「说人话」在这里分三层落地（第三层在 tools/renhua/）：
 *   一、写进系统提示词——规矩加三句正面范例三句反面范例。范例比形容词管用。
 *   二、本地机械闸——回来的正文过一遍禁用词、句长、跨时代词，不过就带着毛病重来一次。
 *       零延迟零成本，不做实时二次改写（那要多花一倍时间和钱）。
 *   三、离线抽样——tools/renhua/check.js 抽真实生成的正文打分，分掉了回头改第一层。
 */
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

const YEARS_DIR = path.join(__dirname, 'data', 'years');
const cardCache = new Map();
function card(year) {
  if (!cardCache.has(year)) {
    cardCache.set(year, JSON.parse(fs.readFileSync(path.join(YEARS_DIR, `${year}.json`), 'utf8')));
  }
  return cardCache.get(year);
}

/* 每天的演算跟写年卡是两回事，模型也分开挑：
 *   年卡  一辈子只生成一次，慢一点无所谓，谁写得好用谁 → deepseek（见 tools/gen-years.js）
 *   每天  玩家在屏幕前等，一局要调三十次 → 挑快的
 * 量出来的中位耗时：deepseek 16.0 秒（三次里还失败一次）、
 * gemini-3.1-flash-lite 3.3 秒、gemini-2.5-flash-lite 2.6 秒。
 * 2.5-flash-lite 最快但笔调偏套话，取中间那个。 */
const MODEL = process.env.HY_MODEL || 'google/gemini-3.1-flash-lite';

/* 说人话只留一层：规矩和正反范例写进下面的系统提示词。
 * 原来还有两层——回来的正文过一遍禁用词和难读分、不过就原地重写，
 * 外加每天抽 50 条离线打分。sway 定了「实时那些不管」，两层都砍了。
 * 省下来的不只是钱：那道闸实测让 56% 的天数要重跑一次，
 * 砍掉之后一天的演算从 4.6 秒回到 3.3 秒，一局的调用从 39.6 次回到 30 次。
 * 界面上写死的文案照旧离线过一遍（tools/renhua/check.js）。 */

/* ── 提示词 ────────────────────────────────────────── */

const SYS = `你是《这一百年》的记事人。玩家挑了中国近一百年里的某一年某一个月，
落在一座城里过三十天。他每天写一份自己要做的事的清单，你写出这一天真的发生了什么。

【你的位置】
你不是在编故事，你是在按那一年真实的条件算账。
玩家写「去银行贷款开厂」，1962 年就贷不到、也开不了厂——你要写他撞在哪堵墙上，
写得具体：谁跟他说的、原话怎么说、他在哪站了多久。
玩家写得靠谱，就让他挣到钱；写得离谱，就让他碰壁；写得含糊，就让他白跑一趟。
不要因为他写得长就多给钱，也不要因为他没写就替他决定。

【钱】
这是玩家最在乎的事。每一天你都要算清楚今天进了多少出了多少，
数目要跟那一年的物价对得上——资料里给了当年的工钱和物价，照着来。

**他是白手起家的那一个。** 开局本钱只有一成年收入，没有背景，没有关系，
在这座城里谁也不认识。年卡里那些路子写的「做到头约多少」，
说的是**这一行做熟了的人**能挣多少——不是他头一个月就能挣到的。
一个刚落地的人，头几天能摸到边就不错了；能做到那个数的零头，已经是很能干。
别把大商号的进项算到他头上。

**付出去换回东西的钱，不算花掉。** 这条也常漏：
预付的货款、交的押金、屯的货、买的家伙什、盘下的摊位——
钱是出去了，可东西还在他手里。这几笔必须**在 entries 里记出账的同时，
在 assetsAdd 里把换回来的东西记上**，折成当年的钱。
只写「预付货款 −3000」而不写「货架上的货 3000」，等于这三千块凭空蒸发，
他辛苦一个月，账面上却越忙越穷。
真正花掉的只有：吃、住、路费、打点、修理、被罚被抢的。
东西卖出去的时候，再用 assetsDrop 把它划掉，同时把卖的钱记成进账。

**干了一天活，就该有一天的工钱。** 这条常被漏掉：开销你记得清清楚楚
（早饭、车钱、房钱），进账却经常忘了给。
他实打实干了一整天，进账就必须按资料里那条路子的行情记上，
不能只记花出去的。做提成的行当（跑中介、拉客、跑单帮）也一样：
三十天里总得成几单，不能一单不成——真要一单不成，
那是他自己写的清单里没在干正事。
不给钱只能有具体的原因：活儿没了、被赖账、被抓、身子垮了、
或者他今天压根没去干。原因必须写进正文，不能默不作声地不给。
东西也算钱：一辆自行车、三十斤全国粮票、一张调令、一间分到的房，
都要折成当年的钱记进家底。凭空冒出来的钱不算数。

【怎么写】
第二人称，「你」就是玩家。叙述里不出现「我」，人物对话里的「我」不算。
白描，具体。用数目、时辰、器物、身上的伤、谁说了哪一句说话。
不抒情，不替读者下判断，不讲道理，不总结时代意义。

**句子要短。一句话超过三十个字就该打句号了**，别拿逗号一路串下去。
一段里长短句交错着来，全是长句读着累，全是短句像电报。
下面这两句一长一短，就是要的那个节奏：
  「工头坐在板凳上喝茶，听完你的话，上下打量你半晌。他说码头按件计酬。」
别写成这样（一句 55 个字，中间七个逗号）：
  「你没讨到好，又顶着烈日走到码头，扛包的工头正坐在板凳上喝茶，听完你的话，他上下打量你半晌，说码头全是按件计酬，要先入伙还得交一笔押金买钩子和护具。」

照这个感觉写：
  「粮站的人翻了本子，说你这个月的定量领过了。他手指头在本子上按着，没抬头。」
  「布料收了，钱当天没给。老周说月底一起结，你没敢问是哪个月底。」
  「你在码头站到日头偏西，那个拿名册的人始终没叫到你。」
别写成这样：
  「这一天充满了挑战与机遇。」——什么也没说
  「你深刻地感受到了时代的重量。」——替读者下判断
  「你成功地完成了这次交易，获得了可观的收益。」——公文腔，而且没说多少钱

【永远给他一条能走的路 —— 这条跟算账一样要紧】
他今天要是什么也没办成，正文里**必须**留下一条他明天就能走的路：
谁跟他说的、去哪找那个人、要带什么、要多少本钱。
「你的车没报备，接单要扣车」写完，就得接一句「西湖边那个老张说，
去萧山那边的车行租一辆带牌的，一天一百二，押金五百」。
只关门不给路，玩家会连着好几天空手回去，那不是难，那是卡住了。
连着两天什么都没挣到，第三天一定要让他抓住点什么——哪怕是最苦最少的那一档。

【绝对不许】
1. 写这一年还不存在的东西。资料里会点名玩家提到的哪些东西那时候没有，你必须把他顶回去。
2. 出现游戏用语：玩家、数值、加成、触发、解锁、副本、难度、存档、收益率。
3. 用「赋能」「闭环」「底层逻辑」「值得注意的是」「归根结底」这类词。
4. 讲道理、发感慨、总结这一天的意义。写完事情就停。

【输出】
只输出一个 JSON 对象，不要有别的话，不要包在反引号里：
{
  "story": "今天发生了什么，200 到 500 字",
  "entries": [{"what":"这笔钱是什么","amount":进账写正数、出账写负数}],
  "assetsAdd": [{"name":"东西的名字","kind":"实物/票证/权益/债权","worth":折成当年的钱值多少,"note":"一句话"}],
  "assetsDrop": ["卖掉或者丢掉的东西的名字，要跟家底里写的一模一样"],
  "debtsAdd": [{"who":"欠谁的","amount":欠多少,"note":"一句话"}],
  "debtsClear": ["还清了谁的债"],
  "standing": {"名声":变化,"关系":变化,"体力":变化,"麻烦":变化},
  "refused": [{"what":"他想做但做不成的事","why":"为什么做不成，一句话"}],
}

【钱怎么记 —— 这条最要紧】
今天每一笔进出都**单独**写进 entries，一笔一条，能拆多细就拆多细：
挣的那笔、送出去的门包、买烧饼的、喝水的、住店的、路上花的、被人抽的头，
一条都不能少。正文里提到花了钱或收了钱，entries 里就必须有对应的一条。
一天通常有三到六条，只写一条几乎肯定是漏了。
**总账由游戏自己加，你不要算总数，也不要在正文里写他还剩多少钱。**
正文只写今天进了什么出了什么，剩多少是游戏显示的事——
你写的余额跟游戏算的对不上，玩家一眼就看见。
standing 四项都是 −20 到 +20 之间的整数，没变化就写 0。
体力每天自然掉 5 到 15，睡好了才回。麻烦攒到 80 以上要出事。`;

function compactCard(c, sy, month) {
  const evs = (c.events || []).filter(e => Math.abs(e.month - month) <= 1 || e.month === month);
  const pick = evs.length >= 2 ? evs : (c.events || []).slice(0, 4);
  return `【${c.year} 年 · ${sy.city}】${c.era}
经济：${c.economy.mood}（${c.economy.number}）
这段日子的事：${pick.map(e => `${e.month} 月：${e.text}`).join('；')}
物价：${(c.prices || []).map(p => `${p.item} ${p.price}`).join('，')}
日常有的：${(c.tech['日常'] || []).join('、')}
有门路才有的：${(c.tech['稀罕'] || []).join('、')}
这一年没有的：${(c.tech['没有'] || []).join('、')}
挣钱的路子：${(c.money || []).map(m => `${m.way}（${m.who}，做到头约 ${m.ceiling}）`).join('；')}
干不了的事：${(c.forbidden || []).map(f => `${f.what}——${f.why}`).join('；')}
说来就来的祸事：${(c.risks || []).map(r => `${r.what}（${r.hit}）`).join('；')}`;
}

function buildUser(s, list, extra = {}) {
  const c = card(s.year);
  const sy = E.yearOf(s.year);
  const cur = E.currencyAt(s.year, s.month, s.day);
  const hits = E.scanAnachronism(list, s.year);

  const recent = s.days.slice(-3).map(d =>
    `第 ${d.day} 天：${(d.story || '').slice(0, 110)}…（${d.tally || ''}）`).join('\n') || '（今天是头一天）';

  const assets = s.assets.length
    ? s.assets.map(a => `${a.name}（${a.kind}，约值 ${E.money(a.worth, cur)}）`).join('、')
    : '什么都没有';
  const debts = s.debts.length ? s.debts.map(d => `欠${d.who} ${E.money(d.amount, cur)}`).join('、') : '不欠人钱';

  const monthEvents = (c.events || []).filter(e => e.month === s.month);
  const sw = sy.switch;
  /* 换过钱之后的每一天都要再说一遍钱的量级。只在换币当天提醒一次不够——
   * 第二天起模型会顺着前几天的记录接着用旧钱的数目，一天记出上亿来。 */
  const swPast = sw && s.month === sw.month && s.day > sw.day
    ? `\n**这个月 ${sw.day} 日已经换过钱了，现在用的是${E.CN[sw.to]}，不是${E.CN[sw.from]}。**\n` +
      `记账一律用${E.CN[sw.to]}的数目：一个普通人一年挣 ${E.money(E.incomeAtDay(s.year, s.month, s.day), sw.to)}，` +
      `一顿饭、一次车钱都是个位数或者几十。前几天那些${E.CN[sw.from]}的数目不要再照着写。` : '';
  const swToday = sw && s.month === sw.month && s.day === sw.day
    ? `\n**今天就是换钱那天**：${sw.say}\n` +
      `上面「他现在的家底」那个数**已经是折算之后的新钱了**，游戏替他换好了。\n` +
      `所以：正文里要写这件事（他排了多久的队、柜台上怎么说、手里那叠旧钞变成了什么），` +
      `但 **entries 里绝对不许再记一笔「换钱的损失」**——那等于同一笔钱扣两遍。` : '';

  const rulings = hits.length
    ? `\n【他提到的这几样，这一年办不成——必须顶回去，写清楚为什么】\n` +
      hits.map(h => `· 「${h.word}」：${E.sayAnachronism(h)}。${h.note || ''}`).join('\n') +
      `\n把这几条写进 refused 里，正文里也要让他撞上这堵墙。\n` +
      `注意分清楚是哪一种：**根本没有这东西**（他跟人说，对方听不懂），` +
      `还是**有这东西但这几年干这个犯法**（他做得成，可有人管，抓着要出事）。这两种写法完全不一样。`
    : '';

  return `${compactCard(c, sy, s.month)}

【今天】${s.year} 年 ${s.month} 月 ${s.day} 日，第 ${s.day} 天，一共 ${E.DAYS} 天。
${monthEvents.length ? `这个月正在发生：${monthEvents.map(e => e.text).join('；')}` : ''}${swToday}${swPast}

【他现在的家底】
手里的钱：${E.money(s.cash, cur)}（这一年一个普通人一年挣 ${E.money(E.incomeAt(s.year, s.month), cur)}）
东西：${assets}
欠债：${debts}
名声 ${s.standing.名声} · 关系 ${s.standing.关系} · 体力 ${s.standing.体力} · 麻烦 ${s.standing.麻烦}

【前几天】
${recent}

【他今天写的清单】
${String(list).trim()}
${rulings}${extra.retry ? `\n\n【上一版写得不合格，改掉这几条再给我一遍完整的 JSON】\n${extra.retry.map(x => '- ' + x).join('\n')}` : ''}`;
}

/* ── 调模型 ────────────────────────────────────────── */

/** 玩家在等这一天出来，所以有个总预算：默认 55 秒。
 *  只有一种情况会重来——回的东西解析不成 JSON。文风不再拦。 */
async function runDay(s, list, opts = {}) {
  const OR = require('./tools/or.js');
  const budget = opts.budget || 55000;
  const t0 = Date.now();
  const left = () => budget - (Date.now() - t0);
  const user = buildUser(s, list);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = await OR.call(opts.model || MODEL, SYS, user, {
        json: true, maxTokens: 2500, temperature: 0.85,
        timeout: Math.max(8000, Math.min(30000, left())), tries: attempt === 1 ? 2 : 1,
      });
      return { delta: OR.parseJson(text), ms: Date.now() - t0, problems: [] };
    } catch (err) {
      if (attempt === 2 || left() < 12000) throw err;
    }
  }
  throw new Error('这一天没算出来');
}

/* ── 没有密钥时的兜底：本地算一天，能玩完，但正文是模板 ── */
function rng(seed) { let x = seed >>> 0; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

function runDayLocal(s, list) {
  const c = card(s.year);
  const r = rng((s.seed || 1) * 7919 + s.day * 104729);
  const hits = E.scanAnachronism(list, s.year);
  const ways = c.money || [];
  const way = ways[Math.floor(r() * ways.length)] || { way: '打零工', who: '谁都行' };
  /* 必须用 incomeAtDay：incomeAt 拿的是整月记的**新钱**，
   * 而换币前手里是旧钱。1948 年 8 月前 18 天会按金圆券的量级发工钱，
   * 而那时候的年收入是 1.84 亿法币——差三百万倍，等于前半个月白过。 */
  const inc = E.incomeAtDay(s.year, s.month, s.day);

  /* 写得越具体给得越多，但封顶在「一年收入的百分之二」——兜底就是兜底，不该刷分 */
  const effort = Math.min(1, E.countHan(list) / 200);
  const luck = 0.4 + r() * 1.2;
  const gain = hits.length ? -inc / 365 : inc / 365 * effort * luck * 2;

  const story = hits.length
    ? (hits[0].kind === 'banned'
        ? `你把想做的事说给一个熟人听。说到「${hits[0].word}」，他往门口看了一眼，压低声音让你别再提。` +
          `「这两年抓得紧。」他说完就走了。这一天什么也没办成。`
        : `你把想做的事跟街上的人说了一遍。说到「${hits[0].word}」的时候，对方停下来看着你，问那是什么。` +
          `你解释了两句，他摇摇头走了。这一天就这么过去了，什么也没办成。`)
    : `你按写下的去做了。${way.way}这条路，${way.who}。` +
      `跑了大半天，鞋底沾了一层灰。到日头偏西的时候，事情算是有了个着落。`;

  return {
    delta: {
      story,
      entries: [{ what: hits.length ? '白跑一天的开销' : (way.way || '打零工'), amount: Math.round(gain * 100) / 100 }],
      assetsAdd: [], assetsDrop: [], debtsAdd: [], debtsClear: [],
      standing: { 名声: hits.length ? 0 : 1, 关系: 0, 体力: -(6 + Math.floor(r() * 8)), 麻烦: hits.length ? 1 : 0 },
      refused: hits.map(h => ({ what: h.word, why: E.sayAnachronism(h) })),
    },
    local: true, problems: [],
  };
}

module.exports = { runDay, runDayLocal, buildUser, card, SYS, MODEL };
