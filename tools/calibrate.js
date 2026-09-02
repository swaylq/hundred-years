'use strict';
/* 排行榜跨年代到底比不比得了——用机器人打一批局，看分数分布。
 *
 *   secret exec OPENROUTER_API_KEY -- node tools/calibrate.js [--per 5] [--jobs 10]
 *     --per N    每个年代打几局，默认 5
 *     --jobs N   同时打几局，默认 8
 *     --months N 每局只走前 N 个月（试跑时压成本，默认走满 24）
 *
 * 判据不是「各年代一样高」——那不可能也不该。判据是差别在一个量级里：
 * 没有哪个年代的中位数比全体中位数高 8 倍或低 1/8。
 * 高出去说明那一年太好刷，低下去说明那一年根本没得玩。
 */
const path = require('path');
const fs = require('fs');
const E = require('../engine.js');
const SIM = require('../sim.js');
const OR = require('./or.js');

const ROOT = path.join(__dirname, '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const PER = arg('per', 5);
const JOBS = arg('jobs', 8);
const MONTHS = arg('months', arg('days', E.MONTHS));
const SPREAD = 8;                       // 允许的倍数

const DECADES = [1920, 1930, 1940, 1950, 1960, 1970, 1980, 1990, 2000, 2010];

const P = require('./player.js');
const rng = P.rng;
const templateList = (s, c, r) => P.careful(s, c, r);
const lazyList = s => P.lazy(s);

async function playOne(year, month, seed, how = 'careful') {
  const s = E.newRun({ year, month, nick: '标定', seed });
  const r = rng(seed);
  let capped = 0, localDays = 0;
  for (let i = 1; i <= MONTHS; i++) {
    const c = SIM.card(s.year);                      // 跨年之后换成那一年的年卡
    const list = how === 'lazy' ? lazyList(s) : templateList(s, c, r);
    let out;
    try { out = await SIM.runMonth(s, list); }
    catch (err) { out = SIM.runMonthLocal(s, list); localDays++; }
    const at = { n: s.n, year: s.year, month: s.month };
    const res = E.applyMonth(s, out.delta);
    if (res.capped) capped++;
    const tl = E.tallyLine(res.entries, E.currencyOf(at.year, at.month));
    s.months.push({ ...at, tally: tl });
    if (i < MONTHS) E.advanceTo(s, i + 1); else E.closeOut(s);
  }
  const R = E.settle(s);
  /* 只走了一部分月份的话，按比例折算成满局，好跟走满的比 */
  const score = MONTHS === E.MONTHS ? R.score : R.score * (E.MONTHS / MONTHS);
  return { year, month, score, capped, localDays, ceiling: E.yearOf(year).ceiling };
}

const median = a => { const b = [...a].sort((x, y) => x - y); const n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; };
const quart = (a, q) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.round((b.length - 1) * q)))]; };

(async () => {
  const jobs = [];
  for (const d of DECADES) {
    for (let i = 0; i < PER; i++) {
      const year = d + Math.floor(i * 10 / PER) + (d === 1920 ? 6 : 0);   // 1920 年代只有 1926–1929
      const y = Math.min(2025, Math.max(1926, year));
      const month = 1 + (i * 5) % 12;
      jobs.push({ decade: d, year: y, month, seed: 900000 + y * 37 + month });
    }
  }
  console.log(`标定：${DECADES.length} 个年代 × ${PER} 局 = ${jobs.length} 局，每局 ${DAYS} 天，并发 ${JOBS}`);
  console.log(`模型 ${SIM.MODEL}\n`);

  const t0 = Date.now();
  let done = 0;
  const out = await OR.pool(jobs, JOBS, async j => {
    const r = await playOne(j.year, j.month, j.seed);
    done++;
    if (done % 5 === 0) console.log(`  ${done}/${jobs.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${OR.report()}`);
    return { ...r, decade: j.decade };
  });

  const byDec = new Map();  // eslint-disable-line
  for (const r of out) { if (!byDec.has(r.decade)) byDec.set(r.decade, []); byDec.get(r.decade).push(r.score); }
  const all = out.map(r => r.score);
  const M = median(all);

  const meds = [];
  console.log('\n年代      局数   下四分位      中位      上四分位   上限');
  for (const d of DECADES) {
    const a = byDec.get(d) || [];
    if (!a.length) continue;
    const m = median(a);
    const ceil = E.yearOf(d === 1920 ? 1926 : d + 5).ceiling;
    meds.push({ d, m });
    console.log(`${d} 年代  ${String(a.length).padStart(4)}  ${quart(a, .25).toFixed(2).padStart(10)}  ${m.toFixed(2).padStart(9)}  ${quart(a, .75).toFixed(2).padStart(10)}  ${String(ceil).padStart(5)}` +
      (m <= 0 ? '   ← 这个年代赚不到钱' : ''));
  }
  const dead = meds.filter(x => x.m <= 0);
  const lo = meds.reduce((a, b) => (b.m < a.m ? b : a), meds[0]);
  const hi = meds.reduce((a, b) => (b.m > a.m ? b : a), meds[0]);
  const spread = lo.m > 0 ? hi.m / lo.m : Infinity;
  const off = [];
  if (dead.length) off.push(...dead.map(x => ({ d: x.d, m: x.m, ratio: 0, why: '中位数不是正的' })));
  else if (spread > SPREAD) off.push({ d: `${hi.d} 对 ${lo.d}`, m: hi.m, ratio: spread, why: '两端差得太开' });
  console.log(`\n全体中位数 ${M.toFixed(2)} 年的收入，${all.length} 局`);
  console.log(`最高的年代 ${hi.d}（${hi.m.toFixed(2)}）是最低的 ${lo.d}（${lo.m.toFixed(2)}）的 ${spread === Infinity ? '∞' : spread.toFixed(1)} 倍，上限 ${SPREAD} 倍`);
  const capped = out.reduce((t, r) => t + r.capped, 0);
  const loc = out.reduce((t, r) => t + r.localDays, 0);
  console.log(`削顶 ${capped} 天次，退回本地演算 ${loc} 天次`);
  console.log(OR.report());

  /* 认真 vs 敷衍：四个年代，每个年代**三个种子各来一对**，比中位数。
   * 一对一比是量不出来的——同一年同一个月换个种子，分数能从 −0.28 摆到 +0.90，
   * 局与局之间的运气比「写得认不认真」这件事本身还大。 */
  console.log('\n认真打 vs 敷衍打（每个年代三个种子，比中位数）');
  const SEEDS = [777001, 777002, 777003];
  const pairs = [];
  for (const [y, m] of [[1930, 5], [1962, 5], [1988, 5], [2015, 5]]) for (const sd of SEEDS) pairs.push({ y, m, sd });
  const raw = await OR.pool(pairs, JOBS, async ({ y, m, sd }) => {
    const a = await playOne(y, m, sd + y, 'careful');
    const b = await playOne(y, m, sd + y, 'lazy');
    return { y, m, sd, careful: a.score, lazy: b.score };
  });
  const duel = [];
  let skillBad = 0;
  for (const [y, m] of [[1930, 5], [1962, 5], [1988, 5], [2015, 5]]) {
    const rows = raw.filter(r => r.y === y);
    const cm = median(rows.map(r => r.careful));
    const lm = median(rows.map(r => r.lazy));
    const win = cm > lm;
    if (!win) skillBad++;
    duel.push({ y, m, careful: cm, lazy: lm, runs: rows.map(r => [r.careful, r.lazy]) });
    console.log(`  ${win ? '·' : 'x'} ${y} 年 ${m} 月：认真中位 ${cm.toFixed(2)}  敷衍中位 ${lm.toFixed(2)}` +
      (win ? `  高出 ${(cm - lm).toFixed(2)} 年的收入` : '  —— 认真打反而不如敷衍打') +
      `   三局分别是 ${rows.map(r => r.careful.toFixed(2)).join('/')}`);
  }

  fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'logs', 'calibrate.json'), JSON.stringify({ at: Date.now(), per: PER, days: DAYS, rows: out, duel }, null, 1));

  if (skillBad) {
    console.log(`\n没过：有 ${skillBad} 组认真打不如敷衍打——分数跟玩家写什么没关系，这是最要命的一条`);
    process.exit(1);
  }
  if (off.length) {
    console.log(`\n没过：${off.map(o => `${o.d} 年代——${o.why}`).join('；')}`);
    console.log(`该调的是那几年年卡里 money 的 ceilingYears，不是分数公式。`);
    process.exit(1);
  }
  console.log('\n过了：认真打都高过敷衍打；每个年代都赚得到钱；最高最低差在 ' + SPREAD + ' 倍以内');
})();
