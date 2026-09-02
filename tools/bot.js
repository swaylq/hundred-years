'use strict';
/* 机器人打一局：二十四个月一个月一步，走到头出结算。
 *
 *   secret exec OPENROUTER_API_KEY -- node tools/bot.js --runs 1948-08,1962-05,2015-06
 *     --runs y-mm,...   打哪几局（默认 1948-08）
 *     --player template 清单怎么来：template 用年卡里的路子拼（便宜、可复现，标定用）
 *              model    再调一次模型替玩家写清单（贵，端到端演练用）
 *     --local           不调模型，全走本地兜底（不花钱，只验流程接得通）
 *     --quiet           只打结算，不打每天的正文
 *     --seed N          随机种子
 *
 * 日志逐行写进 logs/bot-<年>-<月>-<种子>.jsonl，出了怪事回头能查。
 */
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');
const SIM = require('../sim.js');

const ROOT = path.join(__dirname, '..');
const LOGS = path.join(ROOT, 'logs');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : d; };
const RUNS = String(arg('runs', '1948-08')).split(',');
const PLAYER = String(arg('player', 'template'));
const LOCAL = !!arg('local');
const QUIET = !!arg('quiet');
const SEED0 = Number(arg('seed', 20260902));

const P = require('./player.js');
const rng = P.rng, pick = P.pick;
const templateList = (s, c, r) => P.careful(s, c, r);

/* 让模型替玩家写清单——端到端演练用，更像真人 */
async function modelList(s, c) {
  const OR = require('./or.js');
  const sys = `你在玩一个游戏：你落在 ${s.year} 年的中国，要在两年（二十四个月）里尽量多赚钱。
每个月写一份自己这个月要做的事的清单，${E.LIST_LIMIT} 个汉字以内。
写具体：去哪、找谁、做什么、出多少钱、要什么回报。
不要写这一年还没有的东西。只输出清单本身，不要解释。`;
  const user = `${s.year} 年 ${s.month} 月，第 ${s.n} 个月，你在${s.city}。
手里 ${E.money(s.cash, s.currency)}（这一年一个普通人一年挣 ${E.money(E.incomeOf(s.year, s.month), s.currency)}）。
东西：${s.assets.map(a => a.name).join('、') || '没有'}。体力 ${s.standing.体力}。
${(s.memo && (s.memo.traits || []).filter(t => !t.lost).length) ? `你这两年练出来的：${s.memo.traits.filter(t => !t.lost).map(t => t.what).join('、')}。` : ''}
这一年能挣钱的路子：${(c.money || []).map(m => m.way).join('、')}。
这一年干不了：${(c.forbidden || []).map(f => f.what).join('、')}。
前两个月：${s.months.slice(-2).map(d => (d.tally || '')).join(' / ') || '刚来'}
写这个月的清单。`;
  const t = await OR.call(SIM.MODEL, sys, user, { maxTokens: 500, temperature: 0.9, tries: 2 });
  return String(t).slice(0, 1200);
}

/* ── 打一局 ────────────────────────────────────────── */
async function playOne(year, month, seed) {
  const s = E.newRun({ year, month, nick: '机器人', seed });
  const r = rng(seed);
  fs.mkdirSync(LOGS, { recursive: true });
  const logf = path.join(LOGS, `bot-${year}-${String(month).padStart(2, '0')}-${seed}.jsonl`);
  const log = fs.createWriteStream(logf);
  const t0 = Date.now();
  let modelDays = 0, localDays = 0, retried = 0;

  for (let i = 1; i <= E.MONTHS; i++) {
    const c = SIM.card(s.year);                       // 跨年之后要换成那一年的年卡
    const list = PLAYER === 'model' && !LOCAL ? await modelList(s, c) : templateList(s, c, r);
    const chk = E.checkList(list);
    if (!chk.ok) throw new Error(`第 ${i} 个月的清单没过字数：${chk.say}`);

    let out;
    if (LOCAL) { out = SIM.runMonthLocal(s, list); localDays++; }
    else {
      try { out = await SIM.runMonth(s, list); modelDays++; }
      catch (err) { out = SIM.runMonthLocal(s, list); localDays++; out.why = err.message; }
    }

    const curNow = E.currencyOf(s.year, s.month);
    const at = { n: s.n, year: s.year, month: s.month };
    const res = E.applyMonth(s, out.delta);
    const memoAdd = E.applyMemo(s, out.delta, at);
    const tally = E.tallyLine(res.entries, curNow);
    s.months.push({ ...at, list, story: out.delta.story, tally, refused: out.delta.refused || [], capped: res.capped, missedGoods: res.missedGoods || null });
    const switched = i < E.MONTHS ? E.advanceTo(s, i + 1) : [E.closeOut(s)].filter(Boolean);
    log.write(JSON.stringify({
      n: at.n, year: at.year, month: at.month, list, story: out.delta.story,
      cash: res.cash, entries: res.entries, tally,
      refused: out.delta.refused || [], capped: res.capped, local: !!out.local,
      /* 模型这个月的账写小了几个数量级、被引擎补回来了：回头查日志时要看得见 */
      rescaled: res.rescaled ? res.rescaled.zeros : 0,
      flipped: res.flipped ? res.flipped.flipped : [],
      options: out.delta.options || [],
      switched: switched.map(x => x.say),
      netWorth: E.netWorth(s), standing: { ...s.standing }, memoAdd, memo: s.memo,
      assets: s.assets.map(a => ({ name: a.name, kind: a.kind, worth: a.worth })),
      missedGoods: res.missedGoods || null,
    }) + '\n');

    if (!QUIET) {
      console.log(`  ${at.year} 年 ${String(at.month).padStart(2)} 月  家底 ${E.money(E.netWorth(s), curNow).padStart(16)}  ${tally.slice(0, 46)}${res.capped ? '  [削顶]' : ''}${res.rescaled ? `  [补了${res.rescaled.zeros}个零]` : ''}${res.flipped ? `  [翻了${res.flipped.flipped.length}个负号]` : ''}${out.local ? '  [本地]' : ''}`);
    }
    if (switched.length) console.log(`         ※ ${switched[0].say}`);
  }

  const result = E.settle(s);
  log.write(JSON.stringify({ result }) + '\n');
  log.end();
  return { result, s, secs: (Date.now() - t0) / 1000, modelDays, localDays, logf };
}

/* ── 跑 ────────────────────────────────────────────── */
(async () => {
  const rows = [];
  for (const spec of RUNS) {
    const m = String(spec).match(/^(\d{4})[-/]?(\d{1,2})$/);
    if (!m) { console.error(`看不懂 --runs 里的「${spec}」，要写成 1948-08 这样`); process.exit(2); }
    const year = +m[1], month = +m[2];
    if (!fs.existsSync(path.join(ROOT, 'data', 'years', `${year}.json`))) { console.error(`${year} 年的年卡还没生成`); process.exit(2); }
    console.log(`\n═══ ${year} 年 ${month} 月 ═══`);
    const out = await playOne(year, month, SEED0 + year * 13 + month);
    const R = out.result;
    console.log(`  结算：${R.scoreText}（${out.secs.toFixed(0)} 秒，模型 ${out.modelDays} 个月 / 本地 ${out.localDays} 个月）`);
    console.log(`  ${R.year}-${R.month} → ${R.endYear}-${R.endMonth}，家底 ${R.startCash.toPrecision(4)} ${E.CN[R.startCurrency]} → ${R.endWorth.toPrecision(4)} ${E.CN[R.currency]}，削顶 ${R.capHits} 次`);
    console.log(`  日志 ${path.relative(process.cwd(), out.logf)}`);
    rows.push({ year, month, score: R.score, days: out.s.months.length, secs: out.secs, capHits: R.capHits });
  }
  console.log('\n── 汇总 ──');
  for (const r of rows) console.log(`  ${r.year}-${String(r.month).padStart(2, '0')}  ${r.days} 个月  ${E.fmtScore(r.score)}`);
  const bad = rows.filter(r => r.days !== E.MONTHS);
  if (bad.length) { console.log(`\n没走满 ${E.MONTHS} 个月的：${bad.map(b => b.year).join(' ')}`); process.exit(1); }
  if (!process.argv.includes('--local')) console.log(`\n${require('./or.js').report()}`);
})();
