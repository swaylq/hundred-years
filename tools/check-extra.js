'use strict';
/* 「接着走下去」那一套的检查。不调模型，不花钱，一秒钟跑完。
 *
 * 最要紧的两条：
 *   ① **两年那一刻的成绩是冻住的** —— 结过一次账，库里那几列再也改不动。
 *      闸在 db.js 的 `q.fin` 的 WHERE 里，不是靠调用方记得别调。
 *   ② **收工那个月正好换钱的局，接下去不许把那笔折算算两遍**。
 *      1947 年 6 月开局，第 24 个月正好是 1949 年 5 月——换币就在这个月月底。
 *      closeOut 折过一次，reopen 要能原样退回去，让 advanceTo 正常折那一次。
 */
const os = require('os'), fs = require('fs'), path = require('path');
const DBF = path.join(os.tmpdir(), 'hy-check-extra.db');
for (const f of [DBF, DBF + '-wal', DBF + '-shm']) { try { fs.unlinkSync(f); } catch (e) {} }
process.env.HY_DB = DBF;

const E = require('../engine.js');
const DB = require('../db.js');
const SIM = require('../sim.js');

let bad = 0;
const fail = m => { bad++; console.log('  x ' + m); };
const ok = m => console.log('  · ' + m);
const near = (a, b, tol) => Math.abs(a - b) <= Math.abs(tol);

/** 从某年某月起走满 n 个月，每个月记一笔账（不记的话整局封顶没法按走过的年份算） */
function walk(s, to, each) {
  const events = [];
  while (s.n <= to) {
    if (each) each(s, s.n);
    s.months.push({ n: s.n, year: s.year, month: s.month, story: '过了一个月', tally: '没有进出' });
    if (s.n < to) events.push(...E.advanceTo(s, s.n + 1));
    else { const ev = E.closeOut(s); if (ev) events.push(ev); break; }
  }
  return events;
}
const start = (y, m) => E.newRun({ year: y, month: m, nick: '试', seed: y * 31 + m });

/* 1. 还能走几个月 —————————————————————————— */
console.log('1. 还能往下走几个月，按年卡的尽头算');
{
  const a = start(2015, 6); walk(a, E.MONTHS);
  if (E.extraRoom(a) !== 60) fail(`2015-06 那一局走完该还剩 60 个月，实际 ${E.extraRoom(a)}`);
  else ok(`2015-06 开局，收工在 ${a.preClose.year} 年 ${a.preClose.month} 月，还能走 60 个月`);

  const b = start(2024, 1); walk(b, E.MONTHS);
  if (E.extraRoom(b) !== 0) fail(`2024-01 那一局收工正好贴着 2025 年 12 月，该一个月都接不下去，实际 ${E.extraRoom(b)}`);
  else ok('2024-01 开局，走完就到年卡尽头，一个月也接不下去');
  const r = E.reopen(b);
  if (r.ok) fail('走到年卡尽头的局居然接得下去');
  else ok('接不下去的时候好好说一声：' + r.say);

  const c = start(2022, 7); walk(c, E.MONTHS);
  const room = E.extraRoom(c);   // 收工在 2024.06，到 2025.12 只剩 18 个月
  if (room !== 18) fail(`2022-07 开局收工在 2024.06，该还剩 18 个月，实际 ${room}`);
  else ok('走不满五年的局，只给它剩下的那 18 个月');
}

/* 2. 收工那个月正好换钱：接下去不许折两遍 ——————— */
console.log('2. 1947-06 那一局，第 24 个月正好是换币的 1949 年 5 月');
{
  const s = start(1947, 6);
  walk(s, E.MONTHS);
  if (!(s.year === 1949 && s.month === 5)) fail(`第 24 个月该是 1949 年 5 月，实际 ${s.year}.${s.month}`);
  if (!s.endSwitched) fail('1949 年 5 月收工该折一次钱，endSwitched 没立起来');
  const afterClose = { cur: s.currency, cash: s.cash, worth: E.netWorth(s) };
  const r1 = E.settle(s);
  if (!s.preClose) fail('closeOut 没把接下去要用的那一份存下来');

  const r = E.reopen(s);
  if (!r.ok) return fail('接不下去：' + r.say);
  if (s.n !== E.MONTHS + 1) fail(`接上之后该站在第 25 个月，实际第 ${s.n} 个月`);
  if (!(s.year === 1949 && s.month === 6)) fail(`接上之后该是 1949 年 6 月，实际 ${s.year}.${s.month}`);
  if (s.currency !== afterClose.cur) fail(`接上之后手里该是${E.CN[afterClose.cur]}，实际${E.CN[s.currency]}`);
  /* 折两遍的话现金会再少一个收兑价的倍数（1949 年那次是十万比一），差着数量级 */
  if (!near(s.cash, afterClose.cash, Math.abs(afterClose.cash) * 1e-9 + 1e-9)) {
    fail(`接上之后手里是 ${s.cash}，收工那一刻是 ${afterClose.cash}——那笔折算算了两遍`);
  } else ok(`换币的月份收工再接着走，钱一分不差（${E.money(s.cash, s.currency)}）`);
  if (s.endSwitched) fail('接着走下去之后 endSwitched 该撤掉，不然结算会拿错分母');
  if (s.preClose) fail('接上之后 preClose 该清掉');
  if (s.extraTo !== E.MONTHS + 60) fail(`该续到第 ${E.MONTHS + 60} 个月，实际 ${s.extraTo}`);
  if (E.lastMonthOf(s) !== s.extraTo) fail('lastMonthOf 没认 extraTo');

  /* 再走到头，另算一笔总账 */
  walk(s, s.extraTo);
  const r2 = E.settle(s);
  if (r2.phase !== 'extra') fail(`接着走完那一份该标成 extra，实际 ${r2.phase}`);
  if (r2.months !== 84) fail(`该走了 84 个月，实际 ${r2.months}`);
  if (r2.extraMonths !== 60) fail(`后传该是 60 个月，实际 ${r2.extraMonths}`);
  /* 两年那一份是另一个对象，接着走下去动不了它 */
  if (r1.months !== E.MONTHS || r1.phase !== 'main') fail('两年那一份被后面这几年改了');
  else ok(`两年那一份记着 ${r1.months} 个月、${r1.scoreText}；接着走完是 ${r2.months} 个月、${r2.scoreText}`);
}

/* 3. 整局封顶按走过的月数放大，两年那一档一点没变 ——— */
console.log('3. 整局封顶：二十四个月还是「六个满月」，走得久的按比例放大');
{
  const meanOf = st => st.months.reduce((t, m) => t + E.yearOf(m.year).ceiling, 0) / st.months.length;

  const a = start(1962, 5); walk(a, E.MONTHS);
  const ra = E.settle(a);
  if (!near(ra.ceiling, meanOf(a) * 6, 1e-9)) fail(`两年那一档的封顶变了：${ra.ceiling} 该是 ${meanOf(a) * 6}`);
  else ok(`1962-05 两年封顶 ${ra.ceiling.toFixed(1)} 年的收入（平均月上限 × 6，跟以前一模一样）`);

  const b = start(1962, 5); walk(b, E.MONTHS); E.reopen(b); walk(b, b.extraTo);
  const rb = E.settle(b);
  if (!near(rb.ceiling, meanOf(b) * (84 / 4), 1e-9)) fail(`84 个月的封顶该是 ${(meanOf(b) * 21).toFixed(2)}，实际 ${rb.ceiling.toFixed(2)}`);
  else ok(`同一局走满 84 个月，封顶放大到 ${rb.ceiling.toFixed(1)} 年的收入（21 个满月），两年那一档 ${ra.ceiling.toFixed(1)} 没动`);
}

/* 4. 冻结闸：两年的成绩只写得进去一次 ————————— */
console.log('4. 两年那一刻的成绩，库里只写得进去一次');
{
  const s = start(2015, 6); walk(s, E.MONTHS);
  const r1 = E.settle(s);
  const { id } = DB.createRun(s, '试');
  const wrote1 = DB.finishRun(id, s, r1);
  if (!wrote1) fail('头一次结账就没写进去');
  const row1 = DB.getRow(id);

  /* 接着走下去，再拿一份差得很远的成绩去盖 */
  E.reopen(s); walk(s, s.extraTo);
  const r2 = E.settle(s);
  r2.score = r1.score + 999; r2.worldUsd = (r1.worldUsd || 0) + 1e9; r2.yearEarned = (r1.yearEarned || 0) + 1e9;
  const wrote2 = DB.finishRun(id, s, r2);
  const row2 = DB.getRow(id);
  if (wrote2) fail('第二次结账居然写进去了——成绩没冻住');
  else if (row2.score !== row1.score || row2.world_usd !== row1.world_usd || row2.year_earned !== row1.year_earned) {
    fail(`成绩被改了：${row1.score} → ${row2.score}`);
  } else ok(`结过一次账就冻住了：score 还是 ${row1.score.toFixed(4)}，第二次写影响 0 行`);

  /* 后传写的是另一套列，两年那几列一动不动 */
  DB.finishExtra(id, s, r2);
  const row3 = DB.getRow(id);
  if (row3.score !== row1.score) fail('写后传的时候把两年的成绩带改了');
  else if (row3.extra_score !== r2.score) fail('后传的成绩没落到 extra_score 上');
  else ok(`后传单独记在 extra_score（${row3.extra_score.toFixed(2)}），两年那份纹丝不动`);

  /* 后传榜和总榜是两张榜 */
  const inBoard = DB.board(50).some(x => x.id === id);
  const inExtra = DB.boardExtra(50).some(x => x.id === id);
  if (!inBoard) fail('结过账的局该在总榜上');
  if (!inExtra) fail('走完后传的局该在后传榜上');
  if (inBoard && inExtra) ok('同一局：总榜上挂的是两年那份，后传榜上挂的是走完那份');
}

/* 5. 后传只接得上一次 ————————————————————— */
console.log('5. 后传只接得上一次');
{
  const s = start(2010, 1); walk(s, E.MONTHS); E.settle(s);
  if (!E.reopen(s).ok) fail('头一次就接不上');
  const again = E.reopen(s);
  if (again.ok) fail('接了第二次也让过了');
  else ok('第二次接：' + (again.say || '顶回去了'));
}

/* 5b. 这个功能之前收的工，也尽量接得上 ——————————— */
console.log('5b. 老档：没存过 preClose 的，没换钱的接得上，换过钱的老实顶回去');
{
  const a = start(2015, 6); walk(a, E.MONTHS);
  delete a.preClose;                                  // 装成这个功能之前收的工
  const r = E.reopen(a);
  if (!r.ok) fail('收工那个月没换钱的老档也接不上：' + r.say);
  else if (a.n !== E.MONTHS + 1 || a.year !== 2017 || a.month !== 6) fail(`老档接上之后站错了地方：第 ${a.n} 个月 ${a.year}.${a.month}`);
  else ok('没换钱的老档：退回第 24 个月再照常推进，站在 2017 年 6 月');

  const b = start(1947, 6); walk(b, E.MONTHS);
  delete b.preClose;
  const r2 = E.reopen(b);
  if (r2.ok) fail('收工那个月换过钱的老档不该硬接——那笔折算会算两遍');
  else ok('换过钱的老档：' + r2.say);
}

/* 6. 收梢那一篇的形状 ————————————————————— */
console.log('6. 收梢：没有密钥也要出得来，而且不许带游戏用语');
{
  const s = start(1962, 5);
  walk(s, E.MONTHS, (st, i) => { if (i === 3) st.memo.traits.push({ what: '会修自行车', notes: [] }); });
  const r = E.settle(s);
  const rv = SIM.reviewLocal(s, r);
  for (const k of ['title', 'verdict', 'became', 'turns', 'missed', 'phase', 'months']) {
    if (!(k in rv)) fail(`本地那篇缺了 ${k}`);
  }
  if (!rv.verdict || rv.verdict.length < 20) fail('本地那篇正文太短');
  if (/分数|排行|榜单|属性|系统|玩家|这一局|存档/.test(JSON.stringify(rv))) fail('本地那篇里有游戏用语');
  else ok(`本地那篇出得来：「${rv.title}」，${rv.verdict.length} 字，没有游戏用语`);
  if (rv.phase !== 'main' || rv.months !== E.MONTHS) fail('本地那篇没标清是哪一段');
  if (!Array.isArray(rv.turns)) fail('turns 该是个数组，前端直接 for 它');

  /* 后传走完那一篇，要标成 extra，月数也是整局的 */
  E.reopen(s); walk(s, s.extraTo);
  const r2 = E.settle(s);
  const rv2 = SIM.reviewLocal(s, r2);
  if (rv2.phase !== 'extra' || rv2.months !== 84) fail(`后传那篇标错了：${rv2.phase} / ${rv2.months}`);
  else ok('后传那篇标成 extra、84 个月，跟两年那篇分得开');
}

/* 7. 前端要的那几个字段，服务端确实给得出来 ————— */
console.log('7. 走过的月份带得上「这是第几个月」，回看才分得出哪些是后传');
{
  const s = start(2015, 6); walk(s, E.MONTHS); E.settle(s); E.reopen(s); walk(s, s.extraTo);
  const ns = s.months.map(m => m.n);
  if (ns.length !== 84) fail(`该有 84 个月，实际 ${ns.length}`);
  if (ns[0] !== 1 || ns[23] !== 24 || ns[24] !== 25 || ns[83] !== 84) fail(`月份的编号断了：${ns[22]},${ns[23]},${ns[24]},${ns[25]}`);
  else ok('84 个月编号连着，第 25 个月起是后传，界面上照这个切');
}

console.log(bad ? `\n${bad} 条没过` : '\n都过了');
process.exit(bad ? 1 : 0);
