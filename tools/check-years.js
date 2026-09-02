'use strict';
/* 年卡硬闸。node tools/check-years.js [--year 1930] [--quiet]
 *
 * 这份闸门就是给模型的契约：生成年卡的提示词里原样附上它的规则，
 * 生成完立刻跑一遍，不过就重生成。退出码非 0 表示有年卡不合格。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'years');
const SPINE = require(path.join(ROOT, 'data', 'spine.json'));
const TL = require(path.join(ROOT, 'data', 'tech-timeline.json'));

const CN = { SILVER: '银元', FABI: '法币', GOLDYUAN: '金圆券', RMB1: '旧人民币', RMB: '人民币' };
/* 界面上钱怎么写：银元论「块」，其余论「元」 */
const UNIT = {
  SILVER: ['银元', '大洋', '块', '元', '角', '分'],
  FABI: ['法币', '元', '角', '分'],
  GOLDYUAN: ['金圆券', '金元券', '元', '角', '分'],
  RMB1: ['人民币', '旧人民币', '元', '万元'],
  RMB: ['人民币', '元', '块', '角', '分'],
};

/** 从「一个月最多挣18银元」这类话里抠出「一个月多少钱」。
 *  抠不出来就返回 null——宁可不判，也别判错。 */
function monthlyFromText(txt) {
  const t = String(txt || '');
  const nums = [...t.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*(万|亿)?\s*(银元|大洋|法币|金圆券|人民币|元|块)/g)]
    .map(m => Number(m[1]) * (m[2] === '万' ? 1e4 : m[2] === '亿' ? 1e8 : 1));
  if (!nums.length) return null;
  const v = Math.max(...nums);
  if (/一个月|每个月|每月|月[入收挣赚净]|一月/.test(t)) return v;
  if (/一天|每天|日[入挣赚]|一日/.test(t)) return v * 30;
  return null;                       // 「一趟」「一单」这类算不出频次，不判
}

/* 每个字段的下限。放这里，提示词直接读它拼进去，两边不会走散。 */
const MIN = { events: 3, prices: 6, money: 5, forbidden: 3, risks: 2, techDaily: 3, techRare: 2, techNone: 3, sources: 4 };
/* 每张卡必须给出处的字段。sway 定了「查资料写死」，模型不许自己编数。 */
const MUST_CITE = ['prices', 'money', 'events'];
const FLAVOR = [150, 360];

/* 说人话：这些词一出现就退回 */
const SLOP = /(赋能|抓手|闭环|打法|生态位|底层逻辑|方法论|价值观|颗粒度|拉通|复盘|沉淀|心智|护城河|降维|风口|红利期|值得注意的是|综上所述|归根结底|不可否认|在某种意义上|某种程度上|不是[^，。；]{1,14}，而是)/;
/* 现代游戏腔，年卡里不该有 */
const GAMEY = /(玩家|游戏机制|数值|加成|触发条件|解锁|副本|难度系数|新手引导|存档)/;

const SHOW = !process.argv.includes('--quiet');
const ONLY = (() => { const i = process.argv.indexOf('--year'); return i >= 0 ? Number(process.argv[i + 1]) : null; })();

/* 关键词表和判定一律走 engine，两处各写一份必然走散 */
const ENG = require(path.join(ROOT, 'engine.js'));
const anachronisms = ENG.scanAnachronism;
const KEYS = [];
for (const it of TL.items) for (const k of [it.name, ...it.aliases]) KEYS.push({ k, item: it });
KEYS.sort((a, b) => b.k.length - a.k.length);

/** 这一年这东西到底有没有（认 gaps 那几年被禁的情形） */
function available(item, y) {
  if (item.from > y) return false;
  if (item.until && y > item.until + 1) return false;
  if ((item.gaps || []).some(g => y >= g[0] && y <= g[1])) return false;
  return true;
}

function checkCard(card, spineYear) {
  const e = [];
  const y = card.year;
  const bad = m => e.push(m);

  if (y !== spineYear.year) bad(`year 字段 ${y} 跟文件名对不上`);
  if (!card.era || card.era.length < 8 || card.era.length > 40) bad(`era 要 8–40 字，现在 ${card.era ? card.era.length : 0} 字`);

  if (!Array.isArray(card.events) || card.events.length < MIN.events) {
    bad(`events 至少 ${MIN.events} 条，现在 ${card.events ? card.events.length : 0} 条`);
  } else for (const [i, ev] of card.events.entries()) {
    if (!(ev.month >= 1 && ev.month <= 12)) bad(`events[${i}] 的 month 不在 1–12：${ev.month}`);
    if (!ev.text || ev.text.length < 10) bad(`events[${i}] 太短`);
  }

  if (!card.economy || !card.economy.mood || !card.economy.number) bad('economy 要有 mood 和 number 两项');

  const cur = spineYear.currencies;
  const ok = cur.flatMap(c => UNIT[c]);
  if (!Array.isArray(card.prices) || card.prices.length < MIN.prices) {
    bad(`prices 至少 ${MIN.prices} 条，现在 ${card.prices ? card.prices.length : 0} 条`);
  } else for (const [i, p] of card.prices.entries()) {
    if (!p.item || !p.price) { bad(`prices[${i}] 缺 item 或 price`); continue; }
    if (!ok.some(u => String(p.price).includes(u))) {
      bad(`prices[${i}]「${p.item} ${p.price}」没用当年的钱（当年是 ${cur.map(c => CN[c]).join(' / ')}）`);
    }
  }

  const t = card.tech || {};
  if (!Array.isArray(t['日常']) || t['日常'].length < MIN.techDaily) bad(`tech.日常 至少 ${MIN.techDaily} 条`);
  if (!Array.isArray(t['稀罕']) || t['稀罕'].length < MIN.techRare) bad(`tech.稀罕 至少 ${MIN.techRare} 条`);
  if (!Array.isArray(t['没有']) || t['没有'].length < MIN.techNone) bad(`tech.没有 至少 ${MIN.techNone} 条`);

  /* 这张表是安全网，不是万物清单——模型会写出表里根本没有的东西（5G、AGI）。
   * 所以只对**认得出的**条目下判断：某个关键词要占掉这一条大半的字，才算认出来了；
   * 只沾上一两个字（「5G网络」只命中「网络」）就当没认出来，放过去。
   * 认错了会挡住本来对的内容，比漏掉一条更糟。 */
  const han = x => (String(x).match(/[一-鿿A-Za-z0-9]/g) || []).length;
  for (const s of (t['没有'] || [])) {
    const hits = KEYS.filter(x => s.includes(x.k));
    /* 有一个占掉大半字数的关键词，才算「认出来了，可以下判断」。 */
    if (!hits.some(x => han(x.k) >= han(s) * 0.4)) continue;
    /* 但下判断的时候，沾上的每一个关键词都算数：
     * 「商品房按揭贷款」里商品房 1989 年有，按揭要到 1992 年——
     * 只要有一样这一年没有，这条就写对了。 */
    if (hits.every(h => available(h.item, y))) {
      bad(`tech.没有 写了「${s}」，可 ${[...new Set(hits.map(h => h.item.name))].join('、')} 这一年都是有的`);
    }
  }
  for (const tier of ['日常', '稀罕']) for (const s of (t[tier] || [])) {
    /* 反过来：说「有」的东西，只要里面有一个关键词这一年确实没有，就是错的。
     * 取最长的那个来报错，报「App」不如报「短视频」说得清。 */
    const all = KEYS.filter(x => s.includes(x.k) && han(x.k) >= han(s) * 0.4);
    const hit = all.find(x => !available(x.item, y)) || null;
    if (hit) {
      const why = ENG.sayAnachronism(ENG.scanAnachronism(hit.k, y)[0] || { kind: 'early', from: hit.item.from });
      bad(`tech.${tier} 写了「${s}」，可 ${hit.item.name} ${why}`);
    }
  }

  if (!Array.isArray(card.money) || card.money.length < MIN.money) bad(`money 至少 ${MIN.money} 条`);
  else {
    const ceil = spineYear.ceiling;
    let wage = 0, near = 0;
    for (const [i, m] of card.money.entries()) {
      if (!m.way || !m.who || !m.ceiling) { bad(`money[${i}] 要有 way / who / ceiling 三项`); continue; }
      const cy = Number(m.ceilingYears);
      if (!(cy > 0)) { bad(`money[${i}]「${m.way}」缺 ceilingYears（这条路做到头折合几年的中位收入）`); continue; }
      if (cy > ceil) bad(`money[${i}]「${m.way}」写成 ${cy} 年，超过这一年白手起家的顶 ${ceil} 年`);
      /* 卖力气那一档：干满一个月，挣到的差不多就是一个月的口粮。
       * 一个月 = 年收入的 1/12 ≈ 0.083 年，宽到 0.04–0.35 年（约半个月到四个月的口粮）。
       * 原来写的是 0.3–1.5 年，那是「一个月挣到三年半到十八个月的收入」——
       * 单位想错了一位，band 整个偏了一个数量级。 */
      if (cy >= 0.04 && cy <= 0.35) wage++;
      if (cy > ceil * 0.6) near++;

      /* 数字跟那句话要对得上。ceilingYears=4.8、年收入 166 银元，
       * 那句话就该写「一个月八百银元」左右；写成「一个月 120 银元」就是差了十倍，
       * 玩家读到的和模型读到的不是一回事。容差 2.5 倍——
       * 「除去车租净落」这类说法本来就有出入。 */
      const monthly = monthlyFromText(m.ceiling);
      if (monthly !== null) {
        const want = cy * spineYear.months[0].income;
        const off = monthly / want;
        if (off > 2.5 || off < 1 / 2.5) {
          bad(`money[${i}]「${m.way}」写着 ceilingYears ${cy} 年（该是一个月约 ${want.toPrecision(3)}），` +
            `可那句话说的是一个月 ${monthly.toPrecision(3)}，差 ${off > 1 ? off.toFixed(1) + ' 倍' : (1 / off).toFixed(1) + ' 倍'}`);
        }
      }
    }
    /* 一条卖力气的路都没有的话，玩家开局就无处下手 */
    if (wage < 2) bad(`money 里卖力气那一档（ceilingYears 在 0.04–0.35 之间，也就是一个月挣到半个月到四个月的口粮）只有 ${wage} 条，至少要 2 条`);
    /* 好几条都贴着上限，等于这一年遍地黄金 */
    if (near > 1) bad(`money 里有 ${near} 条贴着上限（超过 ${(ceil * 0.6).toFixed(1)} 年），最多只许 1 条`);
  }
  if (!Array.isArray(card.forbidden) || card.forbidden.length < MIN.forbidden) bad(`forbidden 至少 ${MIN.forbidden} 条`);
  else for (const [i, f] of card.forbidden.entries()) if (!f.what || !f.why) bad(`forbidden[${i}] 要有 what 和 why`);
  if (!Array.isArray(card.risks) || card.risks.length < MIN.risks) bad(`risks 至少 ${MIN.risks} 条`);
  else for (const [i, r] of card.risks.entries()) if (!r.what || !r.hit) bad(`risks[${i}] 要有 what 和 hit`);

  /* ── 出处 ──────────────────────────────────────────
   * 这一条是 sway 定的：背景卡全部查资料写死，每张卡带上出处。
   * 闸门只能查「有没有、够不够具体、能不能回溯」，查不了「是不是真的」——
   * 真伪靠抽查 URL 和人读，见 tools/check-sources.js。 */
  const src = card.sources;
  if (!Array.isArray(src) || src.length < MIN.sources) {
    bad(`sources 至少 ${MIN.sources} 条，现在 ${Array.isArray(src) ? src.length : 0} 条`);
  } else {
    const covered = new Set();
    let withUrl = 0;
    for (const [i, o] of src.entries()) {
      if (!o || !o.for || !o.cite) { bad(`sources[${i}] 要有 for 和 cite`); continue; }
      if (String(o.cite).length < 8) bad(`sources[${i}] 的 cite「${o.cite}」太短，看不出是哪份材料`);
      covered.add(o.for);
      if (o.url && /^https?:\/\//.test(o.url)) withUrl++;
    }
    for (const f of MUST_CITE) if (!covered.has(f)) bad(`sources 里没有 for="${f}" 的那一条——这一栏的数必须有出处`);
    if (withUrl < 2) bad(`sources 里带 url 的只有 ${withUrl} 条，至少 2 条要能点开回溯`);
  }
  if (!card.confidence) bad('缺 confidence：这张卡的数有多牢（实测 / 估算 / 存疑）');

  const fl = card.flavor || '';
  if (fl.length < FLAVOR[0] || fl.length > FLAVOR[1]) bad(`flavor 要 ${FLAVOR[0]}–${FLAVOR[1]} 字，现在 ${fl.length} 字`);

  /* 全卡文本：超前和过期的东西。tech.没有 和 forbidden 里正是要说它不存在，豁免。 */
  const exemptArr = [...(t['没有'] || []), ...(card.forbidden || []).map(f => `${f.what}${f.why}`)];
  const exempt = exemptArr.join('');
  const scan = JSON.stringify({
    era: card.era, events: card.events, economy: card.economy, prices: card.prices,
    tech: { 日常: t['日常'], 稀罕: t['稀罕'] }, money: card.money, risks: card.risks, flavor: fl,
  });
  /* 「生病了没有抗生素，只能硬扛」是好句子，不该被当成穿越。
   * 词前面几个字里有否定词的，一律放过——说它没有，正是我要的。 */
  const negated = (text, word) => {
    let i = -1;
    while ((i = text.indexOf(word, i + 1)) >= 0) {
      const before = text.slice(Math.max(0, i - 8), i);
      if (!/(没有|没得|不存在|还没|尚无|缺|买不到|用不上|见不着|无|不许|禁)/.test(before)) return false;
    }
    return true;                       // 每一处出现都带着否定
  };
  for (const h of anachronisms(scan, y)) {
    if (exempt.includes(h.word)) continue;
    if (negated(scan, h.word)) continue;
    bad(`正文里出现「${h.word}」——${ENG.sayAnachronism(h)}`);
  }

  const prose = [card.era, fl, ...(card.events || []).map(x => x.text)].join('\n');
  const s1 = prose.match(SLOP); if (s1) bad(`说人话闸：出现「${s1[0]}」`);
  const s2 = JSON.stringify(card).match(GAMEY); if (s2) bad(`年卡里不该有游戏腔：「${s2[0]}」`);
  /* 开场白里不许报兜里有多少钱。开局本钱是引擎按当年收入算的，
   * 界面上就贴在这段字的上头——两个数对不上，玩家第一眼就看见。
   * 上一版一百张里四十五张犯了这个错，最离谱的差一千二百倍。 */
  const WALLET = /(兜里|身上|手里|口袋里|怀里|棉袄里|钱包里)[^。，；]{0,10}?[0-9〇零一两二三四五六七八九十百千万]+\s*(块|元|角|分|银元|大洋|法币|金圆券|人民币|万)/;
  const w = fl.match(WALLET);
  if (w) bad(`flavor 里报了兜里有多少钱（「${w[0]}」）——开局本钱由引擎算，界面上就贴在这段字上头，两个数必然对不上`);

  const sents = fl.split(/[。！？；]/).filter(x => x.trim().length);
  const avg = sents.length ? sents.reduce((a, b) => a + b.length, 0) / sents.length : 0;
  if (avg > 48) bad(`flavor 平均句长 ${avg.toFixed(0)} 字，太长（上限 48）`);

  return e;
}

module.exports = { checkCard, anachronisms, MIN, FLAVOR, CN, UNIT, KEYS };

if (require.main === module) {
  if (!fs.existsSync(DIR)) { console.error(`没有 ${path.relative(process.cwd(), DIR)}，先跑 tools/gen-years.js`); process.exit(2); }

  let nCards = 0, nBad = 0;
  const missing = [];
  const lines = [];
  for (const sy of SPINE.years) {
    if (ONLY && sy.year !== ONLY) continue;
    const f = path.join(DIR, `${sy.year}.json`);
    if (!fs.existsSync(f)) { missing.push(sy.year); continue; }
    let card;
    try { card = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (err) { nBad++; lines.push(`${sy.year}  JSON 读不了：${err.message}`); continue; }
    nCards++;
    const errs = checkCard(card, sy);
    if (errs.length) {
      nBad++;
      lines.push(`${sy.year}  ${errs.length} 条`);
      for (const x of errs) lines.push(`      x ${x}`);
    }
  }

  if (SHOW) {
    console.log(`年卡 ${nCards} 张` + (missing.length
      ? `，缺 ${missing.length} 张：${missing.slice(0, 12).join(' ')}${missing.length > 12 ? ' …' : ''}`
      : '，一张不缺'));
    if (lines.length) { console.log(''); for (const l of lines) console.log(l); }
  }
  if (missing.length || nBad) {
    if (SHOW) console.log(`\n没过：${nBad} 张有问题，${missing.length} 张还没生成`);
    process.exit(1);
  }
  if (SHOW) console.log('\n全过');
}
