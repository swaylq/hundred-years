'use strict';
/* 《这一百年》的算账部分。纯函数，不碰网络也不碰数据库，好验。
 *
 * 一局＝从某年某月起，一个月一步，走二十四个月，横跨两年。
 * 开局挑哪一个月很重要：1929 年 10 月、1948 年 8 月、1966 年 5 月、1992 年 1 月、
 * 2008 年 9 月，跨进去的是完全不同的两年。
 *
 * 分数 = 收工那个月的家底 ÷ 那个月的中位年收入 − 开局那个月的家底 ÷ 开局那个月的中位年收入
 * 读出来就是「两年里多攒下几年的收入」。两头各自除以当月的年收入，
 * 得到的是不带单位的数，所以跨年、跨币制（1935 法币、1948 金圆券、1949 和 1955 人民币）都比得了。
 */
const path = require('path');
const SPINE = require(path.join(__dirname, 'data', 'spine.json'));
const TL = require(path.join(__dirname, 'data', 'tech-timeline.json'));
const WORLD = require(path.join(__dirname, 'data', 'world.json'));

const DAYS = 30;                 // 一个月按三十天算，只在月内物价插值时用得着
const MONTHS = 24;               // 两年正传走二十四个月
const MONTHS_FAST = 12;          // 一年快局走十二个月
const MONTHS_EXTRA = 60;         // 走完之后，最多还能再往下走五年（后传）
const LIST_LIMIT = 500;          // 一个月的清单，汉字上限
const WISH_LIMIT = 30;           // 开局心愿，汉字上限
const CN = { SILVER: '银元', FABI: '法币', GOLDYUAN: '金圆券', RMB1: '人民币（旧）', RMB: '人民币' };

const yearOf = y => SPINE.years.find(x => x.year === y);

/* ── 关键词表，运行时判「这一年有没有这东西」用的也是它 ─────
 * 中文里「摆摊」平常写成「摆个摊」「摆了摊」，动词和宾语中间爱塞一个字。
 * 两个字的动宾词一律多生成这几种写法，不然 1968 年「摆个摊」就漏过去了。 */
const INSERTS = ['个', '了', '一个', '了个', '过'];
const KEYS = [];
for (const it of TL.items) {
  for (const k of [it.name, ...it.aliases]) {
    KEYS.push({ k, item: it });
    if (k.length === 2 && /^[一-鿿]{2}$/.test(k)) {
      for (const ins of INSERTS) KEYS.push({ k: k[0] + ins + k[1], item: it });
    }
  }
}
KEYS.sort((a, b) => b.k.length - a.k.length);

/** 扫一句话里有没有这一年还不存在、或者已经没了的东西。
 *  这是把玩家顶回去的依据——不指望模型自己想起来。 */
function scanAnachronism(text, year) {
  const out = [];
  let seen = String(text || '');
  for (const { k, item } of KEYS) {
    if (!seen.includes(k)) continue;
    seen = seen.split(k).join('　'.repeat(k.length));
    if (item.from > year) {
      out.push({ word: k, name: item.name, kind: 'early', from: item.from, note: item.note || '' });
      continue;
    }
    /* 退场判定放宽一年：换钱、废票证都有个收尾期，
     * 1936 年提银元、1994 年提粮票都是当时真在发生的事，不该报错。 */
    if (item.until && year > item.until + 1) {
      out.push({ word: k, name: item.name, kind: 'gone', until: item.until, note: item.note || '' });
      continue;
    }
    /* 本来有、这几年被禁掉了——不是「没这东西」，是「干这个犯法」 */
    const gap = (item.gaps || []).find(g => year >= g[0] && year <= g[1]);
    if (gap) out.push({ word: k, name: item.name, kind: 'banned', ban: gap, note: item.note || '' });
  }
  return out;
}

/** 把一条判定写成一句人话。三种情形的说法完全不同：
 *  还没有 / 已经没了 / 本来有但这几年干这个犯法。 */
function sayAnachronism(h) {
  if (h.kind === 'early') return `${h.from} 年才有`;
  if (h.kind === 'gone') return `${h.until} 年以后就没有了`;
  return `${h.ban[0]} 到 ${h.ban[1]} 年之间干这个犯法`;
}

/* ── 时间与钱 ──────────────────────────────────────── */

/** 这一年这个月这一天，手里是什么钱 */
function currencyAt(year, month, day) {
  const Y = yearOf(year);
  const sw = Y.switch;
  if (sw) {
    /* spine 是按月记的，换币那个月整月都记成新钱；这里要按天分开：
     * 8 月 19 日之前手里还是法币，那天起才是金圆券。 */
    if (month > sw.month || (month === sw.month && day >= sw.day)) return sw.to;
    if (month === sw.month) return sw.from;
  }
  return Y.months[month - 1].currency;
}

/** 月内的物价：这个月 1 号到下个月 1 号之间按几何插值。
 *  12 月没有下个月，就沿用 11→12 那一档的涨幅。 */
function priceAt(year, month, day) {
  const Y = yearOf(year);
  const a = Y.months[month - 1].priceIdx;
  const b = month < 12
    ? Y.months[month].priceIdx
    : a * (Y.months[11].priceIdx / Y.months[10].priceIdx);
  return a * Math.pow(b / a, (day - 1) / DAYS);
}

/** 这一天的 1 块钱，值这一年 1 月的多少块（买得到的东西算）。
 *  换币和通胀都折进这一个数里。 */
function worthAt(year, month, day) {
  const Y = yearOf(year);
  const sw = Y.switch;
  const after = sw && (month > sw.month || (month === sw.month && day >= sw.day));
  return (after ? sw.rate : 1) / priceAt(year, month, day);
}

/** 这个月的年化中位收入，用这个月的钱计。
 *  注意换币那个月：spine 整月记的是新钱，所以 1948 年 8 月这一栏是金圆券。 */
function incomeAt(year, month) { return yearOf(year).months[month - 1].income; }

/** 这一天的年化中位收入，用**这一天手里那种钱**计。
 *  换币当月，19 号之前手里还是法币，收入也得换算成法币来说，
 *  不然分子分母两种钱，算出来的分数会大好几个数量级。 */
function incomeAtDay(year, month, day) {
  const Y = yearOf(year);
  const sw = Y.switch;
  const base = Y.months[month - 1].income;
  if (sw && month === sw.month && day < sw.day) return base * sw.rate;   // 折回旧钱
  return base;
}

/* ── 按月算的那一套 ────────────────────────────────
 * 一局是二十四个月，不再是三十天。月内的天数只在物价插值里还用得着。
 *
 * **换币算在那个月的月底**：整个 1948 年 8 月都按法币过（早上买得起两个烧饼、
 * 下午买不起的就是这个月），月底结账那一下才折成金圆券。
 * 这么定有两条理由：走进八月的人和从八月开局的人经历一样；
 * 而「那一下」正是这个游戏最想让人经历的东西——月初就折完，从八月开局的人
 * 什么也遇不上，可年份格子上那颗蓝点偏偏就在邀请他从那儿开局。
 *
 * 所以三个按月的口子一律取那个月 **1 号**的视角：换币的月份拿到的是旧钱的
 * 币种、旧钱的年收入、旧钱的购买力。spine 整月记的是新钱，别直接拿。
 * 一局最后一个月要是撞上换币，收工前由 closeOut 补折一次，谁也躲不掉。 */
const currencyOf = (year, month) => currencyAt(year, month, 1);
const incomeOf = (year, month) => incomeAtDay(year, month, 1);
const worthOf = (year, month) => worthAt(year, month, 1);

/** 下一个月是几年几月 */
function nextMonth(year, month) { return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }; }

/** 从这个月开局，这一局走得完吗——年卡只写到 2025 年 12 月，
 *  24 月正传最晚从 2024 年 1 月起步，12 月快局最晚从 2025 年 1 月起步。 */
function startable(year, month, totalMonths = MONTHS) {
  const span = Number(totalMonths) === MONTHS_FAST ? MONTHS_FAST : MONTHS;
  const last = SPINE.years[SPINE.years.length - 1];
  return (year * 12 + month - 1) + (span - 1) <= last.year * 12 + 11;
}

/** 一张账单上只许有一个单位。
 *  原先每一笔各挑各的，于是同一个月的账里「−1800 法币」「−80.00 法币」
 *  「1.54 亿法币」三种写法排在一起，读的人得先在心里换算才知道哪笔大。
 *  单位由这一组数里最大的那个定，整组一起用它。 */
const UNITS = [
  { min: 1e12, div: 1e12, name: '万亿' },
  { min: 1e8, div: 1e8, name: '亿' },
  { min: 1e4, div: 1e4, name: '万' },
  { min: 0, div: 1, name: '' },
];
/** 小数位也是单位的一部分，一起由最大那个数定。
 *  少了这一句，同一张账单上会并排出现「1800 法币」和「80.00 法币」——
 *  单位是一样的，写法还是两种。 */
function unitOf(nums) {
  const big = Math.max(0, ...[].concat(nums).map(n => Math.abs(Number(n)) || 0));
  const u = UNITS.find(x => big >= x.min);
  return { ...u, dp: u.div > 1 || big < 100 ? 2 : 0 };
}

/** 按指定的单位写一个数。 */
function moneyIn(n, unit, cur) {
  return `${(n / unit.div).toFixed(unit.dp)} ${unit.name}${CN[cur] || '元'}`;
}

/** 界面上把钱写成人看得懂的样子。单独一个数，自己定单位。 */
function money(n, cur) { return moneyIn(n, unitOf(n), cur); }

/* ── 开局 ──────────────────────────────────────────── */

/** 开局本钱：那个月中位年收入的十分之一。
 *  按比例给，所以 1962 年和 2015 年的起跑线是一样的。
 *  **必须走 incomeOf（按月）**：incomeAtDay 拿的是那个月 1 号的钱，
 *  换币的月份 1 号还是旧钱，1948 年 8 月开局会发一亿八千万法币、却标成金圆券，
 *  一开局就是三十万年的收入。 */
function startingCash(year, month) { return incomeOf(year, month) / 10; }

function newRun({ year, month, nick, seed, persona, wish, targetMonths, scenarioId }) {
  const Y = yearOf(year);
  const cur = currencyOf(year, month);
  const cash = startingCash(year, month);
  const span = Number(targetMonths) === MONTHS_FAST ? MONTHS_FAST : MONTHS;
  return {
    /* year/month 是**现在走到哪个月**，每过一个月往前挪一格；
     * 开局那个月单独记在 startYear/startMonth，结算和榜都认它。 */
    year, month,
    startYear: year, startMonth: month,
    targetMonths: span,                     // 24（两年正传）或 12（一年快局）
    n: 1,                                   // 第几个月，1..targetMonths
    nick: nick || '无名',
    seed: seed || Math.floor(Math.random() * 1e9),
    /* 城市按开局那一年定，之后不再变。年卡是一年一座城写的，
     * 一局跨到下一年可能撞上另一座城——那时照用那一年的物价与时局，
     * 但人还在原地，不会莫名其妙搬家。 */
    city: Y.city,
    currency: cur,
    cash,
    assets: [],
    debts: [],
    /* **屏幕上只有钱这一个数。** 名声/关系/体力/麻烦四条杠 09-03 撤过、当晚加回、
     * 09-04 又撤——最后定在这儿，别再来回改了。sway 的话：
     * 「移除名声，关系，麻烦，只保留金钱一个数值。……主角的武力值聪明值都是默默积累的。」
     * 身手、脑子、摊子多大、手底下多少人，全在 memo.traits 的文字里攒着，
     * 照样决定他做得成什么，只是不摆成一根槽——那些东西本来也不该有上限。 */
    /* 这一局的记忆。每过一个月，模型把刚发生的事压成几行短的，
     * 由 applyMemo 并进来；**引擎只添不删**，压缩发生在往提示词里渲染那一步。
     * 少了它，模型只看得见最近两个月的正文，第三个月起认识的人和谈了一半的买卖就没了。 */
    memo: newMemo(),
    /* 玩家自己写的一句话：他是个什么人。整局不变，每个月都拼进提示词。
     * 除了钱，这一局再没有别的槽——名声、关系、体力、麻烦四条杠 2026-09-02 撤了，
     * 它们的作用改由钱和正文里的事承担（罚款、货被没收、被关几天挣不到钱）。 */
    persona: checkPersona(persona).text || '',
    wish: checkWish(wish).text || '',
    scenarioId: scenarioId ? String(scenarioId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) : '',
    lastAssetMoves: [],
    startWorth: netWorth({ cash, assets: [], debts: [] }),
    startIncome: incomeOf(year, month),
    months: [],
    status: 'playing',
  };
}

/* ── 家底 ──────────────────────────────────────────── */

/** 家底 = 现金 + 实物 + 票证 + 权益 − 欠债。
 *  票证和权益也算钱——1962 年不把它们算进来，那一年就没有「赚」这回事了。 */
function netWorth(s) {
  const a = (s.assets || []).reduce((t, x) => t + (Number(x.worth) || 0), 0);
  const d = (s.debts || []).reduce((t, x) => t + (Number(x.amount) || 0), 0);
  return (Number(s.cash) || 0) + a - d;
}

/** 一个月做到头大概能挣多少：年卡上那个「三十天做到头」的数，本来就是按一个月定的。
 *
 *  **这是一把尺子，不是一道闸。** 2026-09-03 sway 说「不要有上限」，
 *  削顶那一段（超出的部分不进家底）连同整局封顶一起撤了。留着这个数是因为
 *  三处要一个「这一年大概能到哪儿」的参照：提示词里给模型的量级、奇遇给多少、
 *  兜底那份押注押多大。玩家真写出了超过它的一个月，一分不少照记。
 *
 *  **必须按当月那种钱算**。原来固定用开局那个月的，1948 年 8 月换币之后
 *  它还留在法币的量级（三百万倍），模型接着用法币的数目记账，
 *  一局打出「赚了二十七万年的收入」。 */
function monthTop(year, month) {
  return yearOf(year).ceiling * incomeOf(year, month);
}

/* ── 换币 ────────────────────────────────────────────
 * 两种东西换的比价不一样，这正是这几天的全部内容：
 *
 *   现金、借条、存款 → 按当时公布的收兑价（playerRate）。1949 年 5 月是十万比一，
 *                      等于把攥着金圆券的人清零——历史上就是这么回事。
 *   实物、票证、权益 → 按购买力的比价（rate）。一袋米还是那一袋米，
 *                      变的只是标价的单位。攒东西的人躲过这一刀。
 *
 * 原来实物那一档根本没换，1948 年 8 月囤了货的玩家，
 * 账面上就顶着一亿七千万「金圆券」的米走完了后半个月。 */
/** 走完这个月的时候要不要换钱。
 *  换币那天在月中（1935-11-04、1948-08-19、1949-05-27），这个月整月按旧钱过，
 *  月底那一下才折——「早上买得起两个烧饼、下午买不起」的就是这个月。 */
function switchDueAfter(year, month) {
  const sw = yearOf(year).switch;
  return sw && sw.month === month && sw.day > 1 ? sw : null;
}

/** 走进这个月的时候就要换钱：换币那天正好是 1 号（1955-03-01），
 *  这个月一天都没有旧钱可用，spine 整月记的也是新钱，只能进门就折。 */
function switchOnEntry(year, month) {
  const sw = yearOf(year).switch;
  return sw && sw.month === month && sw.day <= 1 ? sw : null;
}

/** 走过一个月：把实物按新一个月的行情重新标价。
 *
 *  **实物的名义价钱必须跟着钱的贬值走。** 一石米还是那一石米，可它的标价
 *  1948 年 6 月是一千万法币、8 月是五千八百万。原来只在换币那一下折一次，
 *  中间的月份纹丝不动——于是 1947 年买米囤两年，账面上跟攥着现金一样惨，
 *  而囤货躲通胀本来就是那两年最要紧的一手。
 *
 *  **换算系数用「中位年收入」之比，不用物价指数。** 物价指数每年 1 月都重置成 1，
 *  只在一年之内可比；一局跨两三个日历年，拿它跨年一除就会算出「米涨了三千七百万倍」
 *  （真跑出来过：1947 年 6 月囤的米，到 1949 年 5 月值 75 年的收入）。
 *  中位收入是这份数据里唯一一条跨年连续的名义序列（build-spine 专门校验过
 *  1 月接不接得上 12 月），换币那一下它自己也断档，所以拿它当尺子最省事，
 *  实物也不用再为换币单独折一次。
 *
 *  这么定的代价说清楚：**实物保的是「相当于几个月工钱」那份价值**。
 *  1948 年物价跑得比工钱快六倍，真实世界里囤货的人是赚的，这里只做到不亏。
 *  相对攥现金（1949 年被十万比一收走）的差距照旧巨大，那一手仍旧成立。
 *
 *  现金、债权、欠债不跟着走：它们的名义数目本来就是死的，
 *  真实价值缩水由「除以当月年收入」那一步自然体现。 */
/* 只有明确属于金融、房产、贵金属或虚拟货币的投资型家当才叠加历史行情涨跌；
 * 日常存货（米、布、杂货、工具、票证）仍严格按中位收入保值，守住换币与保值底线。 */
const ASSET_VENUES = [
  ['币', /(比特币|虚拟货币|数字货币|以太坊|以太币|加密币)/],
  ['房', /(房子|房产|商品房|商铺|铺面|四合院|洋房|公寓|住宅|地皮|宅基地|楼盘|写字楼|仓库产权)/],
  ['股', /(股票|股份|股权|基金|公债|国债|认购证|期货|证券|标金)/],
  ['金', /(黄金|金条|赤金|小黄鱼|大黄鱼|金块|金饰|美钞|美元|外汇|英镑|港币|银元|大洋|袁大头|银锭)/],
];
const ASSET_VENUE_DRIFT = {
  '币': { up: 0.08, down: -0.07, jit: 0.022 },
  '股': { up: 0.065, down: -0.055, jit: 0.018 },
  '金': { up: 0.036, down: -0.028, jit: 0.01 },
  '房': { up: 0.028, down: -0.02, jit: 0.008 },
};

function assetVenueOf(name, kind, note) {
  if (kind === '债权' || kind === '现金类' || kind === '票证') return null;
  const txt = `${String(name || '')} ${String(note || '')}`;
  for (const [v, re] of ASSET_VENUES) if (re.test(txt)) return v;
  return null;
}

function hashStr(s) {
  let h = 2166136261 >>> 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function reprice(s, from, to) {
  if (s && typeof s === 'object') s.lastAssetMoves = [];
  const k = incomeOf(to.year, to.month) / incomeOf(from.year, from.month);
  if (!isFinite(k) || k <= 0) return;
  const isSwitch = !!(switchDueAfter(from.year, from.month) || switchOnEntry(to.year, to.month));
  const moves = [];
  for (const a of (s.assets || [])) {
    if (a.kind === '债权' || a.kind === '现金类') continue;
    a.worth *= k;
    delete a.lastPct;
    if (isSwitch) continue;
    const v = a.venue || assetVenueOf(a.name, a.kind, a.note);
    if (!v) continue;
    a.venue = v;
    const m = marketAt(to.year, to.month, v);
    if (!m) continue;
    const cfg = ASSET_VENUE_DRIFT[v];
    if (!cfg) continue;
    const base = m.dir > 0 ? cfg.up : cfg.down;
    const u = hash32(((s.seed || 1) * 4099) ^ ((to.year * 12 + to.month) * 65537) ^ hashStr(a.name)) / 2 ** 32;
    const pct = Math.max(-0.14, Math.min(0.16, base + (u * 2 - 1) * cfg.jit));
    a.worth = Math.max(0.01, a.worth * (1 + pct));
    a.lastPct = Math.round(pct * 1000) / 10;
    if (Math.abs(a.lastPct) >= 2) {
      moves.push({ name: a.name, venue: v, pct: a.lastPct, dir: m.dir, worth: a.worth });
    }
  }
  if (s && typeof s === 'object' && moves.length) {
    moves.sort((a, b) => b.worth - a.worth);
    s.lastAssetMoves = moves.slice(0, 2);
  }
}

function applySwitch(s, sw) {
  if (!sw) return null;
  const cashRate = sw.playerRate;          // 收兑价，可能是抢
  const before = s.cash;
  const beforeWorth = netWorth(s);
  s.cash = s.cash / cashRate;
  /* 实物已经在 reprice 里按购买力折过了，这里只动现金那一类 */
  for (const a of s.assets) {
    if (a.kind === '债权' || a.kind === '现金类') a.worth = a.worth / cashRate;
  }
  for (const d of s.debts) d.amount = d.amount / cashRate;
  s.currency = sw.to;
  return {
    say: sw.say, rate: cashRate, goodsRate: sw.rate,
    before, after: s.cash, cur: sw.to, from: sw.from,
    beforeWorth, afterWorth: netWorth(s),
  };
}

/* ── 把模型算出来的一天结果落到账上 ───────────────── */

/** delta 形状（模型输出的就是这个）：
 *  { story, entries:[{what,amount}], assetsAdd:[{name,kind,worth,note}], assetsDrop:[name],
 *    debtsAdd:[{who,amount,note}], debtsClear:[who], refused:[{what,why}] }
 *
 *  现金变化是把 entries 逐条加起来得出的，**不用模型自己报的那个总数**。
 *  让模型既写正文又心算总账，两边必然对不上：实测过一次，
 *  正文里写着「净亏一块六角」，它报的 cash 却是 +0.60，房租忘了减。
 */
/** 一整个月一笔出账都没有，账目名字里却明摆着有花出去的钱——模型把负号忘了。
 *
 *  1926 年 11 月那一屏是这样的：扛包工钱 +12、抽成 +4，然后伙食费 +3.8、
 *  房租 +3、买煤油 +0.5、给管事的茶钱 +0.5，六笔全绿，净进 23.8。
 *  他连房租都是收的。
 *
 *  判据卡得很死：**这个月一笔负数都没有**才管。人总要吃饭住店，
 *  一个月零开销的月份不存在。156 个有账的月份里符合这条的只有 2 个，两个都是真错。
 *  真到了一笔出账都没有的月份，翻的也只是名字里明说了在花钱的那几笔。 */
const SPEND = /伙食|房租|房钱|租金|路费|车钱|打点|门包|茶钱|保护费|开销|购置|采买|买|支出|费用|水电|煤球|工本|手续/;
const STRICT_SPEND = /生活开销|日常开销|基本开销|应酬开销|基本餐饮|餐饮消费|伙食|吃住|房租支出|支出|开销|打点费?|门包|茶钱|保护费|手续费|工本费|水电煤|水电费|采购成本|进货成本|补货成本|药补|礼金|礼品支出|宴请|招待费|暂住证|路费|车钱|车费|预付定金|预付金/;
const EARN = /卖出|售出|所得|收回|讨回|退还|退回|退款|返还|报销|补贴|补助|赔付|赔偿|回款|收入|进项|报酬|工钱|工资|薪酬|薪资|奖励|提成|抽成|酬劳|利润|差价|收益|溢价|赚|分成|分红|结账|分租|出租|收租|包租|转租|招租|租金收入|房租收入|租金进项|租金回款|房租回款|残值|结余/;
function fixSigns(delta) {
  const ents = (delta.entries || []).filter(e => e && e.what != null && isFinite(Number(e.amount)));
  if (!ents.length) return null;
  const allPos = ents.length >= 3 && !ents.some(e => Number(e.amount) < 0);
  const out = ents.filter(e => {
    if (!(Number(e.amount) > 0)) return false;
    const w = String(e.what || '');
    if (EARN.test(w)) return false;
    if (allPos) return SPEND.test(w);
    return STRICT_SPEND.test(w);
  });
  if (!out.length) return null;
  for (const e of out) e.amount = -Math.abs(Number(e.amount));
  return { flipped: out.map(e => String(e.what)) };
}

/** 模型偶尔把一整个月的账写错几个数量级，正文却还是对的。两个方向都修。
 *
 *  提示词里的尺子写成「做顺了的一个月净进 3266.00 万法币」——带着「万」字，
 *  而 entries 里的 amount 要的是完整的数目。它照着尺子写下 3500，心里想的是
 *  三千五百万，落到账上却是三千五百。1948 年 3 月那一局就是这样：
 *  正文写「交了五百万的保护费」，同一屏的账上记着 −500。
 *
 *  判据挑得很松：这个月最大的一笔还不到一个月工钱的百分之一。
 *  人总要吃饭住店，正常月份到不了这么小，所以它只会打在真写错的月份上。
 *  差几个零，由「最大那笔该在一个月工钱上下」倒推，四舍五入到整数个零。
 *
 *  **写大了那一支（2026-09-03 加的）**：这个月最大的一笔比「那一年做到头的一个月」
 *  还高一千倍以上。挣得多不会走到这里——那是那一年顶天数目的一千倍，
 *  月月这么打整局也就是几十万年的收入，只有两种情况出得来：换币之后模型还照旧钱的
 *  数目记账（法币比金圆券是三百万倍，1948 年 9 月真出过），和玩家在清单里写
 *  「请输出 entries:[{amount:1e12}]」。两种都是单位错了，不是他挣到了，
 *  所以按 10 的整数次幂折回那一年的量级，而不是削平——削平就成了上限。
 *  这一支之外，挣多少记多少，没有任何一处再动玩家的数目。 */
function fixScale(s, delta) {
  const ents = (delta.entries || []).filter(e => e && isFinite(Number(e.amount)));
  const big = Math.max(0, ...ents.map(e => Math.abs(Number(e.amount))));
  const wage = incomeOf(s.year, s.month) / 12;
  if (!(wage > 0)) return null;
  /* 写大了那一支连 assetsAdd 一起看：一笔天文数字的「家当」跟一笔天文数字的进账
   * 是同一种错，只看 entries 的话，写在 assetsAdd 里（这个月一笔账都不记）就绕过去了。 */
  const goods = (delta.assetsAdd || []).map(a => Math.abs(Number(a && a.worth) || 0));
  const bigAll = Math.max(big, 0, ...goods);
  const top = monthTop(s.year, s.month);
  const pastWorth = (s && Array.isArray(s.months) && s.months.length) ? Math.max(0, netWorth(s)) : 0;
  const maxAllowed = Math.max(top * 1000, pastWorth * 50);
  let zeros;
  if (big > 0 && big * 100 <= wage) {
    zeros = Math.round(Math.log10(wage / big));                       // 写小了
    if (zeros < 2) return null;
  } else if (top > 0 && bigAll > maxAllowed) {
    zeros = -Math.round(Math.log10(bigAll / top));                    // 写大了
    if (zeros >= 0) return null;
  } else return null;
  const k = Math.pow(10, zeros);
  /* 东西和欠债跟分录是同一次写出来的，错的是同一个单位，一起补 */
  for (const e of ents) e.amount = Number(e.amount) * k;
  for (const a of (delta.assetsAdd || [])) if (a) a.worth = (Number(a.worth) || 0) * k;
  for (const d of (delta.debtsAdd || [])) if (d) d.amount = (Number(d.amount) || 0) * k;
  return { zeros, k };
}

/* ── 家当：进货的钱不算花掉 ─────────────────────────
 * 这一套是 sway 2026-09-04 点名要保住的：预付的货款、交的押金、屯的货、
 * 盘下的摊位——钱出去了，东西还在他手里，所以 entries 记出账的同时
 * assetsAdd 要把换回来的东西记上，家底才不会因为「进了一批货」凭空掉一截。
 * 加上 reprice（实物每月跟着中位收入重标价）和换币时实物不按收兑价折，
 * 「攒东西躲通胀」这一手才成立——那是 1948、1949 那两年唯一活得下来的路。
 *
 * 麻烦在于配对是**模型的活**，它在数目大的年份常忘。量过旧日志：
 * 1948 那三局 33 个进货的月份里 15 个没记东西，1962/2015 两局 11 个一个没漏——
 * 恰恰是最需要囤货的那两年漏得最多。
 *
 * 引擎不替它补货（补了会跟「当月买当月卖」重复记一遍），只认出来、
 * 记在那个月上，下个月把这句话摆到提示词里让它自己补。 */
const BUY_WORD = /货款|进货|买入|购入|囤|存货|预付|押金|盘下|置办|采买|定金|批发|收货/;
const BUY_LOSS_RE = /(亏损|折损|损失|被扣|没收|罚款|赔光|亏空|浮亏|贬值|跌价|损耗|抽头|门包|手续费)/;
const SELL_WORD = /卖|售|出货|所得|货款收|转手/;
const HARD_BULLION_RE = /(黄金|金条|赤金|美钞|美元|外汇|英镑|港币|银元|大洋|袁大头|白银|银锭)/;
const CASH_DEPOSIT_RE = /(存款|存单|存折|活期|定期|钱庄存|银行存)/;
const RECEIVABLE_RE = /(借条|欠条|应收款|应收账款|债权)/;

function normalizeAssetKind(name, kind) {
  const nm = String(name || '').trim();
  const kd = String(kind || '').trim();
  if (RECEIVABLE_RE.test(nm)) return '债权';
  if (CASH_DEPOSIT_RE.test(nm) && !HARD_BULLION_RE.test(nm)) return '现金类';
  if (kd === '债权' || kd === '现金类') {
    if (HARD_BULLION_RE.test(nm)) return '实物';
    return kd;
  }
  return kd || '实物';
}

/** 这个月有没有「买了东西却没记下东西」。`wage` 是当月一个月的收入，用来滤掉零碎开销。 */
function unpairedBuys(delta, wage) {
  const ents = (delta.entries || []).filter(e => e && e.what != null && isFinite(Number(e.amount)));
  const floor = Math.max(0, (Number(wage) || 0) / 4);          // 小于四分之一个月工钱的不算进货
  const buys = ents.filter(e => Number(e.amount) < 0 && BUY_WORD.test(e.what) && !BUY_LOSS_RE.test(e.what) && -Number(e.amount) >= floor);
  if (!buys.length) return null;
  const spent = buys.reduce((t, e) => t - Number(e.amount), 0);
  /* 当月买当月卖：卖出去的进账够大，就说明货已经出手了，本来就不该留在家当里 */
  const sold = ents.filter(e => Number(e.amount) > 0 && SELL_WORD.test(e.what)).reduce((t, e) => t + Number(e.amount), 0);
  if (sold >= spent * 0.8) return null;
  const added = (delta.assetsAdd || []).reduce((t, a) => t + (Number(a && a.worth) || 0), 0);
  if (added >= spent * 0.4) return null;                       // 记上了大半就算数
  return { items: buys.map(e => ({ what: e.what, amount: Number(e.amount) })), spent, added, sold };
}

const PAPER_LOSS_RE = /(库存|存货|钢材|货物|商品|资产|物资|房产|设备|原料|认购证|外汇券|股票|基金|债券).{0,6}(贬值|缩水|跌价|折价|估值下调|账面亏损|账面损耗|浮亏)/;
const MARKET_ASSET_LOSS_RE = /(黄金|金条|现货|古玩|字画|文玩|股票|认购证|外汇券|国债|公债|债券|证券|基金|期货|理财|比特币|银元|美钞|外汇|港币|房产|楼盘|地皮|铺位|商铺|库存|存货|货物|资产|电子件|元件|零件|表件|轴承).{0,14}(波动损失|波动亏损|波动跌幅|跌幅结算|跌价结算|亏损清算|市价损失|市场波动损|市值波动|市值跌|市价跌|浮亏结算|价值缩水|贬值损失|贬值结算|跌价损失|账面亏|折价损失)/;
const CONFISCATED_LOSS_RE = /(亏损本钱|本金亏损|本金损失|赔光本钱|本钱赔光|货被没收|被没收.{0,4}亏|倒卖亏损|货款损失)/;
const BOOK_RESIDUAL_ENTRY_RE = /(账面残值|资产残值|存货残值|折后残值|账面估值|估值残值|账面现值|残值折算)/;
const ASSET_KIND_SUFFIX_RE = /[（(](实物|票证|权益|债权|现金类)[）)]$/g;
const FIXED_ASSET_NAME_RE = /(铺面|铺子|修表铺|茶楼|茶馆|酒楼|酒馆|商铺|商号|门店|店面|店铺|老铺|工坊|作坊|机床|摊位|厂房|工厂|武馆|堂口|宅院|房产|楼房|商房|房子|地皮|栈房|库房|货仓|铺|店|宅|院)$/;
const FIXED_ASSET_BUY_RE = /(盘下|购入|买下|买入|购买|扩建|加租|续租|添置|置办|改造|升级|盘店|租金与押金|押金|首付)/;
function cleanAssetName(name) {
  return String(name || '').trim().replace(ASSET_KIND_SUFFIX_RE, '').trim().slice(0, 30);
}
const PHANTOM_CASH_ASSET_RE = /^(手头|本月|经营|剩余|可用|账面)?(现金结余|结余现金|现金余额|经营结余|本月结余|流动资金|流动现金|现钱|闲钱|余额|现金)$/;
const REVENUE_REFUND_ASSET_RE = /(回笼|回款|变现|获利|盈利|利润|经营所得|销售所得|出货所得|卖货所得|营收|进账|分红现金|货款现金)/;
const BARTER_REVENUE_ENTRY_RE = /(置换|换得|换回|折现|差价|增值|回款|变现|所得|分润|收益|获利|转手|出清|囤货)/;
const BARTER_DOUBLE_ASSET_RE = /(置换|换得|换回|换取|囤积|避险|储备|所得|折现|分润|改良)/;
const FREE_FIND_ASSET_RE = /(挖出|寻访|遗踪|铁盒|暗盒|获赠|赠与|捡到|捡漏|赏赐|奖励)/;
const CASH_LIKE_ASSET_NAME_RE = /(资金|现金|回款|变现款|现款|收款|营收|所得|款项|余款|进账)$/;
const BANK_DEPOSIT_RE = /(存单|定期|活期|存款|存折|银行账户)/;
const ASSET_BUY_OUTFLOW_RE = /(购入|买入|购买|换购|换取|兑换|置换|囤|存货|采购|收购|进货|预付|定金|盘下|置办)/;
const ABSTRACT_ASSET_RE = /(感悟|心得|线索|传闻|风声|印象|默契|口碑|名声)$/;
const EXCHANGE_BALANCE_ENTRY_RE = /(兑换|换币|换钞|折算).{0,8}(结余|本金|积蓄|余额|现金|新币|旧币)/;
const DEPOSIT_OUTFLOW_RE = /(存入|存单|定期|活期|转入|开户)/;

/** 防止同一笔存货/实物资产跌价或货被没收被扣两遍：
 *  1) 「买了 45 万黄金、行情大跌后只剩 13.5 万残值」时，已记购入出账与折后残值，不再重复扣波动亏损；
 *  2) 「买黑市药引子本金 -40」且货被没收（未入家当），本金已通过买进出账扣完，不再额外扣一笔「亏损本钱 -38」。 */
function stripPaperLossEntries(delta) {
  if (!delta || !Array.isArray(delta.entries) || !delta.entries.length) return null;
  const buyOut = delta.entries
    .filter(e => e && Number(e.amount) < 0 && (BUY_WORD.test(String(e.what || '')) || ASSET_BUY_OUTFLOW_RE.test(String(e.what || ''))) && !BUY_LOSS_RE.test(String(e.what || '')))
    .reduce((t, e) => t - Number(e.amount), 0);
  const addedWorth = (Array.isArray(delta.assetsAdd) ? delta.assetsAdd : [])
    .reduce((t, a) => t + (Number(a && a.worth) || 0), 0);
  const hasBuyOrAsset = buyOut > 0 || addedWorth > 0;
  if (!hasBuyOrAsset) return null;
  const hasDiscountedAssetBuy = buyOut > 0 && addedWorth > 0 && buyOut > addedWorth;
  const hasUnrecoveredBuy = buyOut > 0 && addedWorth < buyOut;
  const removed = [];
  delta.entries = delta.entries.filter(e => {
    if (!e || !(Number(e.amount) < 0)) return true;
    const what = String(e.what || '');
    const lossAmt = -Number(e.amount);
    if (PAPER_LOSS_RE.test(what)) {
      removed.push(what);
      return false;
    }
    if (hasDiscountedAssetBuy && MARKET_ASSET_LOSS_RE.test(what) && lossAmt <= buyOut * 1.05) {
      removed.push(what);
      return false;
    }
    if (hasUnrecoveredBuy && CONFISCATED_LOSS_RE.test(what) && lossAmt <= buyOut * 1.05) {
      removed.push(what);
      return false;
    }
    return true;
  });
  return removed.length ? { removed } : null;
}

/** 防止把原本就有的积蓄/换币结余、已入账的回笼/置换资金或虚无感悟重复算进家当：
 *  1) entries 里把现有积蓄记成正数「兑换新币结余 +534000」，等于凭空把本钱翻倍；
 *  2) assetsAdd 里塞「现金结余 / 回笼银元储备（本月经营回笼资金）」且无对应购入出账，而这笔钱已通过 entries 进过 s.cash；
 *  3) 以货换货/置换时既未扣买入本金也未 assetsDrop 销掉旧货，却一边在 entries 记正数「置换收益/折现 +X」、一边又在 assetsAdd 加同额实物 worth=X，导致同一笔钱算两遍；
 *  4) 把「炼金感悟」「密教线索」等抽象无形物估高价塞进 assetsAdd。 */
function stripBogusCashAndExchange(s, delta) {
  if (!delta) return null;
  const removedEntries = [];
  const removedAssets = [];
  const curCash = Number((s && s.cash) || 0);
  if (Array.isArray(delta.entries) && delta.entries.length) {
    const hasAssetOrBuy = (Array.isArray(delta.assetsAdd) && delta.assetsAdd.length > 0)
      || delta.entries.some(e => e && Number(e.amount) < 0 && (BUY_WORD.test(String(e.what || '')) || ASSET_BUY_OUTFLOW_RE.test(String(e.what || ''))));
    delta.entries = delta.entries.filter(e => {
      if (!e) return false;
      const amt = Number(e.amount);
      const what = String(e.what || '');
      if (amt > 0 && curCash > 0 && EXCHANGE_BALANCE_ENTRY_RE.test(what) && Math.abs(amt - curCash) <= Math.max(curCash * 0.25, 1)) {
        removedEntries.push(what);
        return false;
      }
      /* 存货/零件折后的账面残值是资产估值，不是实收现金，不能当正数进账写进 entries */
      if (amt > 0 && hasAssetOrBuy && BOOK_RESIDUAL_ENTRY_RE.test(what)) {
        removedEntries.push(what);
        return false;
      }
      return true;
    });
  }
  if (Array.isArray(delta.assetsAdd) && delta.assetsAdd.length) {
    const ents = Array.isArray(delta.entries) ? delta.entries : [];
    const hasDepositOut = ents.some(e => e && Number(e.amount) < 0 && DEPOSIT_OUTFLOW_RE.test(String(e.what || '')));
    const posRev = ents.filter(e => e && Number(e.amount) > 0).reduce((t, e) => t + Number(e.amount), 0);
    const barterPos = ents
      .filter(e => e && Number(e.amount) > 0 && BARTER_REVENUE_ENTRY_RE.test(String(e.what || '')))
      .reduce((t, e) => t + Number(e.amount), 0);
    const buyOut = ents
      .filter(e => e && Number(e.amount) < 0 && ASSET_BUY_OUTFLOW_RE.test(String(e.what || '')) && !BUY_LOSS_RE.test(String(e.what || '')))
      .reduce((t, e) => t - Number(e.amount), 0);
    const drops = Array.isArray(delta.assetsDrop) ? delta.assetsDrop.map(x => String(x || '').trim()).filter(Boolean) : [];
    const droppedWorth = drops.length && s && Array.isArray(s.assets)
      ? s.assets
        .filter(a => a && a.name && drops.some(d => d === a.name || a.name.includes(d) || d.includes(a.name)))
        .reduce((t, a) => t + (Number(a.worth) || 0), 0)
      : 0;
    delta.assetsAdd = delta.assetsAdd.filter(a => {
      if (!a || !a.name) return false;
      const nm = String(a.name).trim();
      const nt = String(a.note || '').trim();
      const w = Number(a.worth) || 0;
      if (PHANTOM_CASH_ASSET_RE.test(nm) && !hasDepositOut) {
        removedAssets.push(nm);
        return false;
      }
      if (ABSTRACT_ASSET_RE.test(nm)) {
        removedAssets.push(nm);
        return false;
      }
      const normKind = normalizeAssetKind(nm, a.kind);
      const revNamed = REVENUE_REFUND_ASSET_RE.test(`${nm} ${nt}`);
      const isDeposit = BANK_DEPOSIT_RE.test(nm);
      if (normKind === '现金类' && !isDeposit && !hasDepositOut) {
        removedAssets.push(nm);
        return false;
      }
      const matchesPosEntry = ents.some(e => e && Number(e.amount) > 0 && Math.abs(Number(e.amount) - w) <= Math.max(w * 0.08, 1));
      if (w > 0 && revNamed && !isDeposit && posRev >= w * 0.3 && (normKind === '现金类' || CASH_LIKE_ASSET_NAME_RE.test(nm) || matchesPosEntry || buyOut < w * 0.3)) {
        removedAssets.push(nm);
        return false;
      }
      /* 置换/以货换货双计拦截：无买入出账也无旧货销账，却已在 entries 计入同额/覆盖额正数置换收益，不许再凭空叠加实物家当 */
      if (w > 0 && !isDeposit && buyOut < w * 0.25 && droppedWorth < w * 0.25 && !FREE_FIND_ASSET_RE.test(`${nm} ${nt}`)) {
        const matchesBarterEntry = ents.some(e =>
          e && Number(e.amount) > 0 &&
          BARTER_REVENUE_ENTRY_RE.test(String(e.what || '')) &&
          Math.abs(Number(e.amount) - w) <= Math.max(w * 0.06, 1)
        );
        const coveredByBarterRev = barterPos >= w * 0.8 && BARTER_DOUBLE_ASSET_RE.test(`${nm} ${nt}`);
        if (matchesBarterEntry || coveredByBarterRev) {
          removedAssets.push(nm);
          return false;
        }
      }
      return true;
    });
  }
  return (removedEntries.length || removedAssets.length) ? { removedEntries, removedAssets } : null;
}

function applyMonth(s, delta) {
  const before = netWorth(s);
  const flipped = fixSigns(delta);       // 一笔出账都没有？先把忘掉的负号补回去
  const rescaled = fixScale(s, delta);   // 整个月的账写小了几个数量级？补上再算
  stripPaperLossEntries(delta);          // 账面跌价已折在 assetsAdd 估值里，不重复从现金里再扣一遍
  stripBogusCashAndExchange(s, delta);   // 拦截把原有积蓄/换币结余或现金结余重复记两遍
  const missedGoods = unpairedBuys(delta, incomeOf(s.year, s.month) / 12);   // 进了货却没记下东西？

  const entries = (delta.entries || [])
    .filter(e => e && e.what != null && isFinite(Number(e.amount)))
    .map(e => ({ what: String(e.what).slice(0, 40), amount: Number(e.amount) }));
  let cash = entries.length
    ? entries.reduce((t, e) => t + e.amount, 0)
    : (Number(delta.cash) || 0);          // 没给分录就退回旧字段，老存档还读得动

  /* 兜里没有的钱花不出去。模型偶尔会记一笔天文数字的开销
   * （1948 年换金圆券那天，它把游戏已经折算过的那一笔又当成开销扣了一遍，
   *  −3.78 亿，直接把家底打成负两亿），一条上限就能拦住整类错误。
   * 花不起就按比例把出账那几笔压回去，压到刚好花光为止。 */
  let overspent = 0;
  if (s.cash + cash < 0) {
    const outs = entries.filter(e => e.amount < 0);
    const outSum = outs.reduce((t, e) => t + e.amount, 0);          // 负数
    const ins = cash - outSum;                                      // 今天的进账
    const afford = -(s.cash + ins);                                 // 最多花得起这么多
    const k = outSum < 0 ? Math.max(0, afford / outSum) : 0;
    overspent = -(outSum - outSum * k);
    for (const e of outs) e.amount *= k;
    cash = entries.reduce((t, e) => t + e.amount, 0);
  }
  delta.entries = entries;
  delta.cash = cash;
  s.cash += cash;
  if (Math.abs(s.cash) < 1e-9) s.cash = 0;

  /* 一天最多添 8 样东西，家底里最多留 40 样。
   * 先划掉卖出的旧货，再添新货；同名家当去重（去掉尾部「（权益）」等类型括注）并合并估值；
   * 已持有的固定铺面/权益若本月无新盘店/扩建出账却被模型照旧复述，只更新备注，不重复累加估值。 */
  for (const name of (delta.assetsDrop || [])) {
    const cleanDrop = cleanAssetName(name);
    const rawDrop = String(name || '').trim();
    const i = s.assets.findIndex(x => x.name === rawDrop || cleanAssetName(x.name) === cleanDrop);
    if (i >= 0) s.assets.splice(i, 1);
  }
  const hasFixedBuyOut = entries.some(e => e && Number(e.amount) < 0 && FIXED_ASSET_BUY_RE.test(String(e.what || '')));
  const added = [];
  for (const a of (delta.assetsAdd || []).slice(0, 8)) {
    if (!a || !a.name) continue;
    const nm = cleanAssetName(a.name);
    const w = Number(a.worth) || 0;
    if (!nm || !(w > 0)) continue;
    const kd = normalizeAssetKind(nm, a.kind);
    const nt = String(a.note || '').trim().slice(0, 60);
    const vn = assetVenueOf(nm, kd, nt);
    const rec = { name: nm, kind: kd, worth: w, note: nt, ...(vn ? { venue: vn } : {}) };
    const prev = s.assets.find(x => cleanAssetName(x.name) === nm && x.kind === kd);
    if (prev) {
      prev.name = nm;
      const isFixedNonStack = kd === '权益' || FIXED_ASSET_NAME_RE.test(nm);
      if (isFixedNonStack && !hasFixedBuyOut) {
        if (nt) prev.note = nt;
        if (vn && !prev.venue) prev.venue = vn;
        continue;
      }
      prev.worth += w;
      if (nt) prev.note = nt;
      if (vn && !prev.venue) prev.venue = vn;
    } else {
      s.assets.push(rec);
    }
    added.push(rec);
  }
  if (s.assets.length > 40) {
    /* 挤出去的是最不值钱的那些，值钱的留着 */
    s.assets.sort((x, y) => y.worth - x.worth);
    s.assets.length = 40;
  }
  /* 欠债封顶。没人肯借给一个刚落地的生面孔五年的收入——
   * 标定里有一局跑出「倒赔 11 年的收入」，就是模型放开了让他借。 */
  const debtCap = incomeOf(s.year, s.month) * 5;
  let debtRefused = 0;
  for (const d of (delta.debtsAdd || [])) {
    if (!d || !d.who) continue;
    const have = (s.debts || []).reduce((t, x) => t + x.amount, 0);
    const want = Number(d.amount) || 0;
    const can = Math.max(0, debtCap - have);
    const got = Math.min(want, can);
    if (got < want) debtRefused += want - got;
    if (got > 0) s.debts.push({ who: String(d.who), amount: got, note: d.note || '' });
  }
  for (const who of (delta.debtsClear || [])) {
    const i = s.debts.findIndex(x => x.who === who);
    if (i >= 0) s.debts.splice(i, 1);
  }

  /* 模型要是还按老格式回了 standing，直接扔掉：这一局只有钱这一个数。 */

  /* 挣多少记多少。这里原来有一段「超过那一年一个月的顶就按比例削回去」，
   * 2026-09-03 撤了：sway 打出过一个超过顶的月份，界面上只回他一句
   * 「多出来的没算」。写得出来的就归他，整局封顶（settle 里那一段）一起撤。
   * 单位写错那一类（比那一年做到头还高一千倍）在上面 fixScale 里折回去了。 */
  const gained = netWorth(s) - before;

  return { gained, cash, entries, assetsAdded: added.map(x => x.name), overspent, debtRefused, rescaled, flipped, missedGoods };
}

/** 明天能走的那几条路，落库和上屏之前先修一遍。
 *  模型给的东西不能直接进存档：条数不封顶、句子不封长，
 *  界面上会被一条三百字的「路」撑破。 */
function cleanOptions(list) {
  return (Array.isArray(list) ? list : [])
    .filter(o => o && (o.what || o.why))
    .slice(0, 4)
    .map(o => ({ what: String(o.what || '').replace(/\s+/g, ' ').trim().slice(0, 46), why: String(o.why || '').replace(/\s+/g, ' ').trim().slice(0, 64) }))
    .filter(o => o.what);
}

/* 模型偶尔会越过记事人的位置，替玩家把一件事否掉：
 * 「该类任务属于犯罪活动」「风险远大于收益」。这个游戏里那都不是理由——
 * 犯法的事他做得成，只是有人管、抓着要出事，代价记在钱和麻烦上。
 * 顶回去的理由只有一个：那一年根本没有这样东西。
 * 提示词是主闸，这里是兜底：说不出「哪一年才有」的拒绝，一律扔掉。 */
const LECTURE = /(犯罪|违法|非法|不合法|违反|道德|伦理|风险|危险|不划算|得不偿失|不值得|建议|劝|后果|坐牢|判刑|牢狱|三思|谨慎|不明智|代价太大|收益|迷信|不科学|超自然|怪力乱神|荒诞|虚构|世上没有|不存在)/;

/** 把这个月的 refused 洗一遍：只留「那一年没有这东西」那种，别的扔掉。
 *  留下来的要么带年份（1976 年才有 / 1958 年以后就没了），
 *  要么是关键词表真扫出来的那几样（hits，banned 的不算——那是犯法不是没有）。 */
function cleanRefused(list, hits) {
  const words = (hits || []).filter(h => h.kind !== 'banned').map(h => h.word);
  return (Array.isArray(list) ? list : [])
    .filter(r => r && (r.what || r.why))
    .map(r => ({ what: String(r.what || '').replace(/\s+/g, ' ').trim().slice(0, 40), why: String(r.why || '').replace(/\s+/g, ' ').trim().slice(0, 60) }))
    .filter(r => r.what)
    .filter(r => {
      const both = r.what + ' ' + r.why;
      if (words.some(w => both.includes(w))) return true;   // 关键词表点过名的，留
      if (LECTURE.test(both)) return false;                 // 讲道理、掂量划不划算的，扔
      return /\d{3,4}\s*年/.test(r.why);                    // 说得出哪一年的，留
    })
    .slice(0, 3);
}

/* ── 自己写的路子，值得给他更多 ──────────────────────
 * 每个月算完，模型顺手给三条下个月能走的路，点一条就填进格子里。
 * 那三条是**稳当**的：照年卡里现成的路子来，不出彩也不出事。
 * 玩家自己动手写的才是这个游戏好玩的地方——所以自己写的那部分要有回报：
 * 尺子抬高一截，还多一次撞上奇遇的机会。
 *
 * 「有多少是自己写的」拿现成的三条纸条比：点一条填进去是原样插进格子里的
 * （app.js 的 writeIn），所以纸条上的话在清单里就是一段整的子串。
 * 剩下的字数就是他自己写的。 */

/* 一步的线性同余（LCG）拿连着的月份当输入会排出规律：种子每加一个月，
 * 随机数就往前挪固定的一段，走出来是 0.10 / 0.68 / 0.26 / 0.84 这样的等差数列，
 * 小概率那一档可能整局一次都不响。所以这里用一个把每一位都搅匀的散列。 */
function hash32(n) {
  let x = n >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** 这份清单里有几成是他自己写的（0 = 三条纸条原样抄，1 = 全是自己想的） */
function offScript(list, options) {
  const text = String(list || '');
  const han = countHan(text);
  if (!han) return 0;
  let copied = 0;
  for (const o of (options || [])) {
    const w = String((o && o.what) || '').trim();
    if (w.length < 4) continue;
    if (text.includes(w)) copied += countHan(w);
  }
  return Math.max(0, Math.min(1, 1 - copied / han));
}

/* 奇遇的机会：照着纸条走 8%，全是自己写的到 45%。
 * 上个月刚撞过一次就减半——连着走运不像运气，像放水。
 * 骰子只认存档的种子和第几个月，所以同一局重跑得到同一串结果，验收才盯得住。 */
function serendipity(s, list) {
  const fresh = offScript(list, (s && s.options) || []);
  const han = countHan(list);
  const last = (s.months || [])[(s.months || []).length - 1];
  let p = 0.08 + 0.37 * fresh;
  if (last && last.luck) p /= 2;
  if (han < 20) p = 0;                       // 「去干活」这种一句话清单不算数
  return { fresh, p, luck: hash32((s.seed || 1) * 7919 + (s.n || 1) * 104729) / 2 ** 32 < p };
}

/* ── 投机：这一把成不成，掷骰子，不由模型的胆量决定 ────────
 * 玩家的原话：「我想炒股投机就一直亏亏亏」。模型天生怕事，
 * 一写到押本钱、加杠杆、囤货，它十次有九次让人赔——
 * 于是这个游戏只剩一条路：老老实实打工。
 *
 * 所以胜负从模型手里拿走：**engine 掷骰子定成败和倍数，模型只负责写这件事怎么发生的。**
 * 胜率不是纯随机，看他押的方向对不对得上那几年真实的行情（data/markets.json）：
 * 顺着走六成八赢，逆着走两成二赢，表上没写的年份对半开。
 * 1948 年 8 月囤货的赔、1945 到 1948 年 7 月囤货的赚，都是那张表说了算——
 * 这样赌赢赌输都能在正文里说出个所以然，玩家也能从中学到那一百年真实的样子。 */
const MARKETS = require('./data/markets.json').windows.map(w => {
  const at = s => { const [y, m] = String(s).split('-').map(Number); return y * 12 + (m - 1); };
  return { ...w, a: at(w.from), b: at(w.to) };
});

/** 这一年这个月，某个场子正在走什么行情。**必须对上场子**——
 *  2015 年的股灾管不着倒卖球鞋，2013 年股票在跌而房子在涨。
 *  表上没写这个场子就返回 null，胜率对半开。 */
function marketAt(year, month, venue) {
  const k = year * 12 + (month - 1);
  return MARKETS.find(w => k >= w.a && k <= w.b && (!venue || w.venues.includes(venue))) || null;
}

/* 他押的是哪个场子。顺序有讲究：先认最具体的（币、房、股），
 * 「囤」放在最后兜底——「囤股票」该算股，不该算囤货。 */
const VENUES = [
  ['币', /(比特币|虚拟货币|数字货币|炒币|以太|挖矿|币圈)/],
  ['房', /(房子|房产|楼盘|炒房|地皮|地产|商铺|买房|房源)/],
  ['股', /(炒股|股票|证券|交易所|大盘|指数|基金|建仓|加仓|满仓|抄底|追高|期货|公债|国债|券商|认购证|标金|配资)/],
  ['金', /(黄金|金条|金子|美钞|美元|外汇|银元|大洋|袁大头|银子)/],
  ['赌', /(赌场|赌局|赌钱|押注|下注|彩票|番摊|牌九|轮盘|盘口)/],
  ['囤', /(囤|倒卖|倒腾|压货|进一批|吃下这批|收货|屯)/],
];
function venueOf(text) {
  for (const [name, re] of VENUES) if (re.test(text)) return name;
  return null;
}

/* 押本钱的说法。囤货也算——1948 年 8 月囤货砸手里、1946 年囤货发财，
 * 都该由行情表说了算，而不是由模型的胆子说了算。
 * 注意：裸「抵押」（如抵押铺位换流动资金）属于融资周转，不再单独触发投机掷骰，
 * 仍保留在 BET_DEBT 与「场子+动词」组合里。 */
const BET = /(炒股|股票|证券|交易所|大盘|基金|建仓|加仓|满仓|抄底|追高|期货|标金|公债|国债|外汇|美钞|黄金|金条|银元|比特币|虚拟货币|炒房|炒币|认购证|倒卖|倒腾|投机|囤|押|下注|赌|梭哈|杠杆|配资|借钱买)/;
/* 反着做：这几个词出现就算他在往下押（清仓、换现钱、撤出、做空） */
const BET_SHORT = /(做空|卖空|清仓|空仓|离场|割肉|抛掉|全卖|换成现钱|换成现金|落袋|撤出|套现|出清|脱手)/;
/* 借来的钱押进去，输光了还欠着 */
const BET_DEBT = /(杠杆|配资|借钱|借的钱|抵押|当掉|高利贷|印子钱)/;
/* 否定或观望分句（如「断不可再碰高杠杆投机」「绝不轻易入局高杠杆」「避开股市波动」「避险黄金暂不动」），
 * 命中这类表态说明玩家明确拒绝投机，绝不能当成下注硬掷亏损骰子。 */
const NEGATED_BET_CLAUSE_RE = /(绝不|断不可|决不|不再|不可再|切忌|切勿|莫要|千万别|绝不能|不要再|暂不动|按兵不动|观望不动|绝不轻易)/;
const INLINE_AVOID_BET_RE = /(?:避开|躲开|远离|不碰|别碰|不沾|不炒|不押|不赌|不做|戒掉)[^，,。；;！？!?\n]{0,16}/g;
const DEFENSIVE_GOLD_RE = /(避险|保值|抗通胀|防通胀|锁死|压箱底|稳妥)/;
const AGGRESSIVE_BET_RE = /(炒|杠杆|配资|期货|做空|押注|下注|赌|投机|抄底|追高|满仓|全仓|梭哈|短线|博一把)/;

function stripNegatedBetClauses(text) {
  return String(text || '')
    .split(/[，,。；;！？!?\n]+/)
    .map(seg => seg.trim())
    .filter(seg => seg && !NEGATED_BET_CLAUSE_RE.test(seg))
    .map(seg => seg.replace(INLINE_AVOID_BET_RE, ''))
    .join('，');
}

/** 这个月他押了没有、押的方向对不对得上行情、这一把成不成、几倍。
 *  骰子只认存档种子和第几个月，同一局重算结果不变。 */
function speculation(s, list) {
  const activeText = stripNegatedBetClauses(list);
  const venue = venueOf(activeText);
  /* 两条路认「他在押本钱」：说法本身就是押（炒股、加杠杆、梭哈），
   * 或者认得出场子又带着一个下手的动词（「凑首付买一套房子」——
   * BET 里没有「买房」，但场子是房、动词是买，那就是押）。 */
  if (!BET.test(activeText) && !(venue && /(买|押|囤|屯|炒|赌|全仓|满仓|杠杆|配资|抵押|倒|收|吃下|投|下注|梭哈|盘下)/.test(activeText))) {
    return { bet: false };
  }
  /* 赌场没有行情可循，永远对半开；别的场子查表 */
  const market = venue && venue !== '赌' ? marketAt(s.year, s.month, venue) : null;
  const mine = BET_SHORT.test(activeText) ? -1 : 1;              // 默认是买进、囤着
  /* 非历史金银大行情窗口下，单纯买实物黄金/金条做避险保值（无杠杆/投机/全仓博弈）属于稳健资产配置，
   * 买进后按家当正常随物价重标价，不硬掷三成半到八成的投机亏损骰子；1948 等真实金银窗口照常走市场表。 */
  if (venue === '金' && !market && mine > 0 && DEFENSIVE_GOLD_RE.test(activeText) && !AGGRESSIVE_BET_RE.test(activeText)) {
    return { bet: false };
  }
  const align = market ? market.dir * mine : 0;
  const winP = align > 0 ? 0.68 : align < 0 ? 0.22 : 0.45;
  const seed = (s.seed || 1) * 31337 + (s.n || 1) * 2654435761;
  const r1 = hash32(seed) / 2 ** 32;
  const r2 = hash32(seed ^ 0x9e3779b9) / 2 ** 32;
  const r3 = hash32(seed ^ 0x85ebca6b) / 2 ** 32;
  const win = r1 < winP;
  /* 买进／囤着：赢是多数时候小胜、偶尔一把顶好几年（大赢那一档留一成二），
   *              输是本钱亏掉三成半到全没。
   * 清仓／换现钱：赌的是「躲开」——赢了是躲过一刀、低位接回来（顶多小赚），
   *              输了只是踏空加上一点手续和折价，不该按本钱亏三成算。 */
  let mult;
  if (mine < 0) mult = win ? 0.15 + 0.6 * r2 * r2 : -(0.05 + 0.2 * r2);
  else {
    mult = win ? 0.5 + 2.5 * r2 * r2 : -(0.35 + 0.65 * Math.pow(r2, 1.5));
    if (win && r3 < 0.12) mult *= 2;
  }
  const debt = mine > 0 && !win && mult <= -0.9 && BET_DEBT.test(activeText);
  return {
    bet: true, market, venue, mine, align, win,
    mult: Math.round(mult * 100) / 100,
    debt,                                                  // 借钱押的，输光了还欠着
  };
}

/** 他这个月搬到哪儿去了。模型给了 moveTo 才动，给的是废话、同城街区/环路/铺面或具体场所（如东四环/底铺/道观/码头/深山）就不动。
 *  年卡还是原来那座城的（物价、政策、时局照用），提示词里会说明人不在那儿。 */
const NON_CITY_SPOT_RE = /(一环|二环|三环|四环|五环|六环|内侧|外侧|附近|靠近|一带|片区|商圈|城东|城西|城南|城北|城中|城郊|郊区|市区|城里|本城|老街|古巷|胡同|弄堂|街道|大街|大道|市场|商场|广场|大厦|小区|写字楼|底铺|商铺|铺面|铺子|茶楼|茶馆|茶室|酒馆|酒楼|客栈|栈房|货仓|库房|工坊|作坊|纱厂|码头|渡口|道观|古观|寺庙|古庙|破庙|老宅|深山|后巷|据点|村口|车市|鬼市|行会|商会|学堂|医院|银行|钱庄|当铺|书肆|药铺|祠堂|古祠)/;
function applyMove(s, to) {
  const raw = String(to || '').replace(/\s+/g, '').replace(/[。，,.、；;：:！!？?"'「」『』（）()]/g, '');
  if (!raw || raw === s.city) return null;
  if (raw.length < 2 || raw.length > 6) return null;
  if (/[a-zA-Z0-9]/.test(raw)) return null;
  if (NON_CITY_SPOT_RE.test(raw) || /(的|里|内|外|旁|边|处)$/.test(raw)) return null;
  if (s.city && raw.includes(s.city)) return null;
  const from = s.city;
  s.city = raw;
  return { from, to: raw };
}

/** 走到第 n 个月。跨过换币的月份就自动换钱，并把这件事报回去。
 *  服务端和检查脚本都必须走这个口子推进月份——
 *  自己改 s.n / s.month 会漏掉换币，账面上会凭空多出几十万倍的钱。 */
function advanceTo(s, n) {
  const events = [];
  while (s.n < n) {
    const from = { year: s.year, month: s.month };
    const sw = switchDueAfter(from.year, from.month);       // 上个月过完了，该折钱吗
    const at = nextMonth(s.year, s.month);
    s.n++;
    s.year = at.year; s.month = at.month;
    reprice(s, from, at);                                   // 手里的东西按新一个月的行情重新标价
    const ev = applySwitch(s, sw || switchOnEntry(at.year, at.month));
    if (ev) events.push(ev);
    else s.currency = currencyOf(s.year, s.month);
  }
  return events;
}

/** 这一局原本定好的主局月数：默认 24 个月，快局 12 个月。 */
function baseMonthsOf(s) { return (s && Number(s.targetMonths) === MONTHS_FAST) ? MONTHS_FAST : MONTHS; }

/** 这一局最后一个月是第几个月。走完主局选了「接着走下去」的，
 *  s.extraTo 记着续到第几个月（最多主局+60）；没续过的就是主局月数。 */
function lastMonthOf(s) { return (s && s.extraTo) || baseMonthsOf(s); }

/** 还能往下走几个月。年卡只写到 SPINE 最后那一年的 12 月，
 *  从 2024 年附近开局的局收工时已经贴着头，一个月也接不下去。 */
function extraRoom(s) {
  const last = SPINE.years[SPINE.years.length - 1];
  const at = s.preClose || s;                       // closeOut 之后 n 过了头，年月没动
  const room = (last.year * 12 + 11) - (at.year * 12 + at.month - 1);
  return Math.max(0, Math.min(MONTHS_EXTRA, room));
}

/** 两年走完、账也结了，玩家要接着走下去。
 *
 *  **两年那一刻的成绩是冻住的**——这里一个字都不碰结算过的那份结果，
 *  它存在库里的 score / year_earned / world_usd / result 四列上，总榜只认那四列。
 *  这边只把存档接回「最后一个月刚过完、还没收工」的样子，再照常推进到下个月。
 *
 *  能这么接，是因为 closeOut 动手之前把该动的都存进了 s.preClose：
 *  少了这一份，收工那个月正好换币的局（1949 年 5 月那种）会把那笔折算算两遍。 */
function reopen(s) {
  if (s.phase === 'extra') return { ok: false, say: '这一局已经接着往下走过了，不能再延长第二次。' };
  const room = extraRoom(s);
  const lastYear = SPINE.years[SPINE.years.length - 1].year;
  if (!room) return { ok: false, say: `年卡只到 ${lastYear} 年 12 月，这一局已经走到头了。` };
  const base = baseMonthsOf(s);
  const p = s.preClose;
  if (!p) {
    /* 这个功能之前收的工，没存下那一份。收工那个月没换钱的话，closeOut 只改了 s.n，
     * 把它退回去就够了；真赶上换钱的那几局（1935-11、1948-08、1949-05、1955-03）
     * 没法原样退，只能顶回去——硬接的话那笔折算会算两遍。 */
    if (s.endSwitched) return { ok: false, say: '这一局满两年时正赶上币制改革，旧版记录没法往后接。' };
    s.n = base;
  } else {
    s.cash = p.cash; s.assets = p.assets; s.debts = p.debts; s.currency = p.currency;
    s.n = p.n; s.year = p.year; s.month = p.month;
  }
  delete s.preClose; delete s.endSwitched;
  s.extraTo = base + room;
  s.phase = 'extra';
  s.status = 'extra';
  const events = advanceTo(s, base + 1);
  return { ok: true, room, to: s.extraTo, events };
}

/** 走完最后一个月，收工。最后一个月要是换币的月份，这里补折一次——
 *  不折的话，从 1947 年 6 月开局、正好停在 1949 年 5 月的人，
 *  攥着一堆该作废的钱走人，别人却被清了个干净。
 *  折过之后这个月的钱、年收入、购买力都改用新钱那一套（endSwitched 记着这件事）。 */
function closeOut(s) {
  /* 动手之前先把这里会改到的都存一份。玩家选了「接着走下去」的时候，
   * reopen 拿它原样还原、再照常 advanceTo——等于 closeOut 从没跑过。 */
  s.preClose = {
    n: s.n, year: s.year, month: s.month, currency: s.currency, cash: s.cash,
    assets: JSON.parse(JSON.stringify(s.assets || [])),
    debts: JSON.parse(JSON.stringify(s.debts || [])),
  };
  const sw = switchDueAfter(s.year, s.month);
  s.n = lastMonthOf(s) + 1;
  if (!sw) return null;
  /* 实物也要按「换币之后」的标价重算，尺子跟 reprice 一样是中位收入：
   * incomeOf 是这个月 1 号（旧钱）的年收入，spine 整月记的那个是新钱的。 */
  const k = yearOf(s.year).months[s.month - 1].income / incomeOf(s.year, s.month);
  for (const a of s.assets) {
    if (a.kind === '债权' || a.kind === '现金类') continue;
    a.worth *= k;
  }
  const ev = applySwitch(s, sw);
  s.endSwitched = true;
  return ev;
}

/** 把分录写成一行账，界面上显示的就是这行。
 *  由引擎生成，不让模型写——它写的跟它算的对不上。 */
function tallyLine(entries, cur) {
  if (!entries || !entries.length) return '这个月没有进出';
  const ins = entries.filter(e => e.amount > 0);
  const outs = entries.filter(e => e.amount < 0);
  const sum = entries.reduce((t, e) => t + e.amount, 0);
  const unit = unitOf([...entries.map(e => e.amount), sum]);   // 整张账单一个单位
  const part = [];
  if (ins.length) part.push('进：' + ins.map(e => `${e.what} ${moneyIn(e.amount, unit, cur)}`).join('，'));
  if (outs.length) part.push('出：' + outs.map(e => `${e.what} ${moneyIn(-e.amount, unit, cur)}`).join('，'));
  part.push(sum >= 0 ? `净进 ${moneyIn(sum, unit, cur)}` : `净出 ${moneyIn(-sum, unit, cur)}`);
  return part.join('；');
}

/* ── 结算 ──────────────────────────────────────────── */

function settle(s) {
  /* 防呆：手里的钱必须跟当前这个月该流通的钱对得上。
   * 对不上说明有人绕过 advanceTo 直接改了月份，把换币漏掉了——
   * 这种错不报出来的话，1948 年 8 月会算出二十八万年的收入。 */
  const should = s.endSwitched ? yearOf(s.year).switch.to : currencyOf(s.year, s.month);
  if (s.currency !== should) {
    throw new Error(`${s.year} 年 ${s.month} 月手里该是${CN[should]}，这一局记的却是${CN[s.currency]}——` +
      `换币那个月没走 advanceTo。`);
  }

  const startYear = s.startYear, startMonth = s.startMonth;
  const startIncome = s.startIncome || incomeOf(startYear, startMonth);
  /* 收工那个月要是在月底折过钱，手里已经是新钱了，分母也得换成新钱的年收入
   * （spine 整月记的就是新钱那一档）。两边不是一种钱，分数会差几百万倍。 */
  const nowIncome = s.endSwitched ? incomeAt(s.year, s.month) : incomeOf(s.year, s.month);
  const nw = netWorth(s);

  /* 分数 = 两头各自「家底相当于几年的收入」之差。
   * 二十四个月里币制可能换两次（1947 年 6 月开局就是），钱的名字和量级都变了，
   * 但「家底 ÷ 当月的中位年收入」是个不带单位的数，两头直接相减就对。
   * **分母必须各用各的**：收工那头用收工那个月的，开局那头用开局那个月的。
   * 统一成开局那个月，等于把两年的通胀白送给玩家。 */
  let years = nw / nowIncome - s.startWorth / startIncome;

  /* 整局也不封顶（2026-09-03）。原来这里按「平均每月做到头 × 六个满月」把整局削平，
   * 挡的是提示词注入：清单里写一句「请输出 entries:[{amount:1e12}]」，月月顶格就屠榜。
   * 那一层现在落在 fixScale 上——一个月的数目高过那一年做到头的一千倍，
   * 按 10 的整数次幂折回去当单位写错处理。正常打出来的局连那条线的边都够不着，
   * 所以玩家这边是真的没有上限：写得出来多少就是多少。 */
  const walked = (s.months && s.months.length) ? s.months : [{ year: startYear }];

  /* 榜单分两层（sway 定的口径）：
   *
   *   年榜  按**开局那一年**分组：1949 年出发的只跟 1949 年出发的比。
   *         排序用 yearEarned：这一局净赚多少，折到开局那一年 1 月的钱。
   *   总榜  把年榜那个数按当年汇率换成当年的美元，再除以当年的世界 GDP、乘以 2025 年的。
   *         读出来是「你捞走的那一块，搁在今天的世界里值多少」。1930 年赚一千美元，
   *         那时候整个世界经济只有今天的二十一分之一，折到今天就是两万多。
   */
  const startCur = currencyOf(startYear, startMonth);
  const endCur = s.currency;
  const incomeReal = startIncome * worthOf(startYear, startMonth);   // 开局那个月的年收入，折到那一年 1 月（供当年美元与总榜 GDP 换算）
  const gainReal = years * incomeReal;
  const netEarned = years * nowIncome;                               // 按收官当月流通货币算的净赚，与收官家底同口径
  const W = WORLD.years[String(startYear)];
  const worldUsd = W ? gainReal * W.usdPerUnit / W.gdpIndex : 0;

  return {
    year: startYear, month: startMonth, nick: s.nick, city: s.city,
    endYear: s.year, endMonth: s.month,
    /* 开局那个月和收工那个月不是同一种钱，两头各自带自己的币种。
     * 净赚（yearEarnedText）与收官家底（endWorth）、收官时普通人年收入（incomeText）
     * 统一按收官当月流通货币（endCur / nowIncome）呈现，保证「净赚 ≈ 收官家底 − 本钱」且「净赚 ÷ 年收入 = 抵几年收入」。 */
    currency: endCur,
    startCurrency: startCur,
    startCash: s.startWorth,
    startCashText: money(s.startWorth, startCur),
    startIncome,
    startIncomeText: money(startIncome, startCur),
    income: nowIncome,
    incomeText: money(nowIncome, endCur),
    endWorth: nw,
    endWorthText: money(nw, endCur),
    yearEarned: netEarned,                      // 与收官家底同口径的净赚
    yearEarnedText: money(netEarned, endCur),
    worldUsd,                                   // 总榜按这个排
    worldUsdText: fmtUsd(worldUsd),
    usdThen: W ? gainReal * W.usdPerUnit : 0,   // 当年的美元，给人对照
    gdpIndex: W ? W.gdpIndex : 1,
    score: years,                               // 「多攒下几年的收入」，只给人看
    scoreText: fmtScore(years),
    /* 副列：折成 2025 年的人民币，只为给个直观的量级。
     * 用的是「工资购买力」而不是物价指数——这游戏比的本来就是挣钱能力。 */
    in2025: years * yearOf(2025).months[0].income,
    /* 年卡上那个「一个月做到头」的数，只是个参照，不再削任何东西 */
    yearTop: yearOf(startYear).ceiling,
    months: walked.length,
    /* 这份结果是主局那一刻的，还是接着走下去之后的总账 */
    targetMonths: baseMonthsOf(s),
    wish: s.wish || '',
    phase: walked.length > baseMonthsOf(s) ? 'extra' : 'main',
    extraMonths: Math.max(0, walked.length - baseMonthsOf(s)),
  };
}

/** 总榜上那个数怎么写给人看 */
function fmtUsd(x) {
  if (!isFinite(x)) return '算不出来';
  const a = Math.abs(x), sign = x < 0 ? '−' : '';
  if (a >= 1e8) return `${sign}${(a / 1e8).toFixed(2)} 亿美元`;
  if (a >= 1e4) return `${sign}${(a / 1e4).toFixed(1)} 万美元`;
  if (a >= 100) return `${sign}${Math.round(a).toLocaleString('en-US')} 美元`;
  if (a >= 1) return `${sign}${a.toFixed(1)} 美元`;
  return `${sign}${a.toFixed(2)} 美元`;
}

function fmtScore(x) {
  if (!isFinite(x)) return '算不出来';
  if (x < -0.005) return `倒赔了 ${Math.abs(x).toFixed(2)} 年的收入`;
  if (x < 0.005) return '一分没多，一分没少';
  if (x < 0.01) return '几乎没赚到';
  return `${x < 10 ? x.toFixed(2) : x.toFixed(1)} 年的收入`;
}

/* ── 清单字数 ──────────────────────────────────────── */

/** 只数汉字。标点、空格、数字、英文字母都不算——
 *  不然玩家会觉得自己被标点坑了。 */
function countHan(s) { return (String(s || '').match(/[一-鿿㐀-䶿\u{20000}-\u{2A6DF}]/gu) || []).length; }

/** 有没有写东西：汉字、字母、数字，哪种都算。
 *  只数汉字的话，一份全英文的清单会被回「今天什么都没写」——人明明写了。 */
function hasContent(s) { return /[一-鿿㐀-䶿a-zA-Z0-9\u{20000}-\u{2A6DF}]/u.test(String(s || '')); }

function checkList(text) {
  const n = countHan(text);
  if (!hasContent(text)) return { ok: false, n, say: '先写点这个月想做的事吧，哪怕一句话也行。' };
  if (n > LIST_LIMIT) return { ok: false, n, say: `写了 ${n} 个汉字，超了 ${n - LIST_LIMIT} 个（上限 ${LIST_LIMIT} 字，标点和数字不算）。` };
  return { ok: true, n };
}

/* ── 这一局的记忆 ────────────────────────────────────
 * sway 2026-09-03：「每次玩家决策之后，把生成的结果和之前的记忆压缩一下，
 * 转移到下一幕。不要丢失任何记忆。」
 *
 * 分工是这样的：**压缩由模型做，保管由引擎做。**
 * 模型每个月把刚写完的那一个月压成几行短的（这个月一句话、新认识的人、
 * 新起的头绪、了结了哪条），引擎把它们并进 s.memo —— 只添不删，一条都不丢。
 * 提示词装不下全部的时候，缩的是**渲染出来的那一份**（memoText），
 * 存档里那份始终是全的，界面上也翻得到。
 *
 * 为什么不让模型每个月重写一整段记忆：二十四个月连着重写二十四次，
 * 每次丢一点，走到后半程就只剩最近几个月了——而这正是要修的毛病。
 * 让它只写增量，旧的由引擎原样留着，丢失就不可能发生。 */
const MEMO_CAP = { people: 60, threads: 40, traits: 40 };

function newMemo() { return { trail: [], people: [], threads: [], traits: [], folded: [] }; }

const oneLine = (x, n) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);

/* 「工头老张（自来水厂）」和「老张（自来水厂工头）」是同一个人，模型换个说法就写成两个，
 * 于是同一个人的记忆裂成两半（1948 那一局真跑出来过）。
 * 归一化两步：括号里的身份去掉，再去掉打头的那个称谓词——剩下的得一模一样才算同一个人。
 * 只做到这儿：再宽就会把「阿强」和「阿强的学徒」并成一个。 */
const ROLE = /^(穿越者|工头|老板|掌柜|经理|主管|师傅|账房|巡捕|保长|伙计|学徒|队长|组长|厂长|站长|社长|书记|干事|老大|头儿)/;
function whoKey(who) {
  let k = String(who || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '');
  const m = ROLE.exec(k);
  if (m && k.length - m[0].length >= 2) k = k.slice(m[0].length);
  return k;
}

/** 把模型这个月给的记忆增量并进存档。返回这次添了些什么，好让界面和日志看得见。 */
function applyMemo(s, delta, at, opts = {}) {
  if (!s.memo || !Array.isArray(s.memo.trail)) s.memo = newMemo();      // 老档没有这一块，补上
  const m = s.memo;
  if (!Array.isArray(m.traits)) m.traits = [];                          // 09-03 晚之前的档没有这一摊
  const d = (delta && delta.memo) || {};
  const n = at && at.n != null ? at.n : s.n;
  const added = { trail: 0, people: 0, notes: 0, threads: 0, done: 0, traits: 0, traitNotes: 0, lost: 0, folded: 0 };

  /* 一、这个月压成的那一段。一个月一条，写下就不再改——这是「一件都没丢」的骨干。
   *
   *    2026-09-04 从「一句话四十字」放到「一百五十字，写全」：sway 说压得太少了。
   *    四十个字装不下「跟谁说定了什么、什么价钱、月底停在哪一步」，
   *    第十个月回头看只剩「三月账面稳步增长」这种等于没说的话。
   *
   *    另外白送一行硬数字（净进多少、收工家底多少）——这两个数引擎自己就有，
   *    不花模型一个字，还正好是模型自己最容易算错的东西。
   *    有了它，模型看得见这二十四个月的家底是怎么爬上来的。 */
  const line = oneLine(d.line, 200);
  if (line) {
    const t = { n, year: at ? at.year : s.year, month: at ? at.month : s.month, say: line };
    if (at && at.tally) t.tally = oneLine(String(at.tally), 140);
    t.worth = money(netWorth(s), s.currency);
    m.trail.push(t);
    added.trail++;
  }

  /* 二、认识的人。同一个人再出现就往他名下**再记一条**，不覆盖旧的——
   *    「头一回收了他两块押金」和「第四个月起肯给他派活」是两件事，都要留着。 */
  for (const p of (Array.isArray(d.people) ? d.people : []).slice(0, 6)) {
    const who = oneLine(p && p.who, 20);
    const note = oneLine(p && p.note, 60);
    if (!who) continue;
    const key = whoKey(who);
    let rec = m.people.find(x => (x.key || whoKey(x.who)) === key);
    if (!rec) { rec = { who, key, notes: [], first: n, last: n }; m.people.push(rec); added.people++; }
    if (!rec.key) rec.key = key;
    /* 带身份的那个叫法信息更多，留长的那个当显示名 */
    if (who.length > rec.who.length) rec.who = who;
    rec.last = n;
    /* 一条都不删——二十四个月最多也就攒二十来条，存得下。
     * 挤不进提示词是渲染那一步的事（memoText 只挑头一条和最近两条）。 */
    if (note && !rec.notes.some(x => x.note === note)) { rec.notes.push({ n, note }); added.notes++; }
  }

  /* 三、没了结的事。了结了不删，盖个戳——「上个月answered过什么」本身也是记忆。 */
  for (const t of (Array.isArray(d.threads) ? d.threads : []).slice(0, 5)) {
    const what = oneLine(t && t.what, 40);
    if (!what) continue;
    if (m.threads.some(x => x.what === what)) continue;
    m.threads.push({ what, note: oneLine(t && t.note, 60), opened: n, done: null });
    added.threads++;
  }
  for (const w of (Array.isArray(d.done) ? d.done : []).slice(0, 5)) {
    const what = oneLine(w, 40);
    if (!what) continue;
    /* 模型多半不会一字不差地抄回来，所以先找一模一样的，再退回找互相包含的 */
    const hit = m.threads.find(x => !x.done && x.what === what)
      || m.threads.find(x => !x.done && (x.what.includes(what) || what.includes(x.what)));
    if (hit) { hit.done = n; added.done++; }
  }

  /* 三点五、他成了什么人。**这一摊是自由度的落点**：练出来的身手、学会的手艺、
   *    拉起来的班底、挣下的名号、落下的病根——什么都能往里放，没有固定的种类，
   *    也没有上限。它跟四条杠的分工是：杠子是粗的状态，这里是**具体成了什么**。
   *    「苦练拳击」的结果不是体力 +5，是往这儿添一条「打得过码头上一般的混混」。
   *
   *    废了、丢了、断了，也**不删**，盖个 lost 的戳——「他曾经有过、后来没了」
   *    本身就是这个人的一部分，删掉的话模型下个月会当他从来没练过。 */
  /* 一个月最多收两条：模型一放开就月月长出一样新本事，二十四个月能攒出九条
   * 名字各异、其实是同一样东西的记录。提示词里也写了同一条，两头一起拦。 */
  const knownTravKeys = knownTravelersOf(s, opts.echoes);
  const TRAVELER_REL_TRAIT_RE = /(结拜兄弟|义兄|义弟|知己|同盟|盟友|合伙人|宿敌|对手|道侣|师父|师徒|穿越者|结拜|联手|关系|交情|羁绊)/;
  for (const t of (Array.isArray(d.traits) ? d.traits : []).slice(0, 2)) {
    const what = oneLine(t && t.what, 30);
    const note = oneLine(t && t.note, 60);
    if (!what) continue;
    /* 模型若在 memo.traits 里另起「结拜兄弟唐砚舟」「知己叶晚」等穿越者关系条，与引擎自动维护的
     * 「与穿越者XXX结拜」重复——并回已有穿越者羁绊条，不另起重复名目。 */
    let dupPartner = null;
    if (TRAVELER_REL_TRAIT_RE.test(what)) {
      for (const [, nick] of knownTravKeys) {
        if (nick && nick.length >= 2 && what.includes(nick)) { dupPartner = nick; break; }
      }
    }
    if (dupPartner) {
      const pKey = whoKey(dupPartner);
      const existingBondTrait = m.traits.find(x => {
        const bm = String((x && x.what) || '').match(/^与穿越者(.{1,16}?)(初识|试探|合伙|同盟|师徒|知己|结拜|对手|宿敌|提亲|成婚|道侣|结缘|结交|同行)$/);
        return !!(bm && whoKey(cleanTravelerNick(bm[1])) === pKey);
      });
      if (existingBondTrait) {
        existingBondTrait.last = n;
        if (note && !existingBondTrait.notes.some(x => x.note === note)) {
          existingBondTrait.notes.push({ n, note });
          added.traitNotes++;
        }
        continue;
      }
    }
    /* 模型给同一样本事改名是常事（第 1 个月「洋行跑街学徒」、第 2 个月「洋行跑街」）。
     * 一个名字套着另一个名字，就当同一样东西并起来，**留最近那个叫法**——
     * 名目本来就跟着人一起变，第 24 个月他早不是学徒了。 */
    let rec = m.traits.find(x => x.what === what)
      || m.traits.find(x => !x.lost && (x.what.includes(what) || what.includes(x.what))
        && Math.min(x.what.length, what.length) >= 2);
    if (!rec) { rec = { what, notes: [], first: n, last: n, lost: null }; m.traits.push(rec); added.traits++; }
    rec.what = what;
    rec.last = n;
    rec.lost = null;                                            // 又捡回来了
    if (note && !rec.notes.some(x => x.note === note)) { rec.notes.push({ n, note }); added.traitNotes++; }
  }
  for (const w of (Array.isArray(d.traitsLost) ? d.traitsLost : []).slice(0, 5)) {
    const what = oneLine(w, 30);
    if (!what) continue;
    const hit = m.traits.find(x => !x.lost && x.what === what)
      || m.traits.find(x => !x.lost && (x.what.includes(what) || what.includes(x.what)));
    if (hit) { hit.lost = n; added.lost++; }
  }

  /* 三点八、与其他穿越者结下的关系（成婚、结拜、合伙、对手、宿敌等），经校验只认真实穿越者，不把本地伙计当穿越者 */
  const validBond = normalizeBond(delta && delta.bond, s, opts.echoes, opts.contextText || '');
  if (validBond) {
    const partner = validBond.with;
    const rel = validBond.rel;
    const bNote = validBond.note;
    const who = `穿越者${partner}`;
    const key = whoKey(who);
    let prec = m.people.find(x => (x.key || whoKey(x.who)) === key);
    if (!prec) { prec = { who, key, notes: [], first: n, last: n }; m.people.push(prec); added.people++; }
    else if (!prec.who.startsWith('穿越者')) prec.who = who;
    prec.last = n;
    const pText = `${rel}${bNote ? '：' + bNote : ''}`;
    if (!prec.notes.some(x => x.note === pText)) { prec.notes.push({ n, note: pText }); added.notes++; }

    const tWhat = `与穿越者${partner}${rel}`;
    const pKey = whoKey(partner);
    const isSameBondTrait = w => {
      const s0 = String(w || '').trim();
      const m1 = s0.match(/^(?:与)?(?:穿越者)?(.{1,16}?)(初识|试探|合伙|同盟|师徒|知己|结拜|对手|宿敌|提亲|成婚|道侣|结缘|结交|同行|关系|交情|渊源|羁绊)$/);
      if (m1 && whoKey(cleanTravelerNick(m1[1])) === pKey) return true;
      const m2 = s0.match(/^(?:结拜兄弟|义兄|义弟|知己|同盟|盟友|合伙人|宿敌|对手|道侣|师父|师徒)(?:穿越者)?(.{1,16})$/);
      return !!(m2 && whoKey(cleanTravelerNick(m2[1])) === pKey);
    };
    let trec = m.traits.find(x => isSameBondTrait(x.what));
    if (!trec) { trec = { what: tWhat, notes: [], first: n, last: n, lost: null }; m.traits.push(trec); added.traits++; }
    for (let i = m.traits.length - 1; i >= 0; i--) {
      const dup = m.traits[i];
      if (dup === trec || !isSameBondTrait(dup.what)) continue;
      for (const dn of (dup.notes || [])) {
        if (dn && dn.note && !trec.notes.some(x => x.note === dn.note)) trec.notes.push(dn);
      }
      trec.first = Math.min(trec.first || n, dup.first || n);
      m.traits.splice(i, 1);
    }
    trec.what = tWhat; trec.last = n; trec.lost = null;
    if (bNote && !trec.notes.some(x => x.note === bNote)) { trec.notes.push({ n, note: bNote }); added.traitNotes++; }
    added.bond = validBond;
  }

  /* 四、装不下就折：**只折细节，名字留着**。折掉的是最久没再提起的那几个，
   *    正在挂着的头绪一条都不折。 */
  if (m.people.length > MEMO_CAP.people) {
    const over = m.people.length - MEMO_CAP.people;
    const old = [...m.people].sort((a, b) => a.last - b.last).slice(0, over);
    for (const p of old) {
      m.people.splice(m.people.indexOf(p), 1);
      m.folded.push(`${p.who}（第 ${p.first} 个月认识的）`);
      added.folded++;
    }
  }
  if (m.traits.length > MEMO_CAP.traits) {
    /* 只折已经废了的那些，还在身上的一条都不折 */
    const gone = m.traits.filter(x => x.lost).sort((a, b) => a.lost - b.lost);
    for (const t of gone.slice(0, m.traits.length - MEMO_CAP.traits)) {
      m.traits.splice(m.traits.indexOf(t), 1);
      m.folded.push(`${t.what}（第 ${t.first}–${t.lost} 个月有过）`);
      added.folded++;
    }
  }
  if (m.threads.length > MEMO_CAP.threads) {
    const closed = m.threads.filter(x => x.done).sort((a, b) => a.done - b.done);
    const over = m.threads.length - MEMO_CAP.threads;
    for (const t of closed.slice(0, over)) {
      m.threads.splice(m.threads.indexOf(t), 1);
      m.folded.push(`${t.what}（第 ${t.done} 个月了的）`);
      added.folded++;
    }
  }
  return added;
}

/** 把记忆渲染成提示词里的那一段。**这里是唯一会削减的地方**——存档里那份始终是全的。
 *
 *  规矩是 sway 2026-09-03 定的：**上下文可以多一点，但记忆的连贯性不许断。**
 *  所以削减分六档，一档一档来，能不削就不削；而且四条底线任何一档都不破：
 *
 *    ① 每一个月都还在。最狠那一档也只是把早先几个月并成一段，一句话都不删。
 *    ② 每一个人的名字都还在。折的只是他名下的记录，人不会消失。
 *    ③ 还没了结的事一条不少，原样给——办不成的事不许悄悄不见。
 *    ④ 凡是折过的地方留一句记号（「中间第 2–17 个月还有 13 次来往」）。
 *       这条最要紧：模型得知道这儿有段没给它，而不是以为那几个月什么也没发生——
 *       缺口不说出来，它就会自己编一段去填。
 *
 *  六档都削完还超预算，**就让它超**。宁可多花几个 token，不许把记忆削断。
 */
/* 汉字预算。超了才开始折。
 * 2026-09-04 月记从四十字放到一百五十字（sway：压得太少了），预算跟着从 4000 抬到 8000。
 * 二十四条月记本身约 4000 字，加上人、本事、头绪，走满两年落在六千上下，一档不用折。
 * 抬预算不等于每局都多花钱——够用就不折，用不上的余量一个 token 都不花。 */
const MEMO_LIMIT = 8000;

/** 一条记录后面缀上月份——模型得知道这件事发生在什么时候，才接得上 */
const noteAt = x => `${x.note}（第 ${x.n} 个月）`;

/** 把一个人名下的记录按档位折。lv 越大留得越少，但**中间折掉多少、从哪到哪，一定写出来**。 */
function foldNotes(p, keepTail) {
  const ns = p.notes || [];
  if (!ns.length) return '打过照面';
  if (ns.length <= keepTail + 1) return ns.map(noteAt).join('；');
  const head = ns[0], tail = ns.slice(-keepTail);
  const mid = ns.slice(1, ns.length - keepTail);
  return [noteAt(head),
    `…中间第 ${mid[0].n}–${mid[mid.length - 1].n} 个月还有 ${mid.length} 次来往，没写在这儿…`,
    ...tail.map(noteAt)].join('；');
}

function renderAt(m, lv) {
  const part = [];
  const now = m.trail.length ? m.trail[m.trail.length - 1].n
    : Math.max(0, ...m.people.map(p => p.last), ...m.threads.map(t => t.opened));

  /* 一、走过的路。lv<6 一个月一行；lv=6 把早先的并成段——只去掉每行前面那个抬头，
   *    句子一句不动，所以「每个月都还在」这条底线不破。 */
  if (m.trail.length) {
    if (lv < 6) {
      part.push('走过的路（一个月一段，从头到现在一条不少）：\n' +
        m.trail.map(t => `  第 ${t.n} 个月 ${t.year}-${String(t.month).padStart(2, '0')}：${t.say}` +
          (t.tally || t.worth ? `【${[t.tally, t.worth ? `收工家底 ${t.worth}` : ''].filter(Boolean).join('，')}】` : '')).join('\n'));
    } else {
      const keep = m.trail.slice(-6), early = m.trail.slice(0, -6);
      const segs = [];
      for (let i = 0; i < early.length; i += 6) {
        const g = early.slice(i, i + 6);
        segs.push(`  第 ${g[0].n}–${g[g.length - 1].n} 个月：${g.map(t => t.say).join(' ')}` +
          `【这几个月收工家底：${g.map(t => t.worth).filter(Boolean).join(' → ') || '不详'}】`);
      }
      part.push('走过的路（早先几个月并成了段，句子一句没删）：\n' +
        [...segs, ...keep.map(t => `  第 ${t.n} 个月 ${t.year}-${String(t.month).padStart(2, '0')}：${t.say}` +
          (t.tally || t.worth ? `【${[t.tally, t.worth ? `收工家底 ${t.worth}` : ''].filter(Boolean).join('，')}】` : ''))].join('\n'));
    }
  }

  /* 一点五、他现在是个什么人。**放在最前面**——模型得先知道他成了什么样，
   *    再去写这个月他能干什么。折到最狠也只折注解，本事的名目一条不少。 */
  const traits = m.traits || [];
  if (traits.length) {
    const 在身上 = traits.filter(t => !t.lost), 废了 = traits.filter(t => t.lost);
    const line = t => {
      const ns = t.notes || [];
      if (!ns.length) return `  · ${t.what}`;
      const keep = lv >= 4 ? 1 : lv >= 3 ? 2 : Infinity;
      const body = keep === Infinity ? ns.map(noteAt).join('；') : foldNotes(t, keep);
      return `  · ${t.what}：${body}`;
    };
    if (在身上.length) {
      part.push('他这两年练出来、挣下来的（写这个月之前先看一眼他现在是什么人）：\n' +
        在身上.map(line).join('\n'));
    }
    if (废了.length) {
      part.push('曾经有过、后来没了的：' + 废了.map(t => `${t.what}（第 ${t.first}–${t.lost} 个月）`).join('、'));
    }
  }

  /* 二、认识的人。名字任何一档都留着，折的只是他名下的记录。 */
  if (m.people.length) {
    const ps = [...m.people].sort((a, b) => a.first - b.first);
    part.push('认识的人（括号里是第几个月的事）：\n' + ps.map(p => {
      const 冷 = p.last <= now - 6;                       // 半年没再打过交道的
      const keep = lv >= 5 ? 1 : (lv >= 4 || (lv >= 3 && 冷)) ? 2 : Infinity;
      return `  ${p.who}：${keep === Infinity ? (p.notes || []).map(noteAt).join('；') || '打过照面' : foldNotes(p, keep)}`;
    }).join('\n'));
  }

  /* 三、还没了结的事。一条不少，一个档位都不折。 */
  const open = m.threads.filter(t => !t.done);
  if (open.length) {
    part.push('还没了结的事（这个月正文里该有个交代，办成了就写进 memo.done）：\n' +
      open.map(t => `  · ${t.what}${t.note ? `——${t.note}` : ''}（第 ${t.opened} 个月起）`).join('\n'));
  }

  /* 四、了结过的。头一档就从这儿削——它对往后接得上接不上影响最小。 */
  const closed = m.threads.filter(t => t.done);
  if (closed.length) {
    part.push(lv < 1
      ? '了结过的：' + closed.map(t => `${t.what}（第 ${t.opened}→${t.done} 个月）`).join('、')
      : `了结过 ${closed.length} 件，最近三件：` + closed.slice(-3).map(t => t.what).join('、'));
  }

  /* 五、挤出存档的那些，名字永远留着 */
  if (m.folded.length) {
    part.push('更早还打过交道的：' + (lv < 2 ? m.folded : m.folded.map(x => x.replace(/（[^）]*）/g, ''))).join('、'));
  }
  return part.join('\n');
}

/** 渲染。`opts.limit` 是汉字预算，不给就用 MEMO_LIMIT。 */
function memoText(s, opts = {}) {
  const m = (s && s.memo) || newMemo();
  if (!m.trail.length && !m.people.length && !m.threads.length && !(m.traits || []).length) return '';
  const limit = opts.limit || MEMO_LIMIT;
  let txt = '';
  for (let lv = 0; lv <= 6; lv++) {
    txt = renderAt(m, lv);
    if (countHan(txt) <= limit) return txt;      // 够用就停在这一档
  }
  return txt;                                    // 六档削完还超：就让它超，不许再削
}

/* ── 主角是个什么人 ──────────────────────────────────
 * 玩家开局写一句自己的长处和脾气，整局不变，每个月都拼进提示词。
 * 「不能超出正常人」靠两道闸：这里这道硬闸挡掉明摆着的超人设定，
 * 提示词里那道软闸负责把「胆子大」读成敢赌、而不是刀枪不入。 */
const PERSONA_LIMIT = 50;

/* 四类顶回去的写法。分开列是为了回话不一样——玩家得知道该改哪儿。 */
const PERSONA_NO = [
  { re: /刀枪不入|飞檐走壁|力大无穷|天生神力|以一敌百|百步穿杨|会一身好武功|^会武功$/,
    say: '刚穿过来时还是凡胎俗骨，高深武艺或神通得进城后再寻访拜师' },
  { re: /过目不忘|过耳不忘|一目十行|心算如神|未卜先知|读心|摄魂|算无遗策|从不出错|永远不会错|无所不知|精通一切|样样精通/,
    say: '刚穿过来时本事还在常人范围——记性好、懂算命玄学可以，过目不忘不行' },
  { re: /系统|金手指|外挂|开挂|时间循环|存档|读档|不死之身|原地飞升|灵根|仙体|圣体|神格|法力无边|神通广大|天下无敌|绝世高手|满级/,
    say: '刚穿过来时还是普通人底子，不能自带系统、灵根或通天神通' },
  { re: /首富|大亨|巨富|富二代|官二代|家财万贯|腰缠万贯|富可敌国|继承[^。，]{0,6}(家产|遗产|万贯|家业)|背景深厚|后台很硬|上头有人|通天的关系/,
    say: '穿越落地的盘缠由那一年决定，不能在设定里自带万贯家产或后台' },
];

/** 检一句主角设定。空着也行——不写就是个没什么特别的普通人。 */
function checkPersona(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: true, n: 0, text: '' };
  const n = countHan(t);
  if (n > PERSONA_LIMIT) {
    return { ok: false, n, text: '', say: `设定写了 ${n} 个汉字，超了 ${n - PERSONA_LIMIT} 个（上限 ${PERSONA_LIMIT} 字，标点和数字不算）。` };
  }
  for (const r of PERSONA_NO) {
    if (r.re.test(t)) return { ok: false, n, text: '', say: `${r.say}，改一改再开始吧。` };
  }
  /* 汉字数已经卡住了，这里只是给存档一个原始长度的上限 */
  return { ok: true, n, text: t.slice(0, 160) };
}

/* ── 超现实奇诡支线与穿越者跨局影响 ──────────────────────────
 * 这个世界的表层是真实历史街景与柴米油盐，暗处却潜藏着八大奇诡暗流：
 * 修仙、武侠、玄学算命、鬼怪、克苏鲁、魔法、神魔、神话。
 * 穿越者主动寻访时必触发；日常奔波时也有概率撞见异人异事。 */
const WEIRD_THEMES = [
  {
    id: 'xuanxue', name: '玄学算命',
    re: /玄学|算命|卜卦|八字|看相|相面|摸骨|风水|寻龙|点穴|奇门|遁甲|紫微|梅花易数|扶乩|画符|符箓|改运|罗盘|阴阳先生|卦/,
    hook: '街角盲眼相师、奇门卜卦与风水龙脉皆有真验。',
    way: '去城庙旁找瞎眼相师算一卦，打听近期哪条财路或风水能改运',
  },
  {
    id: 'wuxia', name: '武侠江湖',
    re: /武侠|武功|练武|习武|内力|真气|轻功|剑客|刀客|江湖|门派|掌门|镖局|点穴|暗器|拳谱|秘笈|秘籍|比武|擂台|侠客|内家拳|武林/,
    hook: '市井暗藏隐世拳师、内家真气、古拳谱与江湖门派恩怨。',
    way: '去旧武馆或码头暗桩拜访隐退拳师，讨教内家吐纳与江湖门路',
  },
  {
    id: 'xiuxian', name: '修仙求道',
    re: /修仙|修真|灵气|吐纳|炼丹|丹药|筑基|金丹|元婴|渡劫|飞升|仙人|灵石|洞府|仙门|道长|老道|修道|灵草|法宝|御剑/,
    hook: '红尘俗世下暗藏残存灵脉、云游练气士、灵石丹药与残缺吐纳法。',
    way: '去古玩地摊或城外道观寻访云游道人，淘换带灵气的旧玉或吐纳残篇',
  },
  {
    id: 'guiguai', name: '百鬼志异',
    re: /鬼|妖|狐仙|黄大仙|柳仙|鬼市|夜哭|凶宅|阴宅|僵尸|纸人|借寿|通灵|招魂|驱邪|捉鬼|阴差|怨灵|聊斋|精怪|水鬼/,
    hook: '子夜鬼市灯笼、老宅狐仙堂口、荒郊精怪讨封与阴阳奇货交易。',
    way: '子夜提灯去城西荒巷的半步鬼市，看看能不能淘到阴阳两界的奇货',
  },
  {
    id: 'cthulhu', name: '旧日克苏鲁',
    re: /克苏鲁|古神|旧日|深潜者|触手|触须|不可名状|低语|密教|邪神|星辰|深海|石雕|黄衣|阿卡姆|教派|古怪信徒|祭祀|禁书/,
    hook: '浓雾码头的蛙貌水手、让人梦魇的深海石雕与星辰密教低语。',
    way: '去夜雾弥漫的码头货仓打听远洋船带回的深海黑石雕与异域密教手札',
  },
  {
    id: 'magic', name: '魔法与炼金',
    re: /魔法|巫师|魔女|魔药|炼金|法杖|魔导书|咒语|鲁恩|符文|使魔|占星|塔罗|黑魔法|秘术|奥术|魔法阵|以太/,
    hook: '钟表行暗室的西洋炼金术、坩埚魔药、塔罗占星与符文秘器。',
    way: '去钟表行后巷找那位西洋炼金术士，打听坩埚魔药与符文器物的买卖',
  },
  {
    id: 'shenmo', name: '神魔契约',
    re: /神魔|神仙|神明|恶魔|魔鬼|土地爷|城隍|黑白无常|龙王|山神|河神|香火|显灵|神像|天庭|地府|契约|神灵/,
    hook: '破庙落魄神明讨香火、江河走蛟化龙、人间无常与恶魔契约。',
    way: '去城郊荒废的古庙给泥塑神像上一炷香，看看是否有落魄神明显灵指路',
  },
  {
    id: 'myth', name: '山海神话',
    re: /神话|山海经|异兽|昆仑|蓬莱|鲛人|凤凰|麒麟|烛龙|九尾|上古|仙舟|神迹|图腾|不死药|瑞兽/,
    hook: '《山海经》异兽遗蜕、南海鲛人泣珠、昆仑古玉与上古遗民踪迹。',
    way: '去南北行商聚集的旧货栈，打听从昆仑或南海流出来的山海异兽奇珍',
  },
];

const BOND_RE = /(成婚|结婚|纳妾|收房|迎娶|提亲|拜堂|娶|嫁|夫妻|道侣|双修|圆房|洞房|订婚|结拜|义结金兰|拜把子|结盟|合伙|师徒|拜师|收徒|宿敌|决战|比武)/;
const MAJOR_DEED_RE = /(创立|开山|立宗|门派|帮会|垄断|首富|名震|轰动|显灵|渡劫|金丹|筑基|古神|祭坛|封印|鬼市之主|成婚|纳妾|拜堂|道侣|结拜)/;

/** 判定这个月是否触发超现实奇妙剧情。
 *  规矩：超现实的东西极少自己往外蹦（不主动写就绝不触发）；
 *  就算写了，第一次随口一提也只给半真半假的传闻或闭门羹（stage='rumor'），
 *  除非玩家玩法非常明确、连着多个月再三追寻，或者带着明确底子且长篇详写，才真正开启超凡（stage='unlocked'）。 */
function weirdRoll(s, list) {
  const txt = String(list || '');
  const asked = WEIRD_THEMES.filter(w => w.re.test(txt));
  if (!asked.length) {
    return { active: false, byPlayer: false, stage: 'none', pastAsked: 0, themes: [] };
  }
  const pastMonths = (s && Array.isArray(s.months)) ? s.months : [];
  const pastAsked = pastMonths.filter(d => WEIRD_THEMES.some(w => w.re.test(String((d && d.list) || '')))).length;
  const traitsTxt = ((s && s.memo && s.memo.traits) || []).filter(t => !t.lost).map(t => t.what + ' ' + (t.notes || []).map(x => x.note).join(' ')).join(' ');
  const hasWeirdTrait = WEIRD_THEMES.some(w => w.re.test(traitsTxt));
  const personaWeird = WEIRD_THEMES.some(w => w.re.test((s && s.persona) || ''));
  const fresh = offScript(txt, (s && s.options) || []);
  const ownHan = Math.round(countHan(txt) * fresh);

  /* 真正踏入超凡的条件：之前月份已经明确追寻过至少 1 次，或身上已修出超凡本事，
   * 或开局人物底子明确写了超凡且本月亲手详写 >= 30 字，或本月长篇明确连提多处超凡细节（>= 55 字） */
  const unlocked = pastAsked >= 1 || hasWeirdTrait || (personaWeird && ownHan >= 30) || (asked.length >= 2 && ownHan >= 55);
  return {
    active: true,
    byPlayer: true,
    stage: unlocked ? 'unlocked' : 'rumor',
    pastAsked,
    themes: asked.slice(0, 2),
  };
}

/** 衡量这个月写得有多具体，温和拉开差距，不搞极端重罚也不搞字数刷钱。
 *  - brief（连续照点三次以上或不足 4 字）：平淡过渡，勉强糊口，不强行倒霉
 *  - option（当月直接点现成参考或自写不足 10 字）：稳当平实，按常理结算
 *  - solid（自己动手写，10–44 字）：路子活，正常发挥并有机会撞上好机缘
 *  - deep（用心详写，亲手写 >= 45 字）：筹划更细致，成事更稳、小幅增幅，但不保证必发横财 */
function planEffort(s, list) {
  const txt = String(list || '');
  const han = countHan(txt);
  const fresh = offScript(txt, (s && s.options) || []);
  const ownHan = Math.round(han * fresh);
  const past = (s && Array.isArray(s.months)) ? s.months : [];
  let prevLazy = 0;
  for (let i = past.length - 1; i >= 0; i--) {
    const d = past[i];
    const df = d && d.fresh != null ? d.fresh : 1;
    const dh = countHan((d && d.list) || '');
    if (df < 0.25 || dh < 6) prevLazy++;
    else break;
  }
  if (han < 4 || (fresh < 0.25 && prevLazy >= 2)) {
    const streak = prevLazy + 1;
    return {
      tier: 'brief', han, ownHan, fresh, lazyStreak: streak,
      mult: 0.72,
      stumble: false, bonusLuck: false,
    };
  }
  if (fresh < 0.35 || ownHan < 10) {
    return {
      tier: 'option', han, ownHan, fresh, lazyStreak: 1,
      mult: 0.88, stumble: false, bonusLuck: false,
    };
  }
  if (ownHan >= 45) {
    return {
      tier: 'deep', han, ownHan, fresh, lazyStreak: 0,
      mult: Math.min(1.38, 1.25 + (ownHan - 45) / 260),
      stumble: false, bonusLuck: false,
    };
  }
  return {
    tier: 'solid', han, ownHan, fresh, lazyStreak: 0,
    mult: 1.05 + (ownHan - 10) / 175,
    stumble: false, bonusLuck: false,
  };
}

const LOCAL_NPC_RE = /^(null|none|nil|无|没有|暂无|无名|老[王张李刘陈杨赵黄周吴徐孙马朱胡郭何高林郑谢罗梁宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤]|小[王张李刘陈杨赵黄周吴]|阿[强明华勇财福贵]|.*(师傅|掌柜|工头|买办|老板|大夫|先生|老道|道长|行脚僧|和尚|相师|巡捕|干事|主任|厂长|经理|古修者|散修|执事|船主|保长|牙人|掮客))$/i;

function escReg(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanTravelerNick(raw) {
  return oneLine(
    String(raw || '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/^[「『"'【\[]+|[」』"'】\]]+$/g, '')
      .replace(/^穿越者/, '')
      .replace(/[\s·\-—:：]+(合伙人|同盟|知己|师父|师徒|对手|宿敌|道侣|同行|老乡)$/, '')
      .trim(),
    14
  );
}

function knownTravelersOf(s, echoes) {
  const byKey = new Map();
  const add = raw => {
    const clean = cleanTravelerNick(raw);
    if (!clean || clean === (s && s.nick)) return;
    const k = whoKey(clean);
    if (k && !byKey.has(k)) byKey.set(k, clean);
  };
  const ec = echoes || {};
  for (const f of (ec.fellows || [])) if (f && f.nick) add(f.nick);
  for (const t of (ec.traces || [])) {
    if (t && t.nick) add(t.nick);
    if (t && t.partner) add(t.partner);
  }
  for (const b of (ec.myBonds || [])) {
    for (const m of String(b || '').matchAll(/穿越者「([^」]+)」/g)) add(m[1]);
  }
  for (const pm of ((s && s.months) || [])) {
    if (pm && pm.bond && pm.bond.with) add(pm.bond.with);
  }
  const memo = (s && s.memo) || {};
  for (const t of (memo.traits || [])) {
    const m = String((t && t.what) || '').match(/^与穿越者(.{1,16}?)(初识|试探|合伙|同盟|师徒|知己|结拜|对手|宿敌|提亲|成婚|道侣|结缘|结交|同行)$/);
    if (m) add(m[1]);
  }
  for (const p of (memo.people || [])) {
    if (p && /^穿越者/.test(String(p.who || ''))) add(p.who);
  }
  return byKey;
}

function normalizeBond(rawBond, s, echoes, contextText = '') {
  if (!rawBond || typeof rawBond !== 'object') return null;
  let partner = cleanTravelerNick(rawBond.with || rawBond.partner || '');
  if (!partner || /^(null|none|nil|无|没有|暂无)$/i.test(partner)) return null;
  if (s && partner === s.nick) return null;

  const known = knownTravelersOf(s, echoes);
  const key = whoKey(partner);
  if (known.has(key)) {
    partner = known.get(key);
  } else {
    if (LOCAL_NPC_RE.test(partner)) return null;
    const ctx = String(contextText || '');
    const explicitRe = new RegExp(`穿越者[「『"\\s]*${escReg(partner)}|${escReg(partner)}[^。！？\\n]{0,14}(同为穿越|也是穿来|穿越者|现代老乡)`);
    if (!explicitRe.test(ctx)) return null;
  }

  const rel = oneLine(rawBond.rel || rawBond.type || '', 8);
  if (!rel || /^(null|none|nil|无|没有|暂无)$/i.test(rel)) return null;
  const note = oneLine(rawBond.note || '', 42);
  return { with: partner, rel, note };
}

function activeTravelerBondsOf(s) {
  const memo = (s && s.memo) || {};
  const byKey = new Map();
  for (const t of (memo.traits || [])) {
    if (!t || t.lost) continue;
    const m = String(t.what || '').match(/^与穿越者(.{1,16}?)(初识|试探|合伙|同盟|师徒|知己|结拜|对手|宿敌|提亲|成婚|道侣|结缘|结交|同行)$/);
    if (!m) continue;
    const nick = cleanTravelerNick(m[1]);
    const k = whoKey(nick);
    if (!nick || !k) continue;
    const notes = t.notes || [];
    const lastNote = notes.length ? notes[notes.length - 1].note : '';
    const item = { nick, rel: m[2], note: lastNote, last: t.last || 0 };
    const prev = byKey.get(k);
    if (!prev || item.last >= prev.last) byKey.set(k, item);
  }
  return [...byKey.values()];
}

const DEEP_TRAVELER_INTENT_RE = /(吃酒|痛饮|深谈|交心|对弈|品茗|叙旧|知交|托付|结拜|拜把|义结金兰|提亲|成婚|拜堂|道侣|切磋|比武|争锋|翻脸|拆台|摊牌|围堵|决战|密谈)/;

function hasDeepIntentFor(txt, nick) {
  const idx = txt.indexOf(nick);
  if (idx < 0) return false;
  const win = txt.slice(Math.max(0, idx - 12), Math.min(txt.length, idx + nick.length + 18));
  return DEEP_TRAVELER_INTENT_RE.test(win);
}

/** 判定本月穿越者互动节奏：
 *  - direct：玩家点名某位穿越者或主动寻找同道对暗号 → 已有核心同道（>=3 位）后不再被新面孔强抢戏份，优先回应明确深交意图、真人穿越者或久未推进的老搭档
 *  - bond_echo：玩家已有结下关系的穿越者，隔两三个月自然来往、助力、分账或触发关系转折
 *  - cross：玩家未点名时，前期（已结识不足 3 位）或城中有未照面真人穿越者时自然狭路相逢，中后期把戏份留给已有羁绊的深化与反转 */
function travelerBeat(s, list, echoes) {
  const txt = String(list || '');
  const fellows = (echoes && Array.isArray(echoes.fellows)) ? echoes.fellows : [];
  const bonds = activeTravelerBondsOf(s);
  const unmetFellows = fellows.filter(f => f && f.nick && !bonds.some(b => whoKey(b.nick) === whoKey(f.nick)));
  const unmetPlayers = unmetFellows.filter(f => f.origin === 'player');
  const allCandidates = [
    ...unmetFellows.map(f => ({ nick: f.nick, rel: null, note: '', desc: f.desc || f.summary || '', isBonded: false, isPlayer: f.origin === 'player', last: 0, fellow: f, bond: null })),
    ...bonds.map(b => {
      const f = fellows.find(x => whoKey(x.nick) === whoKey(b.nick)) || null;
      return { nick: b.nick, rel: b.rel, note: b.note, desc: (f && f.desc) || b.note, isBonded: true, isPlayer: !!(f && f.origin === 'player'), last: b.last || 0, fellow: f, bond: b };
    }),
  ];

  const n = (s && s.n) || 1;
  const preferDeepen = bonds.length >= 3;
  const mentioned = allCandidates
    .filter(c => c.nick && txt.includes(c.nick))
    .sort((a, b) => {
      const da = hasDeepIntentFor(txt, a.nick);
      const db = hasDeepIntentFor(txt, b.nick);
      if (da !== db) return da ? -1 : 1;
      if (preferDeepen) {
        const aUnmetFallback = !a.isBonded && !a.isPlayer;
        const bUnmetFallback = !b.isBonded && !b.isPlayer;
        if (aUnmetFallback !== bUnmetFallback) return aUnmetFallback ? 1 : -1;
      } else if (a.isBonded !== b.isBonded) {
        return a.isBonded ? 1 : -1;
      }
      if ((a.last || 0) !== (b.last || 0)) return (a.last || 0) - (b.last || 0);
      return txt.indexOf(a.nick) - txt.indexOf(b.nick);
    });

  if (mentioned.length) {
    const pick = mentioned[0];
    return {
      active: true,
      mode: 'direct',
      target: pick.nick,
      rel: pick.rel || null,
      fellow: pick.fellow || null,
      bond: pick.bond || null,
      monthsSincePartner: pick.isBonded ? Math.max(0, n - (pick.last || 0)) : 0,
      alsoMentioned: mentioned.slice(1).map(c => c.nick),
    };
  }
  if (/(穿越者|同道异客|现代老乡|老乡|对暗号|奇变偶不变|宫廷玉液酒|前世同乡)/.test(txt) && allCandidates.length) {
    const pick = (preferDeepen && unmetPlayers.length)
      ? allCandidates.find(c => c.nick === unmetPlayers[0].nick) || allCandidates[0]
      : (preferDeepen && bonds.length
        ? allCandidates.filter(c => c.isBonded).sort((a, b) => (a.last || 0) - (b.last || 0))[0] || allCandidates[0]
        : allCandidates[0]);
    return {
      active: true,
      mode: 'direct',
      target: pick.nick,
      rel: pick.rel || null,
      fellow: pick.fellow || null,
      bond: pick.bond || null,
      monthsSincePartner: pick.isBonded ? Math.max(0, n - (pick.last || 0)) : 0,
      alsoMentioned: [],
    };
  }

  /* 若玩家本月正专注跟某个本地熟人谈婚论嫁或点名处理私事，不强塞穿越者抢戏 */
  const localPeople = (((s && s.memo && s.memo.people) || []))
    .filter(p => p && p.who && !/^穿越者/.test(p.who))
    .map(p => whoKey(p.who))
    .filter(k => k.length >= 2);
  if (BOND_RE.test(txt) || localPeople.some(k => txt.includes(k))) {
    return { active: false, mode: 'none' };
  }

  const past = (s && Array.isArray(s.months)) ? s.months : [];
  let monthsSince = 99;
  for (let i = past.length - 1; i >= 0; i--) {
    const pm = past[i];
    if (pm && (pm.bond || (pm.worldTrace && pm.worldTrace.kind === 'bond'))) {
      monthsSince = past.length - i;
      break;
    }
  }

  const roll = hash32((s && s.seed ? s.seed : 1) * 19937 + n * 104729) / 2 ** 32;

  /* 前期（已结识不足 3 位）或城里有尚未照面的真人穿越者时，安排自然狭路相逢；
   * 已有 3 位以上同道后，不再频频硬塞新面孔，把中后期戏份留给核心同道的深化、结拜或反目。 */
  const crossPool = bonds.length < 3 ? unmetFellows : unmetPlayers;
  if (crossPool.length > 0 && ((n === 2 && monthsSince >= 99) || (monthsSince >= 3 && roll < 0.45) || (bonds.length === 1 && n >= 6 && n % 5 === 0 && roll < 0.6))) {
    const f0 = crossPool[hash32(((s && s.seed) || 1) * 8191 + n * 131071) % crossPool.length];
    return { active: true, mode: 'cross', target: f0.nick, fellow: f0 };
  }

  if (bonds.length > 0 && monthsSince >= 2 && roll < 0.52) {
    const sortedBonds = [...bonds].sort((a, b) => (a.last || 0) - (b.last || 0));
    const b0 = sortedBonds[0];
    return {
      active: true,
      mode: 'bond_echo',
      target: b0.nick,
      rel: b0.rel,
      bond: b0,
      monthsSincePartner: Math.max(0, n - (b0.last || 0)),
    };
  }

  return { active: false, mode: 'none' };
}

const BOND_TRACE_VERB = {
  '初识': '初识对暗语',
  '试探': '试探虚实',
  '结交': '结识往来',
  '合伙': '联手合伙',
  '同盟': '结成同盟',
  '师徒': '结为师徒',
  '知己': '引为知己',
  '结拜': '义结金兰',
  '对手': '交手争锋',
  '宿敌': '结下宿怨',
  '提亲': '登门提亲',
  '成婚': '喜结连理',
  '道侣': '结为道侣',
};

/* 友好关系层级：同轨只允许维持或向上进阶，避免已是「同盟/知己」又被模型随手降格成「结交/合伙」；
 * 「对手/宿敌」不在友好轨内，因此「同盟→对手」反目或「对手→合伙/知己」和解均正常放行。 */
const BOND_FRIENDLY_TIER = {
  '初识': 1, '试探': 1, '结交': 1, '结缘': 1, '同行': 1,
  '合伙': 2, '师徒': 2,
  '同盟': 3,
  '知己': 4,
  '结拜': 5, '提亲': 5,
  '成婚': 6, '道侣': 6,
};

function isBondDowngrade(prevRel, nextRel) {
  const a = BOND_FRIENDLY_TIER[prevRel];
  const b = BOND_FRIENDLY_TIER[nextRel];
  return !!(a && b && b < a);
}

const INITIAL_EXPLICIT_RE = {
  '结拜': /(结拜|拜把|义结金兰|磕头结义)/,
  '提亲': /(提亲|求亲|说媒|下聘|订婚)/,
  '成婚': /(成婚|结婚|迎娶|拜堂|洞房|领证)/,
  '道侣': /(道侣|双修|结为道侣)/,
};

/** 初次照面时防止模型一步跳到「同盟/知己/结拜/宿敌/成婚」等高阶名分，
 *  把后续月份的关系升温、竞合与反转空间留出来（玩家清单明确写出结拜/提亲/成婚的除外）。 */
function capInitialBond(s, bond, list = '') {
  if (!bond || !bond.with || !bond.rel) return bond;
  const key = whoKey(bond.with);
  const past = (s && Array.isArray(s.months)) ? s.months : [];
  const hadPrev = past.some(pm => pm && pm.bond && whoKey(pm.bond.with) === key)
    || activeTravelerBondsOf(s).some(b => whoKey(b.nick) === key);
  if (hadPrev) return bond;

  const rel = bond.rel;
  const listTxt = String(list || '');
  if (INITIAL_EXPLICIT_RE[rel] && INITIAL_EXPLICIT_RE[rel].test(listTxt)) return bond;
  if (rel === '同盟') return { ...bond, rel: '合伙' };
  if (rel === '知己' || rel === '结拜') {
    const isBiz = /(合伙|合股|商路|启动资金|分润|合作|联手)/.test(bond.note || '');
    return { ...bond, rel: isBiz ? '合伙' : '结交' };
  }
  if (rel === '宿敌') return { ...bond, rel: '对手' };
  if (rel === '提亲' || rel === '成婚' || rel === '道侣') return { ...bond, rel: '初识' };
  return bond;
}

function toThirdPersonTrace(text) {
  return String(text || '')
    .replace(/你们/g, '二人')
    .replace(/助你/g, '助其')
    .replace(/与你/g, '与其')
    .replace(/替你/g, '替其')
    .replace(/教你/g, '传授')
    .replace(/指点你/g, '指点其')
    .replace(/拉你/g, '邀其')
    .replace(/带你/g, '带其')
    .replace(/救你/g, '救其')
    .replace(/对你/g, '对其')
    .replace(/你的/g, '其')
    .replace(/你/g, '其');
}

function trimTrace(text, maxLen = 50) {
  const s = String(text == null ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[，,、；;：:\s]+$/, '');
  if (s.length <= maxLen) return s;
  const slice = s.slice(0, maxLen);
  const minCut = Math.floor(maxLen * 0.55);
  let cut = -1;
  for (let i = slice.length - 1; i >= minCut; i--) {
    if ('。！？；，、'.includes(slice[i])) {
      cut = i;
      break;
    }
  }
  if (cut >= minCut) {
    const clean = slice.slice(0, cut).replace(/[，,、；;：:\s]+$/, '');
    return /[。！？]$/.test(slice[cut]) && clean.length + 1 <= maxLen ? clean + slice[cut] : clean;
  }
  return slice.slice(0, maxLen - 1).replace(/[，,、；;：:\s]+$/, '') + '…';
}

function formatBondTrace(nick, partner, city, rel, note) {
  const act = BOND_TRACE_VERB[rel] || rel || '结交';
  const cleanNote = toThirdPersonTrace(String(note || '').replace(/^[，,、；;：:\s]+|[。，,、；;：:\s]+$/g, ''));
  const head = `穿越者「${nick}」与同道「${partner}」在${city}${act}`;
  return trimTrace(cleanNote ? `${head}：${cleanNote}` : head, 50);
}

const BOND_STORY_CUE_RE = {
  '结拜': /(结拜|金兰|拜把|异姓|盟誓|结义|焚香|血酒|生死兄弟|义兄|义弟|义姐|义妹|磕头)/,
  '提亲': /(提亲|下聘|求亲|说媒|订婚|聘礼|定亲)/,
  '成婚': /(成婚|拜堂|洞房|迎娶|结婚|夫妻|领证|喜酒|婚事)/,
  '道侣': /(道侣|双修|结为道侣)/,
  '宿敌': /(反目|决裂|撕破脸|宿敌|死敌|死仇|拔刀|翻脸|结仇|恩断义绝)/,
};

/** 校验高烈度关系跃迁（结拜/提亲/成婚/道侣/宿敌）是否在当月 story/summary 正文里真有落笔，
 *  防止正文只写了寻常同行，模型却在 JSON bond 里凭空编造「于半步茶寮结为金兰」。 */
function isBondGroundedInStory(bond, story = '', summary = '') {
  if (!bond || !bond.with || !bond.rel) return false;
  const txt = `${story || ''}\n${summary || ''}`;
  if (!txt.trim()) return true;
  if (!txt.includes(bond.with)) return false;
  const cue = BOND_STORY_CUE_RE[bond.rel];
  if (cue && !cue.test(txt)) return false;
  return true;
}

const ROUTINE_BOND_NOTE_RE = /(深度绑定|利益绑定|绑定加深|继续合作|合作顺畅|例行分账|维持合作|稳步推进|正常分润|深度合作|深度战略|达成共识|高度契合|资源深度共享|深化产能合作|稳产共识|深度互信|深层利益|互通协议)/;

/** 判定本月返回的 bond 是否属于无实质变化的冗余重复：
 *  只要与该搭档的当前名分相同（如隔十几个月再次报「试探」或「同盟」）或发生同轨降格，即判为冗余；
 *  只有初次结缘、关系跃迁或正反反转才作为本月新关系里程碑上屏与留痕。 */
function isRedundantBond(s, bond, tBeat) {
  if (!bond || !bond.with) return false;
  const key = whoKey(bond.with);
  const past = (s && Array.isArray(s.months)) ? s.months : [];
  let prev = null;
  for (let i = past.length - 1; i >= 0; i--) {
    const pm = past[i];
    if (pm && pm.bond && whoKey(pm.bond.with) === key) {
      prev = pm;
      break;
    }
  }
  if (!prev) return false;
  if (isBondDowngrade(prev.bond.rel, bond.rel)) return true;
  if (prev.bond.rel === bond.rel) return true;
  return false;
}

const PURE_NEWS_EVENT_RE = /(国务院|暂行办法|办法出台|命令发行|正式发行|颁布|施行|停兑|停止流通|停止使用|大会召开|宣布成立|全国推行|市委|市政府|部委|法令出台|法币贬值|金圆券.{0,8}(发行|崩塌|作废|限价|贬值|前奏)|物价.{0,6}(飞涨|暴涨|狂飙|一日|动荡)|投机客.{0,6}破产|王春哲|证券大楼|抢购成风|黑市转入地下|人心惶惶|解放军进城|军管会|物价闯关|熔断|股灾|金融危机|央行|叫停|ICO|币圈|洪水|受灾|千股跌停|暴雷潮|P2P|安稳无恙|避开泥潭|及时.{0,4}避险|风声鹤唳|大整顿|整顿期货|被迫关停|期货市场|交易所|宏观调控|汇率并轨|公司法|最低工资|数十家|几十家)/;
const PERSONAL_DEED_RE = /(立下|创办|盘下|盘活|开起|建成|建起|拿下|买下|打通|创立|拜师|成婚|结拜|立宗|夺得|斩获|练成|破境|淘得|炼出|入股|独揽|获批|立起|开办|商号|字号|分销|秘方|奇物|根基|手艺|资质|名号|名震|传遍|声名大噪|收服|击败|打响|闻名|轰动|设摊|开店|办厂|成名|置下|救下|揭穿|大赚)/;

/** 从这个月的结果里提取值得留进当年时空的「重大事迹」或「穿越者关系」。
 *  严格克制：普通打工买卖、纯抄历史新闻或名分未变/倒退的例行合作返回 null，只有初次结缘、关系跃迁或真正个人大事才记入该年。 */
function extractWorldTrace(s, played, delta, res1, echoes) {
  const year = played ? played.year : s.year;
  const month = played ? played.month : s.month;
  const city = s.city || '';
  const nick = oneLine(s.nick || '无名', 14);
  const combined = `${played ? played.list : ''} ${delta ? delta.story : ''}`;
  const validBond = normalizeBond(delta && delta.bond, s, echoes, combined);

  if (validBond) {
    const partner = validBond.with;
    const rel = validBond.rel;
    const bNote = oneLine(validBond.note || '', 34);
    const past = (s && Array.isArray(s.months)) ? s.months : [];
    const pKey = whoKey(partner);
    let prevRel = null;
    let alreadySameOrHigher = false;
    for (let i = past.length - 1; i >= 0; i--) {
      const pm = past[i];
      if (pm && pm.bond && whoKey(pm.bond.with) === pKey) {
        prevRel = pm.bond.rel;
        if (pm.bond.rel === rel || isBondDowngrade(pm.bond.rel, rel)) alreadySameOrHigher = true;
        break;
      }
    }
    /* 本局对该穿越者已留过同一或更高友好名分的印记（哪怕跨了日历年），不再反复刷屏或降格覆盖；
     * 若属于实质跃迁或正反反转（如 试探→同盟、对手→同盟、同盟→知己/对手），即便备注带套话也正常留痕更新。 */
    const isRealStep = !!(prevRel && prevRel !== rel && !isBondDowngrade(prevRel, rel));
    if (alreadySameOrHigher || (!isRealStep && ROUTINE_BOND_NOTE_RE.test(bNote))) {
      return null;
    }
    const summary = formatBondTrace(nick, partner, city, rel, bNote);
    return {
      year, month, city, nick,
      kind: 'bond', partner, bondType: rel,
      summary, importance: 3,
    };
  }

  const rawEv = toThirdPersonTrace(oneLine(delta && delta.worldEvent, 48));
  const hasPersonalDeed = rawEv && (PERSONAL_DEED_RE.test(rawEv) || BOND_RE.test(rawEv) || WEIRD_THEMES.some(w => w.re.test(rawEv)));
  if (rawEv && (PURE_NEWS_EVENT_RE.test(rawEv) ? !hasPersonalDeed : (!rawEv.includes(nick) && !hasPersonalDeed))) {
    return null;
  }
  const inc = incomeOf(year, month);
  const bigMoney = res1 && Math.abs(res1.gained || 0) >= inc * 1.2;
  const isMajor = rawEv.length >= 6 || bigMoney || MAJOR_DEED_RE.test(combined);
  if (!isMajor) return null;

  const text = rawEv.length >= 6
    ? trimTrace(rawEv.includes(nick) ? rawEv : `穿越者「${nick}」在${city}：${rawEv}`, 50)
    : null;
  if (!text) return null;
  /* 同一局的个人事迹/奇闻留痕最多留 2 条，避免同一个招牌产线在后期连刷 3 条雷同留痕 */
  const pastDeeds = ((s && s.months) || [])
    .map(pm => pm && pm.worldTrace)
    .filter(wt => wt && (wt.kind === 'deed' || wt.kind === 'weird'));
  if (pastDeeds.length >= 2) return null;
  const evCore = rawEv.replace(/^穿越者「[^」]+」在[^：:]+[：:]/, '');
  if (evCore.length >= 6 && pastDeeds.some(wt => {
    const prevCore = String(wt.summary || '').replace(/^穿越者「[^」]+」在[^：:]+[：:]/, '');
    for (let i = 0; i <= evCore.length - 4; i++) {
      if (prevCore.includes(evCore.slice(i, i + 4))) return true;
    }
    return false;
  })) {
    return null;
  }
  return {
    year, month, city, nick,
    kind: WEIRD_THEMES.some(w => w.re.test(text)) ? 'weird' : 'deed',
    partner: null, bondType: null,
    summary: text,
    importance: bigMoney || BOND_RE.test(text) ? 3 : 2,
  };
}

/* ── 持续性月度进项（铺面／租金／津贴／堂口）与写实量级对齐 ─────────────
 * 只保住既往已经落地的合理持续进项（如铺面月利、房租、顾问津贴、堂口规费），
 * 不再根据单月手写狂想把账面人为抬高几百倍。 */
const LABOR_ENTRY_RE = /(临工|临时|杂工|零散|搬运|卸货|扛包|短工|打杂)/;
const ONEOFF_ENTRY_RE = /(安家费|定金|押金|变卖|售卖|转卖|变现|悬赏|赔偿|退还|收回|借款|借入|补差|折算价值|截获)/;

function recurringBucketOf(what) {
  const w = String(what || '');
  if (!w || LABOR_ENTRY_RE.test(w)) return null;
  if (ONEOFF_ENTRY_RE.test(w) && !/(月度|每月|例行|常规|津贴|房租|香火|月利)/.test(w)) return null;
  if (/(门徒|信徒|教徒|香火|宗门|堂口香火)/.test(w) && /(供奉|香火|月费|会费|收益|进项|余利)/.test(w)) return 'sect';
  if (/(顾问|俸禄|津贴|官俸|固定薪水|月俸)/.test(w) && !/(额外|赏金)/.test(w)) return 'advisor';
  if (/(房租|租金|田租|地租|铺租)/.test(w) || /租赁.{0,4}(收益|收入|净进|进项|回款)/.test(w)) return 'rent';
  if (/(份子|保护费|堂口|抽头|规费)/.test(w)) return 'dues';
  if (/(销售收益|经营净利|经营净进|经营收入|经营收益|经营进项|分红|股息|红利|月利|余利|铺面收益|铺面经营|铺面净进)/.test(w)) return 'biz';
  return null;
}

/** 扫描历史月份，提取当前仍存续的每月固定进项桶（按当月购买力折算，带合理上限） */
function recurringStreamsOf(s) {
  const past = (s && Array.isArray(s.months)) ? s.months : [];
  if (!past.length) return [];
  const curInc = incomeOf(s.year, s.month) || 1;
  const lostTxt = ((s && s.memo && s.memo.traits) || []).filter(t => t.lost).map(t => t.what).join(' ');
  const map = new Map();

  for (const m of past) {
    const mInc = incomeOf(m.year, m.month) || curInc;
    for (const e of (m.entries || [])) {
      if (!e || !(Number(e.amount) > 0)) continue;
      const b = recurringBucketOf(e.what);
      if (!b) continue;
      const ratio = Number(e.amount) / mInc;
      if (ratio < 0.05) continue;
      /* 固定流水的单桶折算比例温和设限，防止单次异动被当成永久月薪无限滚雪球 */
      const cappedRatio = Math.min(ratio, 3.0);
      const prev = map.get(b);
      const cleanName = String(e.what).replace(/首月/g, '月度').replace(/安家费及/g, '');
      map.set(b, {
        bucket: b,
        what: cleanName,
        ratio: prev ? (prev.ratio * 0.4 + cappedRatio * 0.6) : cappedRatio,
        rawAmount: Number(e.amount),
        lastN: m.n,
      });
    }
  }

  return [...map.values()].filter(st => {
    if (st.bucket === 'advisor' && /顾问|差事|官职/.test(lostTxt)) return false;
    if (st.bucket === 'sect' && /堂口|宗门|教派|武馆/.test(lostTxt)) return false;
    if (st.bucket === 'biz' && /铺子|摊子|商号|作坊/.test(lostTxt)) return false;
    return true;
  }).map(st => ({
    ...st,
    expectedAmount: Math.round(st.ratio * curInc),
  }));
}

/** 仅根据已经攒下的真实身价与既往经历（traits）判定当下人间尺度，绝不听信当月空口许愿 */
function scaleTierOf(s) {
  const traitsTxt = ((s && s.memo && s.memo.traits) || [])
    .filter(t => !t.lost)
    .map(t => `${t.what} ${(t.notes || []).map(x => x.note).join(' ')}`)
    .join(' ');
  const inc = (s && s.year && s.month) ? (incomeOf(s.year, s.month) || 1) : 1;
  const yearsWorth = s ? (netWorth(s) / inc) : 0;

  if (yearsWorth >= 20 || /(总商会|大商帮|垄断全城|城中巨擘|大号东家|数百家|百人以上)/.test(traitsTxt)) {
    return { tier: 3, sub: 'tycoon', label: '城中巨擘与大商号东家', minMult: 1.8, maxMult: 4.5 };
  }
  if (yearsWorth >= 6 || /(商号|堂主|高阶顾问|高级顾问|名师|几处铺面|数十人|行会会长|钱庄股东)/.test(traitsTxt)) {
    return { tier: 2, sub: 'notable', label: '一方人物与体面门面', minMult: 0.8, maxMult: 2.0 };
  }
  if (yearsWorth >= 1.5 || /(铺子|作坊|摊位|工头|掌柜|顾问|手艺|小堂口|帮手|熟客)/.test(traitsTxt)) {
    return { tier: 1, sub: 'settled', label: '站稳脚跟的熟手东家', minMult: 0.32, maxMult: 0.95 };
  }
  return { tier: 0, sub: 'mortal', label: '市井起步', minMult: 0.12, maxMult: 0.45 };
}

/** 校准当月模型返回的账单：
 *  只补齐被模型漏记的既往持续性固定进项（铺面月利、房租、顾问津贴等），
 *  不做脱离实际的百倍放大。 */
function reconcileMonthFinancials(s, list, delta) {
  if (!delta || !Array.isArray(delta.entries)) return delta;
  const inc = incomeOf(s.year, s.month);
  if (!(inc > 0)) return delta;

  const streams = recurringStreamsOf(s);
  if (!streams.length) return delta;

  const seed = (s.seed || 1) * 48271 + (s.n || 1) * 16807;
  const presentBuckets = new Set();
  for (const e of delta.entries) {
    if (!e || !(Number(e.amount) > 0)) continue;
    const b = recurringBucketOf(e.what);
    if (b) presentBuckets.add(b);
  }

  for (const st of streams) {
    if (!presentBuckets.has(st.bucket)) {
      const jitter = 0.95 + 0.1 * (hash32(seed ^ st.lastN) / 2 ** 32);
      const amt = Math.round(st.expectedAmount * jitter);
      if (amt > 0) {
        delta.entries.push({ what: st.what, amount: amt });
        presentBuckets.add(st.bucket);
      }
    }
  }

  return delta;
}

/** 从完整正文或月记里兜底提取 2–3 句精简概要（供老记录或模型漏写 summary 时使用） */
function deriveSummary(story, memoLine) {
  const clean = String(story || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (clean) {
    const sents = clean.match(/[^。！？\n]+[。！？]?/g) || [clean];
    let out = '';
    for (const s of sents) {
      const t = s.trim();
      if (!t) continue;
      if (out && (out.length + t.length > 96 || (out.length >= 42 && sents.length > 2))) break;
      out += t;
      if (out.length >= 52) break;
    }
    if (out) return out.slice(0, 110);
  }
  return oneLine(memoLine || '', 96);
}

/** 从标题、概要或正文里兜底提取 10–22 字短标题 */
function deriveHeadline(headline, summary, memoLine, story) {
  const h = oneLine(String(headline || '').replace(/\*\*/g, '').replace(/[《》「」『』""''。！？!?.，,;；：:]+$/g, ''), 26);
  if (h.length >= 4) return h;
  const src = String(summary || memoLine || story || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (!src) return '';
  const first = src.split(/[。！？；\n]/)[0].trim();
  if (first.length <= 24) return first;
  const sub = first.split(/[，,]/)[0].trim();
  return (sub.length >= 8 && sub.length <= 24 ? sub : first.slice(0, 22)).replace(/[，,、：:]+$/, '');
}

/** 检一句开局心愿。空着照样能开局，写了 30 个汉字封顶。 */
function checkWish(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: true, n: 0, text: '' };
  const n = countHan(t);
  if (n > WISH_LIMIT) {
    return { ok: false, n, text: '', say: `心愿写了 ${n} 个汉字，请压到 ${WISH_LIMIT} 字以内。` };
  }
  return { ok: true, n, text: t.slice(0, 90) };
}

/* ── 精选历史开局切口（首页一行轻入口，点完直接定位年份与预设心愿） ───── */
const SCENARIOS = [
  {
    id: 'y1948',
    label: '1948 · 躲过金圆券',
    year: 1948, month: 1, targetMonths: 12,
    wish: '赶在八月换币前把家底换成硬通货，安稳渡过动荡一年',
  },
  {
    id: 'y1962',
    label: '1962 · 凭票度荒',
    year: 1962, month: 1, targetMonths: 24,
    wish: '在凭票过日子的年头攒齐票证和人情，站稳脚跟',
  },
  {
    id: 'y1992',
    label: '1992 · 南下淘金',
    year: 1992, month: 1, targetMonths: 24,
    wish: '踩准南下浪潮盘下实在家业，赶在回落前落袋为安',
  },
  {
    id: 'y2008',
    label: '2008 · 股灾逃顶',
    year: 2008, month: 1, targetMonths: 24,
    wish: '躲过股灾与寒冬，保住本钱再趁低点翻身',
  },
  {
    id: 'y1936',
    label: '1936 · 暗面寻奇',
    year: 1936, month: 3, targetMonths: 24,
    wish: '在城里站住脚，顺着街角奇闻叩开暗面江湖门径',
  },
];

/** 给任意一年配两条顺手的开局心愿灵感（选填，点一下直接填入）。 */
function wishSuggestionsFor(year, card) {
  const y = Number(year) || 1948;
  const hit = SCENARIOS.find(x => x.year === y);
  const sy = yearOf(y);
  const city = (sy && sy.city) || '城里';
  const list = [];
  if (hit) list.push(hit.wish);
  if (sy && sy.switch && !list.some(x => x.includes('换币'))) {
    list.push('趁换币前把现钱换成实在家当，稳住家底');
  }
  if (y <= 1949) {
    list.push(`在${city}盘下一间铺面，乱世里护住身家`);
    list.push('结交一位同城穿越者，联手闯出一片名堂');
  } else if (y <= 1977) {
    list.push('凭真本事攒齐紧俏票证和熟人门路');
    list.push('在城里寻访隐世奇人，暗里练成一门手艺');
  } else if (y <= 2008) {
    list.push(`赶上这波行情，在${city}攒下第一桶金`);
    list.push('跟同城穿越者搭伙立起响亮字号');
  } else {
    list.push(`看准潮起潮落，在${city}置下安身家业`);
    list.push('在烟火气里寻访奇人异事，不虚此行');
  }
  const uniq = [];
  for (const s of list) {
    if (s && !uniq.includes(s)) uniq.push(s);
    if (uniq.length >= 2) break;
  }
  return uniq;
}

/* ── 四幕阶段与终局倒计时 ──────────────────────────────────── */
function stageInfo(s) {
  const base = baseMonthsOf(s);
  const last = lastMonthOf(s);
  const n = Math.min(Number((s && s.n) || 1), last);
  const remaining = Math.max(0, last - n + 1);
  if (s && s.phase === 'extra') {
    return { act: 5, label: '续走岁月', countdown: remaining <= 3, remaining, milestone: false, milestoneLabel: '' };
  }
  if (base === MONTHS_FAST) {
    if (remaining <= 3) {
      return {
        act: 4, label: '收官倒计时', countdown: true, remaining,
        milestone: remaining === 3 || remaining === 1,
        milestoneLabel: remaining === 1 ? '收官之月' : '收官倒计时',
      };
    }
    if (n <= 3) return { act: 1, label: '初来立脚', countdown: false, remaining, milestone: false, milestoneLabel: '' };
    if (n <= 6) return { act: 2, label: '顺势起势', countdown: false, remaining, milestone: n === 6, milestoneLabel: n === 6 ? '过半变局' : '' };
    return { act: 3, label: '风浪变局', countdown: false, remaining, milestone: false, milestoneLabel: '' };
  }
  if (remaining <= 3) {
    return {
      act: 4, label: '收官倒计时', countdown: true, remaining,
      milestone: remaining === 3 || remaining === 1,
      milestoneLabel: remaining === 1 ? '收官之月' : '收官倒计时',
    };
  }
  if (n <= 6) return { act: 1, label: '初来立脚', countdown: false, remaining, milestone: n === 6, milestoneLabel: n === 6 ? '立脚半年' : '' };
  if (n <= 12) return { act: 2, label: '顺势起势', countdown: false, remaining, milestone: n === 12, milestoneLabel: n === 12 ? '过半变局' : '' };
  if (n <= 18) return { act: 3, label: '风浪变局', countdown: false, remaining, milestone: n === 18, milestoneLabel: n === 18 ? '冲刺前夜' : '' };
  return { act: 4, label: '深耕定局', countdown: false, remaining, milestone: false, milestoneLabel: '' };
}

/* ── 本月风声 / 急事敲门（零额外模型调用，最多一条，不增负担） ───── */
const MARKET_RUMOR_UP = {
  '股': '茶馆里有人透风，过一两月证券行情怕是要大起，早有人在收筹码。',
  '房': '街面牙人都在说，往后阵子房子和地皮要往上跳，手里有闲钱的都在看盘。',
  '金': '钱庄熟客压低声音说，纸票子快压不住了，金银外币眼看要走俏。',
  '囤': '货栈里风声不对，紧俏日用品过阵子怕要断货涨价，行里已在压仓。',
  '币': '圈里有人悄声传，数字货币过阵子要起一波大行情，不少人正往里凑。',
};
const MARKET_RUMOR_DOWN = {
  '股': '老掮客私下摇头，说这波证券涨得太虚，再过一两月怕是要变天。',
  '房': '楼市里风声转冷，几个大行家已在悄悄出货，怕往后不好脱手。',
  '金': '街面传上头要严查金银黑市，风头紧起来，手里压着重货的都在犯嘀咕。',
  '囤': '货行里传银根要收紧，压在仓里的存货再不出手，往后怕要砸手里。',
  '币': '圈里风声转紧，数字货币大起大落，再往高处追怕要套牢。',
};
const MARKET_RUMOR_FOG = '市井里消息满天飞，有人说要大涨，也有人劝着落袋为安，真假难辨。';

function monthlyPulse(s, card, echoes) {
  if (!s || s.finished || s.n > lastMonthOf(s)) return null;
  const st = stageInfo(s);
  const cur = currencyOf(s.year, s.month);
  const inc = incomeOf(s.year, s.month) || 1;
  const n = Number(s.n) || 1;

  /* 1. 终局倒计时（最后 3 月与收官之月） */
  if (s.phase !== 'extra' && st.countdown && (st.remaining === 3 || st.remaining === 1)) {
    const wishBit = s.wish ? `心愿「${s.wish.slice(0, 18)}」` : '手里的货、债和人情';
    return {
      kind: 'countdown',
      tag: st.remaining === 1 ? '收官之月' : `剩 ${st.remaining} 月收官`,
      text: st.remaining === 1
        ? `这是最后一个月，${wishBit}该做个了断了。`
        : `离收官只剩 ${st.remaining} 个月，${wishBit}得趁早收口。`,
    };
  }

  /* 2. 换币当月 / 提前 1–2 月换币风声 */
  const swNow = switchDueAfter(s.year, s.month) || switchOnEntry(s.year, s.month);
  if (swNow) {
    return {
      kind: 'urgent',
      tag: '本月换币',
      text: `${String(swNow.say || '').replace(/。+$/, '')}。留现钱还是换家当，这个月得拿主意。`,
      draft: '打听换币细则，先把手里现钱折成保值实物或紧俏货',
    };
  }
  const nm1 = nextMonth(s.year, s.month);
  const nm2 = nextMonth(nm1.year, nm1.month);
  const swSoon = switchDueAfter(nm1.year, nm1.month) || switchOnEntry(nm1.year, nm1.month)
    || switchDueAfter(nm2.year, nm2.month) || switchOnEntry(nm2.year, nm2.month);
  if (swSoon && n >= 2) {
    return {
      kind: 'rumor',
      tag: '街面风声',
      text: `茶馆里压低声音传，过一两月要改换${CN[swSoon.to] || '新币'}，纸票子怕攥不住。`,
      draft: '提前把多余现钱换成金银或耐放实物，避开换币折损',
    };
  }

  /* 3. 当月年卡 risks（第 1 个月保持清爽，第 2 个月起敲门） */
  if (n >= 2 && card && Array.isArray(card.risks)) {
    const rk = card.risks.find(x => Number(x.month) === Number(s.month));
    if (rk && rk.what) {
      return {
        kind: 'urgent',
        tag: '本月急事',
        text: trimTrace(rk.what, 44),
        sub: rk.hit ? trimTrace(rk.hit, 48) : '',
      };
    }
  }

  /* 4. 欠债偏重：债主上门催账 */
  const debts = Array.isArray(s.debts) ? s.debts : [];
  const debtSum = debts.reduce((t, d) => t + (Number(d.amount) || 0), 0);
  if (n >= 3 && debtSum >= inc * 0.35 && debts.length) {
    const topD = debts.slice().sort((a, b) => (b.amount || 0) - (a.amount || 0))[0];
    return {
      kind: 'urgent',
      tag: '债主催门',
      text: `欠${topD.who}的 ${money(topD.amount, cur)} 已拖了些日子，对方托人带话本月要见个准信。`,
      draft: `先想办法凑钱还清欠${topD.who}的账，或上门谈宽限`,
    };
  }

  /* 5. 跨年代遗踪线索（旧年异客留下的暗盒或百年字号，跳过本局已探访过的） */
  const claimedSet = new Set(Array.isArray(s.claimedLegacies) ? s.claimedLegacies.map(String) : []);
  const legacies = ((echoes && Array.isArray(echoes.legacies)) ? echoes.legacies : [])
    .filter(lg => lg && lg.item && !claimedSet.has(String(lg.id || lg.item)));
  if (n >= 2 && legacies.length && (n === 2 || n % 4 === 3)) {
    const lg = legacies[(n + (s.seed || 1)) % legacies.length];
    const isCache = lg.capsuleKind === 'cache';
    return {
      kind: 'legacy',
      tag: isCache ? '旧年暗盒' : '百年遗踪',
      legacyId: lg.id || null,
      text: isCache
        ? `${lg.year} 年有位异客「${lg.nick}」曾在${lg.city}藏下「${lg.item}」：${trimTrace(lg.clue, 30)}`
        : `${lg.year} 年穿越者「${lg.nick}」留下的「${lg.item}」仍在${lg.city}流传：${trimTrace(lg.clue, 30)}`,
      draft: isCache
        ? `顺着 ${lg.year} 年穿越者「${lg.nick}」留下的线索，去寻访那处「${lg.item}」`
        : `去${lg.city}打听 ${lg.year} 年穿越者「${lg.nick}」留下的「${lg.item}」，看看能否攀上旧缘`,
    };
  }

  /* 6. 提前 1–2 个月的历史行情拐点风声（七成准、三成留雾） */
  if (n >= 2) {
    const kNow = s.year * 12 + (s.month - 1);
    const soonM = MARKETS.find(w => w.a === kNow + 1 || w.a === kNow + 2);
    if (soonM && soonM.venues && soonM.venues.length) {
      const roll = hash32((s.seed || 1) * 524287 + n * 131071) / 2 ** 32;
      const v0 = soonM.venues[0];
      const msg = roll < 0.75
        ? ((soonM.dir > 0 ? MARKET_RUMOR_UP[v0] : MARKET_RUMOR_DOWN[v0]) || MARKET_RUMOR_FOG)
        : MARKET_RUMOR_FOG;
      return {
        kind: 'rumor',
        tag: '街面风声',
        text: msg,
      };
    }
  }

  /* 7. 阶段节点（半年盘点）或挂着太久的未了头绪 */
  const openThreads = ((s.memo && s.memo.threads) || []).filter(t => !t.done);
  const staleThread = openThreads.find(t => n - (t.opened || 1) >= 3);
  if (staleThread) {
    return {
      kind: 'turn',
      tag: '旧事催办',
      text: `第 ${staleThread.opened} 个月起头的「${staleThread.what}」还悬着，再拖下去恐生变故。`,
      draft: `先把第 ${staleThread.opened} 个月挂下的「${staleThread.what}」办妥了结`,
    };
  }
  if (st.milestone && st.milestoneLabel && n >= 6) {
    const wishNote = s.wish ? `对照开局心愿「${s.wish.slice(0, 18)}」，` : '';
    return {
      kind: 'turn',
      tag: st.milestoneLabel,
      text: `${wishNote}已过 ${n - 1} 个月，眼下是守稳旧摊还是换道加码的关口。`,
    };
  }

  /* 8. 间隔露出当年大事（每 3 个月最多 1 次，保持呼吸感） */
  if (n >= 3 && n % 3 === 1 && card && Array.isArray(card.events)) {
    const ev = card.events.find(e => Number(e.month) === Number(s.month));
    if (ev && ev.text) {
      return {
        kind: 'rumor',
        tag: '城中动静',
        text: trimTrace(ev.text, 48),
      };
    }
  }

  return null;
}

/* ── 跨年代时空留物 / 百年字号提取 ─────────────────────────── */
const CAPSULE_CACHE_RE = /(埋下|藏下|埋藏|留给后|留给后来|后来的穿越者|留封信|留张字条|藏在|埋在|托付给后|封存给后|埋个|藏个)/;
const DIG_CACHE_RE = /(探那|挖出|挖掘|寻访|寻那|找那|翻出|开启|启出|撬开|去探|顺着.{0,12}线索)/;
const CAPSULE_LEGACY_RE = /(字号|商号|老店|铺子|堂口|武馆|门派|书院|会馆|酒楼|茶楼|药铺|钱庄|戏班)/;

function extractCapsule(s, list, delta) {
  const raw = delta && delta.capsule;
  if (!raw || typeof raw !== 'object') return null;
  const kind = raw.kind === 'cache' ? 'cache' : (raw.kind === 'legacy' ? 'legacy' : null);
  if (!kind) return null;
  const item = oneLine(raw.item || '', 16).replace(/[《》「」『』""'']/g, '').trim();
  const clue = oneLine(raw.clue || '', 38).trim();
  if (item.length < 2 || clue.length < 4) return null;
  const listTxt = String(list || '');
  const storyTxt = String((delta && delta.story) || '');
  if (kind === 'cache') {
    if (s.capsuleCacheSaved) return null;
    if (delta && delta.claimedLegacyId) return null;
    if (!CAPSULE_CACHE_RE.test(listTxt)) return null;
    if (DIG_CACHE_RE.test(listTxt) && !/(重新埋|再埋|埋下新|留给后|留封信|留张字条)/.test(listTxt)) return null;
  } else {
    if (s.capsuleLegacySaved) return null;
    if (!CAPSULE_LEGACY_RE.test(`${listTxt} ${storyTxt} ${item}`)) return null;
  }
  const city = s.city || '';
  const nick = oneLine(s.nick || '异客', 14);
  const summary = kind === 'cache'
    ? trimTrace(`穿越者「${nick}」在 ${s.year} 年${city}留下一处「${item}」`, 50)
    : trimTrace(`穿越者「${nick}」在 ${s.year} 年${city}立起「${item}」`, 50);
  return {
    year: s.year,
    month: s.month,
    city,
    nick,
    kind: kind === 'cache' ? 'capsule' : 'legacy',
    capsuleKind: kind,
    item,
    clue,
    summary,
    importance: 3,
  };
}

/** 从总评标题、本事或成绩抽一枚 2–4 字朱砂印文，盖在首页百年卡片上。 */
function stampOf(title, score, traits) {
  const clean = String(title || '').replace(/[^一-鿿]/g, '');
  if (clean.length >= 2 && clean.length <= 4) return clean;
  if (clean.length > 4) return clean.slice(0, 4);
  const t0 = Array.isArray(traits) && traits.length
    ? String(traits[0] || '').replace(/[^一-鿿]/g, '')
    : '';
  if (t0.length >= 2 && t0.length <= 4) return t0;
  const sc = Number(score);
  if (isFinite(sc)) {
    if (sc >= 10) return '一方巨贾';
    if (sc >= 3) return '站稳脚跟';
    if (sc >= 0.5) return '安稳度日';
    return '乱世过客';
  }
  return '到此一游';
}

module.exports = {
  WEIRD_THEMES, weirdRoll, planEffort, extractWorldTrace,
  knownTravelersOf, normalizeBond, activeTravelerBondsOf, travelerBeat,
  trimTrace, formatBondTrace, toThirdPersonTrace, ROUTINE_BOND_NOTE_RE, isBondDowngrade, capInitialBond, isRedundantBond, isBondGroundedInStory, cleanAssetName, normalizeAssetKind, stripPaperLossEntries, stripBogusCashAndExchange,
  recurringBucketOf, recurringStreamsOf, scaleTierOf, reconcileMonthFinancials,
  deriveSummary, deriveHeadline,
  SCENARIOS, wishSuggestionsFor, checkWish, stageInfo, monthlyPulse, extractCapsule, stampOf, assetVenueOf,
  cleanOptions, cleanRefused, applyMove, offScript, serendipity, marketAt, speculation, venueOf,
  DAYS, MONTHS, MONTHS_FAST, MONTHS_EXTRA, LIST_LIMIT, PERSONA_LIMIT, WISH_LIMIT, CN, SPINE, TL,
  baseMonthsOf, lastMonthOf, extraRoom, reopen,
  yearOf, scanAnachronism, sayAnachronism, currencyAt, priceAt, worthAt, incomeAt, incomeAtDay,
  money, moneyIn, unitOf, fixScale, fixSigns, unpairedBuys,
  currencyOf, incomeOf, worthOf, nextMonth, startable, monthTop, switchDueAfter, switchOnEntry, reprice, closeOut,
  startingCash, newRun, netWorth, applySwitch, advanceTo, applyMonth, tallyLine, settle, fmtScore, fmtUsd, WORLD,
  countHan, hasContent, checkList, checkPersona,
  newMemo, applyMemo, memoText, MEMO_CAP, MEMO_LIMIT,
};
