'use strict';
/* 机器人打一局：从第 1 天走到第 30 天，出结算。
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
  const sys = `你在玩一个游戏：你落在 ${s.year} 年的中国，要在三十天里尽量多赚钱。
每天写一份自己今天要做的事的清单，${E.LIST_LIMIT} 个汉字以内。
写具体：去哪、找谁、做什么、出多少钱、要什么回报。
不要写这一年还没有的东西。只输出清单本身，不要解释。`;
  const user = `${s.year} 年 ${s.month} 月 ${s.day} 日，你在${s.city}。
手里 ${E.money(s.cash, s.currency)}（这一年一个普通人一年挣 ${E.money(E.incomeAtDay(s.year, s.month, s.day), s.currency)}）。
东西：${s.assets.map(a => a.name).join('、') || '没有'}。体力 ${s.standing.体力}。
这一年能挣钱的路子：${(c.money || []).map(m => m.way).join('、')}。
这一年干不了：${(c.forbidden || []).map(f => f.what).join('、')}。
前两天：${s.days.slice(-2).map(d => (d.tally || '')).join(' / ') || '刚来'}
写今天的清单。`;
  const t = await OR.call(SIM.MODEL, sys, user, { maxTokens: 500, temperature: 0.9, tries: 2 });
  return String(t).slice(0, 1200);
}

/* ── 打一局 ────────────────────────────────────────── */
async function playOne(year, month, seed) {
  const c = SIM.card(year);
  const s = E.newRun({ year, month, nick: '机器人', seed });
  const r = rng(seed);
  fs.mkdirSync(LOGS, { recursive: true });
  const logf = path.join(LOGS, `bot-${year}-${String(month).padStart(2, '0')}-${seed}.jsonl`);
  const log = fs.createWriteStream(logf);
  const t0 = Date.now();
  let modelDays = 0, localDays = 0, retried = 0;

  for (let day = 1; day <= E.DAYS; day++) {
    const list = PLAYER === 'model' && !LOCAL ? await modelList(s, c) : templateList(s, c, r);
    const chk = E.checkList(list);
    if (!chk.ok) throw new Error(`第 ${day} 天的清单没过字数：${chk.say}`);

    let out;
    if (LOCAL) { out = SIM.runDayLocal(s, list); localDays++; }
    else {
      try { out = await SIM.runDay(s, list); modelDays++; }
      catch (err) { out = SIM.runDayLocal(s, list); localDays++; out.why = err.message; }
    }

    const curNow = E.currencyAt(year, month, s.day);
    const res = E.applyDay(s, out.delta);
    const tally = E.tallyLine(res.entries, curNow);
    const switched = E.advanceTo(s, s.day + 1);
    s.days.push({ day, list, story: out.delta.story, tally, refused: out.delta.refused || [], capped: res.capped });
    log.write(JSON.stringify({
      day, list, story: out.delta.story, cash: res.cash, entries: res.entries, tally,
      refused: out.delta.refused || [], capped: res.capped, local: !!out.local,
      switched: switched.map(x => x.say),
      netWorth: E.netWorth(s), standing: { ...s.standing },
    }) + '\n');

    if (!QUIET) {
      const cur = E.currencyAt(year, month, Math.min(s.day, E.DAYS));
      console.log(`  第 ${String(day).padStart(2)} 天  家底 ${E.money(E.netWorth(s), cur).padStart(16)}  ${tally.slice(0, 46)}${res.capped ? '  [削顶]' : ''}${out.local ? '  [本地]' : ''}`);
    }
    if (switched.length) console.log(`         ※ ${switched[0].say}`);
  }

  if (s.day > E.DAYS) s.day = E.DAYS;
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
    console.log(`  结算：${R.scoreText}（${out.secs.toFixed(0)} 秒，模型 ${out.modelDays} 天 / 本地 ${out.localDays} 天）`);
    console.log(`  家底 ${R.startCash.toPrecision(4)} → ${R.endWorth.toPrecision(4)} ${E.CN[R.currency]}，削顶 ${R.capHits} 次`);
    console.log(`  日志 ${path.relative(process.cwd(), out.logf)}`);
    rows.push({ year, month, score: R.score, days: out.s.days.length, secs: out.secs, capHits: R.capHits });
  }
  console.log('\n── 汇总 ──');
  for (const r of rows) console.log(`  ${r.year}-${String(r.month).padStart(2, '0')}  ${r.days} 天  ${E.fmtScore(r.score)}`);
  const bad = rows.filter(r => r.days !== E.DAYS);
  if (bad.length) { console.log(`\n没走满三十天的：${bad.map(b => b.year).join(' ')}`); process.exit(1); }
  if (!process.argv.includes('--local')) console.log(`\n${require('./or.js').report()}`);
})();
