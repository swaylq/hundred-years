'use strict';
/* 把手写的年度数字摊成「每年每月」，并核对自己算得对不对。
 *
 *   node tools/build-spine.js          核对 + 写出 data/spine.json
 *   node tools/build-spine.js --check  只核对，不写
 *
 * 每个月三个数：
 *   currency  这个月手里是什么钱
 *   income    这个月的年化中位收入，以这个月的钱计
 *   worth     这个月的 1 块钱，值 1 月的多少块钱（按买得到多少东西算）
 *             —— 通胀和换币都折进这一个数里，1 月固定是 1
 *
 * 结算就靠 worth：
 *   分数 =（期末家底 × worth[末月] − 开局家底 × worth[首月]）÷ 当年 1 月的中位年收入
 * 分子分母都换算到同一种钱，所以三次换币不影响排名。
 */
const fs = require('fs');
const path = require('path');
const S = require('../data/spine-src.js');

const OUT = path.join(__dirname, '..', 'data', 'spine.json');
const CHECK_ONLY = process.argv.includes('--check');
const problems = [];
const warn = m => problems.push(m);

function currencyAt(year, month) {
  const sw = S.SWITCHES[year];
  if (sw && month >= sw.month) return S.CURRENCIES.find(c => c.code === sw.to);
  const before = sw ? sw.from : null;
  if (before) return S.CURRENCIES.find(c => c.code === before);
  const c = S.CURRENCIES.find(c => year >= c.from && year <= c.to);
  if (!c) throw new Error(`${year} 年没有对应货币`);
  return c;
}

/* 年内 12 个月的物价指数：手写的优先，否则按年通胀率按月开方摊平 */
function priceIdx(year) {
  if (S.PRICE_IDX[year]) return S.PRICE_IDX[year].slice();
  const r = S.INFL[year];
  return Array.from({ length: 12 }, (_, i) => Math.pow(1 + r, i / 12));
}

/* 收入按「货币分段」分段插值：每一段有起点和终点，中间几何插值。
 * 不让收入跟着物价走——1950 年物价一季度冲高又被压回去，工资并没有跟着上下。
 * 一段的终点：这一年没换币就是下一年 1 月（同一种钱，接得上）；
 * 换了币，前一段的终点是 incomeBefore，后一段从 incomeAfter 起、走到下一年 1 月。 */
function nextJan(y) {
  if (S.INCOME[y + 1]) return S.INCOME[y + 1][0];
  const cur = S.INCOME[y][0], prev = S.INCOME[y - 1][0];
  return cur * (cur / prev);                       // 2025 之后没有数，按上一年的增速外推一格
}

const years = [];
for (let y = 1926; y <= 2025; y++) {
  const [incJan, src] = S.INCOME[y];
  const pi = priceIdx(y);
  const sw = S.SWITCHES[y];

  const segs = sw
    ? [{ a: 1, b: sw.month, from: incJan, to: sw.incomeBefore },
       { a: sw.month, b: 13, from: sw.incomeAfter, to: nextJan(y) }]
    : [{ a: 1, b: 13, from: incJan, to: nextJan(y) }];

  const redenom = sw ? sw.incomeBefore / sw.incomeAfter : 1;
  if (sw && sw.decreed) {
    const off = redenom / sw.decreed;
    if (off < 0.5 || off > 2) warn(`${y} 年换币：由收入反解的比价 ${redenom.toExponential(3)} 跟公布的 ${sw.decreed.toExponential(3)} 差 ${off.toFixed(2)} 倍`);
  }

  const income = new Array(13);
  for (const g of segs) {
    const n = g.b - g.a;                            // 这一段跨几个月
    for (let m = g.a; m < g.b; m++) income[m] = g.from * Math.pow(g.to / g.from, (m - g.a) / n);
  }

  const months = [];
  for (let m = 1; m <= 12; m++) {
    const rd = (sw && m >= sw.month) ? redenom : 1;
    months.push({
      month: m,
      currency: currencyAt(y, m).code,
      income: income[m],                            // 年化中位收入，当月货币
      worth: rd / pi[m - 1],                        // 当月 1 块 = 1 月的多少块（按买得到的东西算）
      priceIdx: pi[m - 1],                          // 物价，该年 1 月 = 1，不含换币
    });
  }

  years.push({
    year: y,
    city: S.cityOf(y),
    ceiling: S.ceilingOf(y),
    incomeSource: src,
    inflation: S.INFL[y],
    currencies: [...new Set(months.map(m => m.currency))],
    switch: sw ? { month: sw.month, day: sw.day, from: sw.from, to: sw.to,
                   rate: redenom, decreed: sw.decreed, playerRate: sw.playerRate, say: sw.say } : null,
    months,
  });
}

/* ── 自检 ───────────────────────────────────────────── */

// 1. 跨年不能跳：同一种货币下，今年 1 月对去年 12 月，落在 0.6–2.5 倍之间；
//    恶性通胀年份按去年年底的实际月涨幅放宽
for (let i = 1; i < years.length; i++) {
  const prev = years[i - 1], cur = years[i];
  const pm = prev.months[11], cm = cur.months[0];
  if (pm.currency !== cm.currency) { warn(`${cur.year} 年 1 月跟 ${prev.year} 年 12 月不是同一种钱`); continue; }
  const lastMonthly = prev.months[11].priceIdx / prev.months[10].priceIdx;
  const hi = Math.max(2.5, lastMonthly * 2.5);
  const ratio = cm.income / pm.income;
  if (ratio < 0.6 || ratio > hi) {
    warn(`${cur.year} 年 1 月中位收入 ${cm.income.toPrecision(4)} 对 ${prev.year} 年 12 月 ${pm.income.toPrecision(4)}，差 ${ratio.toFixed(2)} 倍（允许 0.6–${hi.toFixed(1)}）`);
  }
}

// 2. worth：1 月必须是 1；通胀年份里钱只会越来越不值钱（换币那个月除外）
for (const y of years) {
  if (Math.abs(y.months[0].worth - 1) > 1e-9) warn(`${y.year} 年 1 月的 worth 不是 1`);
  if (y.inflation > 0.02) for (let m = 1; m < 12; m++) {
    if (y.switch && m + 1 === y.switch.month) continue;
    if (y.months[m].worth > y.months[m - 1].worth * 1.0001) { warn(`${y.year} 年 ${m + 1} 月：通胀年份里钱反而更值钱了`); break; }
  }
}

// 3. 每个数都要是正的、有限的
for (const y of years) for (const m of y.months) {
  if (!(m.income > 0) || !isFinite(m.income)) warn(`${y.year}-${m.month} 收入不是正数：${m.income}`);
  if (!(m.worth > 0) || !isFinite(m.worth)) warn(`${y.year}-${m.month} worth 不是正数：${m.worth}`);
  if (!(m.priceIdx > 0) || !isFinite(m.priceIdx)) warn(`${y.year}-${m.month} 物价不是正数`);
}

// 4. 货币分段要覆盖，换币前后必须真的换了
for (const y of years) {
  for (const c of y.currencies) if (!S.CURRENCIES.some(x => x.code === c)) warn(`${y.year} 用了没定义的货币 ${c}`);
  if (y.switch) {
    if (y.months[y.switch.month - 2].currency === y.months[y.switch.month - 1].currency) warn(`${y.year} 标了换币，前后却是同一种钱`);
    if (!(y.switch.playerRate > 0)) warn(`${y.year} 换币缺 playerRate（玩家手里的现金按什么比价换）`);
  }
}

// 5. 一局最长跨一个月，所以真正要准的是「这个月 1 号到 30 号物价涨多少」。
//    查它有没有荒唐值：任何一个月的月内涨幅不能超过 20 倍。
for (const y of years) for (let m = 1; m < 12; m++) {
  const r = y.months[m].priceIdx / y.months[m - 1].priceIdx;
  if (r > 20) warn(`${y.year} 年 ${m + 1} 月物价比上月涨了 ${r.toFixed(0)} 倍，太离谱`);
}

/* ── 报告 ───────────────────────────────────────────── */
console.log(`年份 ${years[0].year}–${years[years.length - 1].year}，共 ${years.length} 年`);
console.log(`货币分段 ${S.CURRENCIES.length} 段，年中换币 ${Object.keys(S.SWITCHES).length} 次`);
for (const y of Object.keys(S.SWITCHES).map(Number)) {
  const Y = years.find(x => x.year === y);
  const d = Y.switch.decreed;
  console.log(`  ${y}-${Y.switch.month} ${Y.switch.from}→${Y.switch.to}  反解比价 ${Y.switch.rate.toExponential(3)}` +
    (d ? `  公布 ${d.toExponential(3)}  偏 ${(Y.switch.rate / d).toFixed(2)}×` : '  （当年无统一公布比价）'));
}
const nbs = years.filter(y => y.incomeSource === 'nbs').length;
console.log(`收入来源：统计局序列 ${nbs} 年，估算 ${years.length - nbs} 年`);

if (problems.length) {
  console.log(`\n自检没过，${problems.length} 条：`);
  for (const p of problems) console.log('  ✗ ' + p);
  process.exit(1);
}
console.log('\n自检全过');

if (!CHECK_ONLY) {
  fs.writeFileSync(OUT, JSON.stringify({ currencies: S.CURRENCIES, years }, null, 1));
  console.log(`写出 ${path.relative(process.cwd(), OUT)}，${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
}
