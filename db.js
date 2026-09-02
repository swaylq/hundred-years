'use strict';
/* 存档和排行榜。用 Node 自带的 node:sqlite，一个依赖都不装。 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.HY_DB || path.join(__dirname, 'data', 'hundred-years.db');

fs.mkdirSync(path.dirname(FILE), { recursive: true });
const db = new DatabaseSync(FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS runs (
    id       TEXT PRIMARY KEY,
    token    TEXT NOT NULL,
    nick     TEXT NOT NULL,
    year     INTEGER NOT NULL,
    month    INTEGER NOT NULL,
    state    TEXT NOT NULL,
    status   TEXT NOT NULL,
    score    REAL,
    year_earned REAL,
    world_usd   REAL,
    result   TEXT,
    created  INTEGER NOT NULL,
    updated  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS runs_token ON runs(token);
`);

/* 老库里没有这几列，补上（SQLite 没有 ADD COLUMN IF NOT EXISTS） */
{
  const cols = new Set(db.prepare('PRAGMA table_info(runs)').all().map(c => c.name));
  if (!cols.has('year_earned')) db.exec('ALTER TABLE runs ADD COLUMN year_earned REAL');
  if (!cols.has('world_usd')) db.exec('ALTER TABLE runs ADD COLUMN world_usd REAL');
  /* mode：这一局按什么规矩打的。按天走三十天的老局记 days30，
   * 按月走二十四个月的新局记 months24。两种规矩的成绩不可比，
   * 榜上只显示当前这一种；老局照旧留着，在「我的局」里看得到。 */
  if (!cols.has('mode')) {
    db.exec('ALTER TABLE runs ADD COLUMN mode TEXT');
    db.exec("UPDATE runs SET mode = 'days30' WHERE mode IS NULL");
  }
  /* 两年之后接着走下去的那一段（后传）。**另开一套列，绝不写回上面那几列**——
   * score / year_earned / world_usd / result 是两年那一刻的成绩，封存不动，
   * 总榜和年榜只读它们。后传的成绩单独上后传榜。 */
  for (const [c, t] of [
    ['review', 'TEXT'],              // 两年那一刻的 AI 总评
    ['extra_status', 'TEXT'],        // 后传走到哪了：playing / done，没接过就是 NULL
    ['extra_months', 'INTEGER'],     // 后传总共要走几个月（不含前两年）
    ['extra_score', 'REAL'],
    ['extra_year_earned', 'REAL'],
    ['extra_world_usd', 'REAL'],
    ['extra_result', 'TEXT'],
    ['extra_review', 'TEXT'],
  ]) if (!cols.has(c)) db.exec(`ALTER TABLE runs ADD COLUMN ${c} ${t}`);
}
const MODE = 'months24';
db.exec(`
  CREATE INDEX IF NOT EXISTS runs_world ON runs(status, world_usd DESC);
  CREATE INDEX IF NOT EXISTS runs_year  ON runs(status, year, year_earned DESC);
  CREATE INDEX IF NOT EXISTS runs_extra ON runs(extra_status, extra_world_usd DESC);
`);

const id = () => crypto.randomBytes(9).toString('base64url');
const now = () => Date.now();

const q = {
  ins: db.prepare('INSERT INTO runs (id,token,nick,year,month,state,status,created,updated,mode) VALUES (?,?,?,?,?,?,?,?,?,?)'),
  get: db.prepare('SELECT * FROM runs WHERE id = ?'),
  upd: db.prepare('UPDATE runs SET state = ?, updated = ? WHERE id = ?'),
  /* **`status <> 'done'` 就是那道冻结闸**：一局结过一次账，这几列再也改不动。
   * 后传走完再调 finishRun 也只会影响 0 行——成绩冻在两年那一刻，靠的是这一句，
   * 不是靠调用方记得别调。 */
  fin: db.prepare("UPDATE runs SET state = ?, status = 'done', score = ?, year_earned = ?, world_usd = ?, result = ?, updated = ? WHERE id = ? AND status <> 'done'"),
  mine: db.prepare(`SELECT id,nick,year,month,status,score,created,mode,
                           extra_status,extra_months,extra_score,review,extra_review
                    FROM runs WHERE token = ? ORDER BY created DESC LIMIT 30`),
  /* 一局的详情。带 state 是为了取那二十四个月的正文，**token 一列不许选出来**——
   * 选了就等于谁看得到详情谁就能往这局里写。 */
  detail: db.prepare(`SELECT id,nick,year,month,status,score,year_earned,world_usd,result,review,
                             extra_status,extra_months,extra_score,extra_year_earned,extra_world_usd,
                             extra_result,extra_review,state,created,updated,mode
                      FROM runs WHERE id = ?`),
  review: db.prepare('UPDATE runs SET review = ? WHERE id = ?'),
  reviewX: db.prepare('UPDATE runs SET extra_review = ? WHERE id = ?'),
  startX: db.prepare("UPDATE runs SET state = ?, extra_status = 'playing', extra_months = ?, updated = ? WHERE id = ?"),
  finX: db.prepare(`UPDATE runs SET state = ?, extra_status = 'done', extra_score = ?, extra_year_earned = ?,
                    extra_world_usd = ?, extra_result = ?, updated = ? WHERE id = ?`),
  /* 总榜：按「折成今天的美元」排 */
  boardWorld: db.prepare(`SELECT id,nick,year,month,score,year_earned,world_usd,result,updated FROM runs
                     WHERE status = 'done' AND world_usd IS NOT NULL AND mode = '${MODE}'
                     ORDER BY world_usd DESC LIMIT ?`),
  /* 年榜：只跟同一年的人比，按当年那种钱净赚多少排 */
  boardYear: db.prepare(`SELECT id,nick,year,month,score,year_earned,world_usd,result,updated FROM runs
                     WHERE status = 'done' AND year = ? AND year_earned IS NOT NULL AND mode = '${MODE}'
                     ORDER BY year_earned DESC LIMIT ?`),
  yearsWithRuns: db.prepare(`SELECT year, COUNT(*) n FROM runs WHERE status = 'done' AND mode = '${MODE}' GROUP BY year ORDER BY year`),
  countDone: db.prepare(`SELECT COUNT(*) n FROM runs WHERE status = 'done' AND mode = '${MODE}'`),
  rankWorld: db.prepare(`SELECT COUNT(*) n FROM runs WHERE status = 'done' AND mode = '${MODE}' AND world_usd > ?`),
  rankYear: db.prepare(`SELECT COUNT(*) n FROM runs WHERE status = 'done' AND mode = '${MODE}' AND year = ? AND year_earned > ?`),
  countYear: db.prepare(`SELECT COUNT(*) n FROM runs WHERE status = 'done' AND mode = '${MODE}' AND year = ?`),
  /* 后传榜：走完了后传的局，按整局（前两年 + 后传）折成今天的美元排。
   * 跟总榜是两张榜，互不相干——接着走下去的人不该跟只走两年的人比。 */
  boardExtra: db.prepare(`SELECT id,nick,year,month,extra_score,extra_year_earned,extra_world_usd,
                                 extra_months,extra_result,updated FROM runs
                          WHERE extra_status = 'done' AND extra_world_usd IS NOT NULL AND mode = '${MODE}'
                          ORDER BY extra_world_usd DESC LIMIT ?`),
  countExtra: db.prepare(`SELECT COUNT(*) n FROM runs WHERE extra_status = 'done' AND mode = '${MODE}'`),
  rankExtra: db.prepare(`SELECT COUNT(*) n FROM runs WHERE extra_status = 'done' AND mode = '${MODE}' AND extra_world_usd > ?`),
};

function createRun(state, nick) {
  const rid = id();
  const token = crypto.randomBytes(16).toString('base64url');
  const t = now();
  q.ins.run(rid, token, nick, state.startYear || state.year, state.startMonth || state.month, JSON.stringify(state), 'playing', t, t, MODE);
  return { id: rid, token };
}

/** 读一局。**必须带对 token**——原来写的是 `if (token && row.token !== token)`，
 *  不带 token 那一支直接放行，等于谁拿到 id 谁就能往别人的存档里写。
 *  id 是九字节随机、接口也不外泄，实际难利用，但这个判断的意思是写反的。 */
function loadRun(rid, token) {
  const row = q.get.get(rid);
  if (!row) return null;
  if (!token || row.token !== token) return null;
  return { row, state: JSON.parse(row.state) };
}

function saveRun(rid, state) { q.upd.run(JSON.stringify(state), now(), rid); }

/** 两年走完，结账。**只结得动一次**——冻结闸在 q.fin 的 WHERE 里。
 *  回 true 表示这一次真写进去了。 */
function finishRun(rid, state, result) {
  const r = q.fin.run(JSON.stringify(state), result.score, result.yearEarned, result.worldUsd,
    JSON.stringify(result), now(), rid);
  return r.changes > 0;
}

/* ── 后传：两年之后接着走的那一段 ───────────────────── */
const startExtra = (rid, state, months) => q.startX.run(JSON.stringify(state), months, now(), rid);
function finishExtra(rid, state, result) {
  q.finX.run(JSON.stringify(state), result.score, result.yearEarned, result.worldUsd, JSON.stringify(result), now(), rid);
}
const saveReview = (rid, text, extra) => (extra ? q.reviewX : q.review).run(text, rid);
const getRow = rid => q.detail.get(rid);
const boardExtra = (limit = 50) => q.boardExtra.all(limit).map(r => ({ ...r, extra_result: r.extra_result ? JSON.parse(r.extra_result) : null }));
const extraCount = () => q.countExtra.get().n;
const rankExtra = usd => q.rankExtra.get(usd).n + 1;

/** 榜。给了 year 就是那一年的榜（按当年那种钱净赚多少排），
 *  不给就是总榜（按折成今天的美元排）。 */
function board(limit = 50, year = null) {
  const rows = year ? q.boardYear.all(year, limit) : q.boardWorld.all(limit);
  return rows.map(r => ({ ...r, result: r.result ? JSON.parse(r.result) : null }));
}

const yearsWithRuns = () => q.yearsWithRuns.all();

const myRuns = token => q.mine.all(token);
const doneCount = () => q.countDone.get().n;
const rankWorld = usd => q.rankWorld.get(usd).n + 1;
const rankInYear = (year, earned) => q.rankYear.get(year, earned).n + 1;
const doneInYear = year => q.countYear.get(year).n;

module.exports = {
  db, createRun, loadRun, saveRun, finishRun, board, myRuns, doneCount,
  rankWorld, rankInYear, doneInYear, yearsWithRuns, FILE,
  startExtra, finishExtra, saveReview, getRow, boardExtra, extraCount, rankExtra,
};
