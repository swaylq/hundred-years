'use strict';
/* 把世界 GDP 和汇率摊成逐年，写出 data/world.json，并自检。
 *
 *   node tools/build-world.js [--check]
 *
 * 1926–1959 的世界 GDP 是构造的（见 data/world-src.js 顶上的说明），
 * 用三个锚点把它拉正：让 1940 和 1950 两年恰好落在 Maddison 的锚点上。
 */
const fs = require('fs');
const path = require('path');
const S = require('../data/world-src.js');

const OUT = path.join(__dirname, '..', 'data', 'world.json');
const WB = path.join(__dirname, '..', 'data', 'world-gdp-worldbank.json');
const problems = [];
const warn = m => problems.push(m);

if (!fs.existsSync(WB)) {
  console.error(`缺 ${path.relative(process.cwd(), WB)}——先跑：
  curl -sL "https://api.worldbank.org/v2/country/WLD/indicator/NY.GDP.MKTP.KD?format=json&per_page=200" \\
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
      const o={};for(const r of j[1])if(r.value)o[r.date]=r.value;
      process.stdout.write(JSON.stringify(o,null,1))})' > data/world-gdp-worldbank.json`);
  process.exit(2);
}
const wb = JSON.parse(fs.readFileSync(WB, 'utf8'));

/* ── 1926–1959：按 SHAPE 累乘，再拉到锚点上 ─────────────── */
const gdp = {};
for (let y = 1960; y <= 2025; y++) {
  if (wb[y] == null) warn(`世界银行序列缺 ${y} 年`);
  else gdp[y] = wb[y];
}

/* 先从 1960 往回推（用 SHAPE 的倒数），得到一条未校正的 1926–1959 */
const rough = { 1960: gdp[1960] };
for (let y = 1959; y >= 1926; y--) {
  const g = S.SHAPE[y + 1];
  if (g == null) { warn(`SHAPE 缺 ${y + 1} 年的增长率`); rough[y] = rough[y + 1]; continue; }
  rough[y] = rough[y + 1] / (1 + g);
}

/* 用 1940 和 1950 两个锚点做一次线性（对数上线性）校正，
 * 这样这两年正好落在 Maddison 上，1960 年那头保持不动。 */
const need1950 = Math.log(S.ANCHOR[1950] / rough[1950]);
const need1940 = Math.log(S.ANCHOR[1940] / rough[1940]);
for (let y = 1926; y <= 1959; y++) {
  /* 1960 处校正为 0，1950 处为 need1950，1940 及更早按 1940 的量线性外推到 1926 */
  let adj;
  if (y >= 1950) adj = need1950 * (1960 - y) / 10;
  else if (y >= 1940) adj = need1950 + (need1940 - need1950) * (1950 - y) / 10;
  else adj = need1940;                       // 1926–1939 沿用 1940 的校正量
  gdp[y] = rough[y] * Math.exp(adj);
}

/* ── 汇率 ───────────────────────────────────────────── */
const fx = {};
for (let y = 1926; y <= 2025; y++) {
  if (S.FX[y] == null) warn(`汇率表缺 ${y} 年`);
  else fx[y] = S.FX[y];
}

/* ── 自检 ───────────────────────────────────────────── */
for (let y = 1926; y <= 2025; y++) {
  if (!(gdp[y] > 0) || !isFinite(gdp[y])) warn(`${y} 年世界 GDP 不是正数`);
  if (!(fx[y] > 0) || !isFinite(fx[y])) warn(`${y} 年汇率不是正数`);
}
/* 世界 GDP 只在大萧条和二战末年可以掉，其余年份不许掉过 3% */
for (let y = 1927; y <= 2025; y++) {
  const g = gdp[y] / gdp[y - 1] - 1;
  const okDown = (y >= 1930 && y <= 1933) || (y >= 1945 && y <= 1946) || y === 2009 || y === 2020;
  if (g < -0.03 && !okDown) warn(`${y} 年世界 GDP 掉了 ${(-g * 100).toFixed(1)}%，这一年不该掉这么多`);
  if (g > 0.12) warn(`${y} 年世界 GDP 涨了 ${(g * 100).toFixed(1)}%，太快`);
}
/* 三个锚点必须对上 */
for (const y of [1940, 1950]) {
  const off = gdp[y] / S.ANCHOR[y];
  if (Math.abs(off - 1) > 0.02) warn(`${y} 年没落在 Maddison 锚点上，差 ${((off - 1) * 100).toFixed(1)}%`);
}
/* 1929→1932 应当掉掉一成半上下 */
const dep = 1 - gdp[1932] / gdp[1929];
if (dep < 0.10 || dep > 0.22) warn(`1929→1932 掉了 ${(dep * 100).toFixed(1)}%，跟「约 15%」对不上`);

/* ── 报告 ───────────────────────────────────────────── */
console.log('世界 GDP（2015 年不变价美元，万亿）');
console.log(' ' + [1926, 1929, 1932, 1940, 1945, 1950, 1960, 1980, 2000, 2020, 2025]
  .map(y => `${y}:${(gdp[y] / 1e12).toFixed(1)}`).join('  '));
console.log(`1929→1932 掉了 ${(dep * 100).toFixed(1)}%；1926 年的世界经济是 2025 年的 1/${(gdp[2025] / gdp[1926]).toFixed(0)}`);
console.log('\n1 单位当年的钱值多少美元');
console.log(' ' + [1926, 1935, 1940, 1947, 1949, 1955, 1980, 1994, 2025]
  .map(y => `${y}:${fx[y] < 0.001 ? fx[y].toExponential(1) : fx[y].toFixed(3)}`).join('  '));

if (problems.length) {
  console.log(`\n自检没过，${problems.length} 条：`);
  for (const p of problems) console.log('  x ' + p);
  process.exit(1);
}
console.log('\n自检全过');

if (!process.argv.includes('--check')) {
  const years = {};
  for (let y = 1926; y <= 2025; y++) {
    years[y] = {
      gdp: gdp[y],
      gdpIndex: gdp[y] / gdp[2025],          // 折算就用这个：当年世界经济是今天的几分之几
      usdPerUnit: fx[y],
      usdPerUnitAfterSwitch: S.FX_AFTER_SWITCH[y] || null,
      confidence: y <= 1959 ? '构造' : '实测',
    };
  }
  fs.writeFileSync(OUT, JSON.stringify({
    说明: '总榜的折算底数。gdpIndex 是「当年的世界经济相当于 2025 年的几分之几」，usdPerUnit 是「1 单位当年的钱值多少美元」。1926–1959 的 GDP 是按锚点构造的，见 data/world-src.js。',
    来源: {
      '世界 GDP 1960–2025': '世界银行 NY.GDP.MKTP.KD（不变价 2015 美元）',
      '世界 GDP 1920/1940/1950 锚点': 'Maddison Project / Our World in Data «Global GDP over the long run»',
      '世界 GDP 1926–1959 逐年': '构造：三个锚点 + 大萧条/战时/战后的已知幅度，见 data/world-src.js',
      汇率: S.FX_SOURCE,
    },
    years,
  }, null, 1));
  console.log(`写出 ${path.relative(process.cwd(), OUT)}`);
}
