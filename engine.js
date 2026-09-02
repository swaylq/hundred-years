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
const MONTHS = 24;               // 一局走二十四个月
const MONTHS_EXTRA = 60;         // 走完两年之后，最多还能再往下走五年（后传）
const LIST_LIMIT = 500;          // 一个月的清单，汉字上限
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

/** 从这个月开局，二十四个月走得完吗——年卡只写到 2025 年 12 月，
 *  最晚只能从 2024 年 1 月起步。 */
function startable(year, month) {
  const last = SPINE.years[SPINE.years.length - 1];
  return (year * 12 + month - 1) + (MONTHS - 1) <= last.year * 12 + 11;
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

function newRun({ year, month, nick, seed, persona }) {
  const Y = yearOf(year);
  const cur = currencyOf(year, month);
  const cash = startingCash(year, month);
  return {
    /* year/month 是**现在走到哪个月**，每过一个月往前挪一格；
     * 开局那个月单独记在 startYear/startMonth，结算和榜都认它。 */
    year, month,
    startYear: year, startMonth: month,
    n: 1,                                   // 第几个月，1..MONTHS
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
    /* 四条杠 2026-09-03 撤过一次，当天晚上 sway 又要回来了：
     * 钱仍旧是**唯一记分的那个数**（settle 只看家底），这四个是状态，不进分数。
     * 它们管的是「这个月他能干什么」——体力扛不扛得动、名声进不进得了门、
     * 关系有没有人肯担保、麻烦大到多少会真栽。
     * 比数值更要紧的是 memo.traits 那一摊：练出来的身手、拉起来的班底、
     * 落下的病根——那些是没有上限、也不该有上限的东西。 */
    standing: { 名声: 10, 关系: 10, 体力: 80, 麻烦: 0 },
    /* 这一局的记忆。每过一个月，模型把刚发生的事压成几行短的，
     * 由 applyMemo 并进来；**引擎只添不删**，压缩发生在往提示词里渲染那一步。
     * 少了它，模型只看得见最近两个月的正文，第三个月起认识的人和谈了一半的买卖就没了。 */
    memo: newMemo(),
    /* 玩家自己写的一句话：他是个什么人。整局不变，每个月都拼进提示词。
     * 除了钱，这一局再没有别的槽——名声、关系、体力、麻烦四条杠 2026-09-02 撤了，
     * 它们的作用改由钱和正文里的事承担（罚款、货被没收、被关几天挣不到钱）。 */
    persona: checkPersona(persona).text || '',
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
function reprice(s, from, to) {
  const k = incomeOf(to.year, to.month) / incomeOf(from.year, from.month);
  if (!isFinite(k) || k <= 0) return;
  for (const a of s.assets) {
    if (a.kind === '债权' || a.kind === '现金类') continue;
    a.worth *= k;
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
const EARN = /卖出|售出|所得|收回|讨回|退还|报酬|工钱|工资|奖励|提成|抽成|酬劳|利润|差价|收益|溢价|赚/;
function fixSigns(delta) {
  const ents = (delta.entries || []).filter(e => e && e.what != null && isFinite(Number(e.amount)));
  if (ents.length < 3 || ents.some(e => Number(e.amount) < 0)) return null;
  const out = ents.filter(e => SPEND.test(e.what) && !EARN.test(e.what));
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
  let zeros;
  if (big > 0 && big * 100 <= wage) {
    zeros = Math.round(Math.log10(wage / big));                       // 写小了
    if (zeros < 2) return null;
  } else if (top > 0 && bigAll > top * 1000) {
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
const SELL_WORD = /卖|售|出货|所得|货款收|转手/;

/** 这个月有没有「买了东西却没记下东西」。`wage` 是当月一个月的收入，用来滤掉零碎开销。 */
function unpairedBuys(delta, wage) {
  const ents = (delta.entries || []).filter(e => e && e.what != null && isFinite(Number(e.amount)));
  const floor = Math.max(0, (Number(wage) || 0) / 4);          // 小于四分之一个月工钱的不算进货
  const buys = ents.filter(e => Number(e.amount) < 0 && BUY_WORD.test(e.what) && -Number(e.amount) >= floor);
  if (!buys.length) return null;
  const spent = buys.reduce((t, e) => t - Number(e.amount), 0);
  /* 当月买当月卖：卖出去的进账够大，就说明货已经出手了，本来就不该留在家当里 */
  const sold = ents.filter(e => Number(e.amount) > 0 && SELL_WORD.test(e.what)).reduce((t, e) => t + Number(e.amount), 0);
  if (sold >= spent * 0.8) return null;
  const added = (delta.assetsAdd || []).reduce((t, a) => t + (Number(a && a.worth) || 0), 0);
  if (added >= spent * 0.4) return null;                       // 记上了大半就算数
  return { items: buys.map(e => ({ what: e.what, amount: Number(e.amount) })), spent, added, sold };
}

function applyMonth(s, delta) {
  const before = netWorth(s);
  const flipped = fixSigns(delta);       // 一笔出账都没有？先把忘掉的负号补回去
  const rescaled = fixScale(s, delta);   // 整个月的账写小了几个数量级？补上再算
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
   * 模型偶尔会把一天里提到的每一件小玩意都记成一笔家当，
   * 三十天下来存档能撑到几百条，界面上也读不过来。 */
  const added = [];
  for (const a of (delta.assetsAdd || []).slice(0, 8)) {
    if (!a || !a.name) continue;
    const rec = { name: String(a.name).slice(0, 30), kind: a.kind || '实物', worth: Number(a.worth) || 0, note: String(a.note || '').slice(0, 60) };
    s.assets.push(rec); added.push(rec);
  }
  if (s.assets.length > 40) {
    /* 挤出去的是最不值钱的那些，值钱的留着 */
    s.assets.sort((x, y) => y.worth - x.worth);
    s.assets.length = 40;
  }
  for (const name of (delta.assetsDrop || [])) {
    const i = s.assets.findIndex(x => x.name === name);
    if (i >= 0) s.assets.splice(i, 1);
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

  /* 四条杠：模型给的是增量（−20..+20），夹在 0..100 之间。
   * 老档（2026-09-03 白天那半天开的局）没有这一块，进来先补上默认值。 */
  if (!s.standing) s.standing = { 名声: 10, 关系: 10, 体力: 80, 麻烦: 0 };
  const st = delta.standing || {};
  for (const k of ['名声', '关系', '体力', '麻烦']) {
    if (s.standing[k] == null) s.standing[k] = k === '体力' ? 80 : (k === '麻烦' ? 0 : 10);
    if (st[k] === undefined) continue;
    s.standing[k] = Math.max(0, Math.min(100, s.standing[k] + (Number(st[k]) || 0)));
  }

  /* 挣多少记多少。这里原来有一段「超过那一年一个月的顶就按比例削回去」，
   * 2026-09-03 撤了：sway 打出过一个超过顶的月份，界面上只回他一句
   * 「多出来的没算」。写得出来的就归他，整局封顶（settle 里那一段）一起撤。
   * 单位写错那一类（比那一年做到头还高一千倍）在上面 fixScale 里折回去了。 */
  const gained = netWorth(s) - before;

  return { gained, cash, entries, overspent, debtRefused, rescaled, flipped, missedGoods };
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
const LECTURE = /(犯罪|违法|非法|不合法|违反|道德|伦理|风险|危险|不划算|得不偿失|不值得|建议|劝|后果|坐牢|判刑|牢狱|三思|谨慎|不明智|代价太大|收益)/;

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
 * 都该由行情表说了算，而不是由模型的胆子说了算。 */
const BET = /(炒股|股票|证券|交易所|大盘|基金|建仓|加仓|满仓|抄底|追高|期货|标金|公债|国债|外汇|美钞|黄金|金条|银元|比特币|虚拟货币|炒房|炒币|认购证|倒卖|倒腾|投机|囤|押|下注|赌|梭哈|杠杆|配资|借钱买|抵押)/;
/* 反着做：这几个词出现就算他在往下押（清仓、换现钱、做空） */
const BET_SHORT = /(做空|卖空|清仓|空仓|离场|割肉|抛掉|全卖|换成现钱|换成现金|落袋)/;
/* 借来的钱押进去，输光了还欠着 */
const BET_DEBT = /(杠杆|配资|借钱|借的钱|抵押|当掉|高利贷|印子钱)/;

/** 这个月他押了没有、押的方向对不对得上行情、这一把成不成、几倍。
 *  骰子只认存档种子和第几个月，同一局重算结果不变。 */
function speculation(s, list) {
  const text = String(list || '');
  const venue = venueOf(text);
  /* 两条路认「他在押本钱」：说法本身就是押（炒股、加杠杆、梭哈），
   * 或者认得出场子又带着一个下手的动词（「凑首付买一套房子」——
   * BET 里没有「买房」，但场子是房、动词是买，那就是押）。 */
  if (!BET.test(text) && !(venue && /(买|押|囤|屯|炒|赌|全仓|满仓|杠杆|配资|抵押|倒|收|吃下|投|下注|梭哈|盘下)/.test(text))) {
    return { bet: false };
  }
  /* 赌场没有行情可循，永远对半开；别的场子查表 */
  const market = venue && venue !== '赌' ? marketAt(s.year, s.month, venue) : null;
  const mine = BET_SHORT.test(text) ? -1 : 1;              // 默认是买进、囤着
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
  const debt = mine > 0 && !win && mult <= -0.9 && BET_DEBT.test(text);
  return {
    bet: true, market, venue, mine, align, win,
    mult: Math.round(mult * 100) / 100,
    debt,                                                  // 借钱押的，输光了还欠着
  };
}

/** 他这个月搬到哪儿去了。模型给了 moveTo 才动，给的是废话就不动。
 *  年卡还是原来那座城的（物价、政策、时局照用），提示词里会说明人不在那儿。 */
function applyMove(s, to) {
  const name = String(to || '').replace(/\s+/g, '').replace(/[。，,.、；;：:！!？?"'「」『』（）()]/g, '').slice(0, 8);
  if (!name || name === s.city) return null;
  if (/[a-zA-Z0-9]/.test(name)) return null;
  const from = s.city;
  s.city = name;
  return { from, to: name };
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

/** 这一局最后一个月是第几个月。走完两年选了「接着走下去」的，
 *  s.extraTo 记着续到第几个月（最多 24+60）；没续过的就是二十四。 */
function lastMonthOf(s) { return (s && s.extraTo) || MONTHS; }

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
 *  这边只把存档接回「第 24 个月刚过完、还没收工」的样子，再照常推进到第 25 个月。
 *
 *  能这么接，是因为 closeOut 动手之前把该动的都存进了 s.preClose：
 *  少了这一份，收工那个月正好换币的局（1949 年 5 月那种）会把那笔折算算两遍。 */
function reopen(s) {
  if (s.phase === 'extra') return { ok: false, say: '这一局已经接着往下走过了，后传只接得上一次。' };
  const room = extraRoom(s);
  const lastYear = SPINE.years[SPINE.years.length - 1].year;
  if (!room) return { ok: false, say: `年卡只写到 ${lastYear} 年 12 月，这一局已经走到头了，接不下去。` };
  const p = s.preClose;
  if (!p) {
    /* 这个功能之前收的工，没存下那一份。收工那个月没换钱的话，closeOut 只改了 s.n，
     * 把它退回去就够了；真赶上换钱的那几局（1935-11、1948-08、1949-05、1955-03）
     * 没法原样退，只能顶回去——硬接的话那笔折算会算两遍。 */
    if (s.endSwitched) return { ok: false, say: '这一局收工那个月正好赶上换钱，接不回去了。' };
    s.n = MONTHS;
  } else {
    s.cash = p.cash; s.assets = p.assets; s.debts = p.debts; s.currency = p.currency;
    s.n = p.n; s.year = p.year; s.month = p.month;
  }
  delete s.preClose; delete s.endSwitched;
  s.extraTo = MONTHS + room;
  s.phase = 'extra';
  s.status = 'extra';
  const events = advanceTo(s, MONTHS + 1);
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
  const incomeReal = startIncome * worthOf(startYear, startMonth);   // 开局那个月的年收入，折到那一年 1 月
  const gainReal = years * incomeReal;
  const W = WORLD.years[String(startYear)];
  const worldUsd = W ? gainReal * W.usdPerUnit / W.gdpIndex : 0;

  return {
    year: startYear, month: startMonth, nick: s.nick, city: s.city,
    endYear: s.year, endMonth: s.month,
    /* 开局那个月和收工那个月不是同一种钱，两头各自带自己的币种。
     * 原来只给一个 currency，前端拿它套所有的数，于是 1948 年 8 月的结算页
     * 印出「开局本钱 1.84 亿金圆券」——那个数其实是法币。 */
    currency: endCur,
    startCurrency: startCur,
    startCash: s.startWorth,
    startCashText: money(s.startWorth, startCur),
    income: startIncome,
    incomeText: money(startIncome, startCur),
    endWorth: nw,
    yearEarned: gainReal,                       // 年榜按这个排
    yearEarnedText: money(gainReal, startCur),
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
    /* 这份结果是两年那一刻的，还是接着走下去之后的总账 */
    phase: walked.length > MONTHS ? 'extra' : 'main',
    extraMonths: Math.max(0, walked.length - MONTHS),
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
  if (!hasContent(text)) return { ok: false, n, say: '这个月什么都没写。写点想做的事吧，哪怕一句。' };
  if (n > LIST_LIMIT) return { ok: false, n, say: `写了 ${n} 个字，超出 ${n - LIST_LIMIT} 个。上限是 ${LIST_LIMIT} 个汉字（标点和数字不算）。` };
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
const ROLE = /^(工头|老板|掌柜|经理|主管|师傅|账房|巡捕|保长|伙计|学徒|队长|组长|厂长|站长|社长|书记|干事|老大|头儿)/;
function whoKey(who) {
  let k = String(who || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, '');
  const m = ROLE.exec(k);
  if (m && k.length - m[0].length >= 2) k = k.slice(m[0].length);
  return k;
}

/** 把模型这个月给的记忆增量并进存档。返回这次添了些什么，好让界面和日志看得见。 */
function applyMemo(s, delta, at) {
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
    if (at && at.tally) t.tally = oneLine(String(at.tally).match(/净[进出][^；]*$/) || at.tally, 40);
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
  for (const t of (Array.isArray(d.traits) ? d.traits : []).slice(0, 2)) {
    const what = oneLine(t && t.what, 30);
    const note = oneLine(t && t.note, 60);
    if (!what) continue;
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
  { re: /武功|武艺|内力|真气|轻功|点穴|气功|刀枪不入|飞檐走壁|力大无穷|天生神力|以一敌百|百步穿杨/,
    say: '这是个普通人，不会武功，也没有神力' },
  { re: /过目不忘|过耳不忘|一目十行|心算如神|预知|未卜先知|读心|摄魂|催眠|透视|算无遗策|从不出错|永远不会错|无所不知|精通一切|样样精通/,
    say: '本事要在常人的范围里——记性好可以，过目不忘不行' },
  { re: /穿越|重生|系统|金手指|外挂|开挂|异能|超能力|特异功能|法术|魔法|灵力|修仙|长生|不老|不死|时间循环|存档|读档/,
    say: '这里没有超能力，也没有重来一次的机会' },
  { re: /首富|大亨|巨富|富二代|官二代|家财万贯|腰缠万贯|富可敌国|继承[^。，]{0,6}(家产|遗产|万贯|家业)|背景深厚|后台很硬|上头有人|通天的关系/,
    say: '开局的本钱和人脉由那一年定，设定里给自己安家底不算数' },
];

/** 检一句主角设定。空着也行——不写就是个没什么特别的普通人。 */
function checkPersona(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: true, n: 0, text: '' };
  const n = countHan(t);
  if (n > PERSONA_LIMIT) {
    return { ok: false, n, text: '', say: `写了 ${n} 个字，超出 ${n - PERSONA_LIMIT} 个。上限是 ${PERSONA_LIMIT} 个汉字（标点和数字不算）。` };
  }
  for (const r of PERSONA_NO) {
    if (r.re.test(t)) return { ok: false, n, text: '', say: `${r.say}。换个说法再写。` };
  }
  /* 汉字数已经卡住了，这里只是给存档一个原始长度的上限 */
  return { ok: true, n, text: t.slice(0, 160) };
}

module.exports = {
  cleanOptions, cleanRefused, applyMove, offScript, serendipity, marketAt, speculation, venueOf,
  DAYS, MONTHS, MONTHS_EXTRA, LIST_LIMIT, PERSONA_LIMIT, CN, SPINE, TL,
  lastMonthOf, extraRoom, reopen,
  yearOf, scanAnachronism, sayAnachronism, currencyAt, priceAt, worthAt, incomeAt, incomeAtDay,
  money, moneyIn, unitOf, fixScale, fixSigns, unpairedBuys,
  currencyOf, incomeOf, worthOf, nextMonth, startable, monthTop, switchDueAfter, switchOnEntry, reprice, closeOut,
  startingCash, newRun, netWorth, applySwitch, advanceTo, applyMonth, tallyLine, settle, fmtScore, fmtUsd, WORLD,
  countHan, hasContent, checkList, checkPersona,
  newMemo, applyMemo, memoText, MEMO_CAP, MEMO_LIMIT,
};
