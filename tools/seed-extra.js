'use strict';
/* 往一个临时库里塞几局假的，好把「结算 → 收梢 → 接着走下去 → 后传榜 → 详情」
 * 这几屏在真页面上看一遍。正文走本地兜底，不调模型，不花钱。
 *
 *   HY_DB=/tmp/hy-shot.db node tools/seed-extra.js
 * 打出一行 token，浏览器里塞进 localStorage 就认得出这几局是「我的」。
 * 四局：A 走完没结账、B 后传也走完、C 结完账没接后传、D 结完账但收梢没写过（也不是「我的」）。
 */
const E = require('../engine.js');
const SIM = require('../sim.js');
const DB = require('../db.js');

const LISTS = [
  '月初去码头找工头，问能不能按月结；手里那块表拿去当铺换本钱，进一批线香',
  '把线香铺到三家杂货店，谈成按月结账；剩下的钱盘一个旧摊位',
  '雇个帮手看摊，自己跑城南那几条街拉新客；月底把当铺的表赎回来',
  '托人问纱厂的门路，能不能接一点零散的活；顺便看看有没有便宜的存货',
];

/** 走 n 个月，正文走本地兜底 */
function play(s, n) {
  for (let i = 0; i < n; i++) {
    const list = LISTS[(s.n - 1) % LISTS.length];
    const out = SIM.runMonthLocal(s, list);
    out.delta.refused = E.cleanRefused(out.delta.refused, E.scanAnachronism(list, s.year));
    const cur = E.currencyOf(s.year, s.month);
    const r = E.applyMonth(s, out.delta);
    E.applyMemo(s, out.delta, { n: s.n, year: s.year, month: s.month });
    s.months.push({
      n: s.n, year: s.year, month: s.month, list,
      story: out.delta.story, tally: E.tallyLine(r.entries, cur), entries: r.entries,
      refused: out.delta.refused || [], local: true,
    });
    if (s.n < E.lastMonthOf(s)) E.advanceTo(s, s.n + 1); else E.closeOut(s);
  }
  s.options = SIM.optionsLocal(s);
}

function newOne(y, m, nick, persona) {
  const s = E.newRun({ year: y, month: m, nick, persona });
  s.options = SIM.optionsLocal(s);
  return s;
}

/* A：二十四个月走完了，还没结账——用来在页面上真按一次「去算账」 */
const a = newOne(2015, 6, '阿甲', '做事踏实，嘴笨，认死理');
play(a, E.MONTHS);
const ra = DB.createRun(a, a.nick);
DB.saveRun(ra.id, a);

/* B：两年结完账，后传也走完了，两篇收梢都写好了 */
const b = newOne(1962, 5, '阿乙', '嘴甜会来事，胆子大');
play(b, E.MONTHS);
const rb = DB.createRun(b, b.nick);
const b1 = E.settle(b);
b1.endWorthText = E.money(b1.endWorth, b1.currency); b1.currencyName = E.CN[b1.currency];
b.status = 'done';
DB.finishRun(rb.id, b, b1);
DB.saveReview(rb.id, JSON.stringify(SIM.reviewLocal(b, b1)), false);
const op = E.reopen(b);
if (!op.ok) throw new Error('接不下去：' + op.say);
DB.startExtra(rb.id, b, op.room);
play(b, b.extraTo - E.MONTHS);
const b2 = E.settle(b);
b2.endWorthText = E.money(b2.endWorth, b2.currency); b2.currencyName = E.CN[b2.currency];
b.status = 'done';
DB.finishExtra(rb.id, b, b2);
DB.saveReview(rb.id, JSON.stringify(SIM.reviewLocal(b, b2)), true);

/* C：两年结完账，还没接后传——详情页上该给「接着走下去」 */
const c = newOne(1948, 1, '阿丙', '');
play(c, E.MONTHS);
const rc = DB.createRun(c, c.nick);
const r1c = E.settle(c);
r1c.endWorthText = E.money(r1c.endWorth, r1c.currency); r1c.currencyName = E.CN[r1c.currency];
c.status = 'done';
DB.finishRun(rc.id, c, r1c);
DB.saveReview(rc.id, JSON.stringify(SIM.reviewLocal(c, r1c)), false);

/* D：两年结完账，**收梢从来没写过**，而且不是「我的」——榜上点进来要触发后台写那一篇 */
const d = newOne(1994, 3, '阿丁', '心眼多，会算账');
play(d, E.MONTHS);
const rd = DB.createRun(d, d.nick);
const r1d = E.settle(d);
r1d.endWorthText = E.money(r1d.endWorth, r1d.currency); r1d.currencyName = E.CN[r1d.currency];
d.status = 'done';
DB.finishRun(rd.id, d, r1d);

/* 前三局用同一个 token，界面上才都算「我的局」；D 留着它自己的 */
const tok = ra.token;
for (const id of [rb.id, rc.id]) DB.db.prepare('UPDATE runs SET token = ? WHERE id = ?').run(tok, id);

console.log(JSON.stringify({ token: tok, ready: ra.id, extra: rb.id, done: rc.id, fresh: rd.id, db: DB.FILE }));
