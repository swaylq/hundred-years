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

/* 老库里没有这两列，补上（SQLite 没有 ADD COLUMN IF NOT EXISTS） */
{
  const cols = new Set(db.prepare('PRAGMA table_info(runs)').all().map(c => c.name));
  if (!cols.has('year_earned')) db.exec('ALTER TABLE runs ADD COLUMN year_earned REAL');
  if (!cols.has('world_usd')) db.exec('ALTER TABLE runs ADD COLUMN world_usd REAL');
}
db.exec(`
  CREATE INDEX IF NOT EXISTS runs_world ON runs(status, world_usd DESC);
  CREATE INDEX IF NOT EXISTS runs_year  ON runs(status, year, year_earned DESC);
`);

const id = () => crypto.randomBytes(9).toString('base64url');
const now = () => Date.now();

const q = {
  ins: db.prepare('INSERT INTO runs (id,token,nick,year,month,state,status,created,updated) VALUES (?,?,?,?,?,?,?,?,?)'),
  get: db.prepare('SELECT * FROM runs WHERE id = ?'),
  upd: db.prepare('UPDATE runs SET state = ?, updated = ? WHERE id = ?'),
  fin: db.prepare('UPDATE runs SET state = ?, status = ?, score = ?, year_earned = ?, world_usd = ?, result = ?, updated = ? WHERE id = ?'),
  mine: db.prepare('SELECT id,nick,year,month,status,score,created FROM runs WHERE token = ? ORDER BY created DESC LIMIT 30'),
  /* 总榜：按「折成今天的美元」排 */
  boardWorld: db.prepare(`SELECT id,nick,year,month,score,year_earned,world_usd,result,updated FROM runs
                     WHERE status = 'done' AND world_usd IS NOT NULL
                     ORDER BY world_usd DESC LIMIT ?`),
  /* 年榜：只跟同一年的人比，按当年那种钱净赚多少排 */
  boardYear: db.prepare(`SELECT id,nick,year,month,score,year_earned,world_usd,result,updated FROM runs
                     WHERE status = 'done' AND year = ? AND year_earned IS NOT NULL
                     ORDER BY year_earned DESC LIMIT ?`),
  yearsWithRuns: db.prepare(`SELECT year, COUNT(*) n FROM runs WHERE status = 'done' GROUP BY year ORDER BY year`),
  countDone: db.prepare(`SELECT COUNT(*) n FROM runs WHERE status = 'done'`),
  rankWorld: db.prepare(`SELECT COUNT(*) n FROM runs WHERE status = 'done' AND world_usd > ?`),
  rankYear: db.prepare(`SELECT COUNT(*) n FROM runs WHERE status = 'done' AND year = ? AND year_earned > ?`),
  countYear: db.prepare(`SELECT COUNT(*) n FROM runs WHERE status = 'done' AND year = ?`),
};

function createRun(state, nick) {
  const rid = id();
  const token = crypto.randomBytes(16).toString('base64url');
  const t = now();
  q.ins.run(rid, token, nick, state.year, state.month, JSON.stringify(state), 'playing', t, t);
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

function finishRun(rid, state, result) {
  q.fin.run(JSON.stringify(state), 'done', result.score, result.yearEarned, result.worldUsd, JSON.stringify(result), now(), rid);
}

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
};
