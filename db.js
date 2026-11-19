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
    ['board_pick', 'INTEGER'],       // 总榜自选：1 选入总榜，0 不上总榜，NULL 默认按赚钱最多前两名
    ['on_board', 'INTEGER NOT NULL DEFAULT 1'],
  ]) if (!cols.has(c)) db.exec(`ALTER TABLE runs ADD COLUMN ${c} ${t}`);
}
const MODE = 'months24';
const MODE_FAST = 'months12';
const MAX_BOARD_PICKS = 2;
const ON_BOARD = 'COALESCE(on_board, 1) = 1';
db.exec(`
  CREATE INDEX IF NOT EXISTS runs_world ON runs(status, world_usd DESC);
  CREATE INDEX IF NOT EXISTS runs_year  ON runs(status, year, year_earned DESC);
  CREATE INDEX IF NOT EXISTS runs_extra ON runs(extra_status, extra_world_usd DESC);
  CREATE TABLE IF NOT EXISTS year_traces (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id     TEXT NOT NULL,
    nick       TEXT NOT NULL,
    year       INTEGER NOT NULL,
    month      INTEGER NOT NULL,
    city       TEXT NOT NULL,
    kind       TEXT NOT NULL,
    partner    TEXT,
    bond_type  TEXT,
    summary    TEXT NOT NULL,
    importance INTEGER NOT NULL DEFAULT 2,
    created    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS year_traces_ym ON year_traces(year, month, importance DESC, created DESC);
  CREATE INDEX IF NOT EXISTS year_traces_run ON year_traces(run_id, year);
  CREATE TABLE IF NOT EXISTS token_aliases (
    token        TEXT NOT NULL,
    target_token TEXT NOT NULL,
    PRIMARY KEY (token, target_token)
  );
  CREATE INDEX IF NOT EXISTS token_aliases_tok ON token_aliases(token);
`);
{
  const tCols = new Set(db.prepare('PRAGMA table_info(year_traces)').all().map(c => c.name));
  for (const [c, t] of [
    ['capsule_kind', 'TEXT'],
    ['capsule_item', 'TEXT'],
    ['capsule_clue', 'TEXT'],
    ['claimed_by', 'TEXT'],
    ['claimed_year', 'INTEGER'],
    ['claimed_run_id', 'TEXT'],
  ]) if (!tCols.has(c)) db.exec(`ALTER TABLE year_traces ADD COLUMN ${c} ${t}`);
  db.exec('CREATE INDEX IF NOT EXISTS year_traces_cap ON year_traces(city, capsule_kind, year DESC)');
}

const id = () => crypto.randomBytes(9).toString('base64url');
const now = () => Date.now();
const VALID_TOK = /^[A-Za-z0-9_-]{8,64}$/;

const q = {
  ins: db.prepare('INSERT INTO runs (id,token,nick,year,month,state,status,created,updated,mode) VALUES (?,?,?,?,?,?,?,?,?,?)'),
  get: db.prepare('SELECT * FROM runs WHERE id = ?'),
  upd: db.prepare('UPDATE runs SET state = ?, updated = ? WHERE id = ?'),
  /* **`status <> 'done'` 就是那道冻结闸**：一局结过一次账，这几列再也改不动。
   * 后传走完再调 finishRun 也只会影响 0 行——成绩冻在两年那一刻，靠的是这一句，
   * 不是靠调用方记得别调。 */
  fin: db.prepare("UPDATE runs SET state = ?, status = 'done', score = ?, year_earned = ?, world_usd = ?, result = ?, updated = ? WHERE id = ? AND status <> 'done'"),
  mine: db.prepare(`SELECT id,token,nick,year,month,status,score,year_earned,world_usd,result,created,updated,mode,
                           extra_status,extra_months,extra_score,extra_year_earned,extra_world_usd,extra_result,
                           review,extra_review,board_pick,COALESCE(on_board,1) AS on_board
                    FROM runs WHERE token = ? ORDER BY created DESC LIMIT 100`),
  /* 一局的详情。带 state 是为了取那二十四个月的正文，**token 一列不许选出来**——
   * 选了就等于谁看得到详情谁就能往这局里写。 */
  detail: db.prepare(`SELECT id,nick,year,month,status,score,year_earned,world_usd,result,review,
                             extra_status,extra_months,extra_score,extra_year_earned,extra_world_usd,
                             extra_result,extra_review,state,created,updated,mode,board_pick,COALESCE(on_board,1) AS on_board
                      FROM runs WHERE id = ?`),
  setOnBoard: db.prepare('UPDATE runs SET on_board = ? WHERE id = ?'),
  review: db.prepare('UPDATE runs SET review = ? WHERE id = ?'),
  reviewX: db.prepare('UPDATE runs SET extra_review = ? WHERE id = ?'),
  startX: db.prepare("UPDATE runs SET state = ?, extra_status = 'playing', extra_months = ?, updated = ? WHERE id = ?"),
  finX: db.prepare(`UPDATE runs SET state = ?, extra_status = 'done', extra_score = ?, extra_year_earned = ?,
                    extra_world_usd = ?, extra_result = ?, updated = ? WHERE id = ?`),
  /* 总榜候选：按「折成今天的美元」排，供每人限选两条过滤 */
  boardWorldAll: db.prepare(`SELECT id,token,nick,year,month,score,year_earned,world_usd,result,review,updated,board_pick FROM runs
                     WHERE status = 'done' AND world_usd IS NOT NULL AND mode = '${MODE}' AND ${ON_BOARD}
                     ORDER BY world_usd DESC, updated DESC, id ASC`),
  /* 年榜：只跟同一年的人比，按当年那种钱净赚多少排（每年内不限制条数） */
  boardYear: db.prepare(`SELECT id,nick,year,month,score,year_earned,world_usd,result,review,updated FROM runs
                     WHERE status = 'done' AND year = ? AND year_earned IS NOT NULL AND mode = '${MODE}' AND ${ON_BOARD}
                     ORDER BY year_earned DESC LIMIT ?`),
  yearsWithRuns: db.prepare(`SELECT year, COUNT(*) n FROM runs WHERE status = 'done' AND mode = '${MODE}' AND ${ON_BOARD} GROUP BY year ORDER BY year`),
  rankYear: db.prepare(`SELECT COUNT(*) n FROM runs WHERE status = 'done' AND mode = '${MODE}' AND ${ON_BOARD} AND year = ? AND year_earned > ?`),
  countYear: db.prepare(`SELECT COUNT(*) n FROM runs WHERE status = 'done' AND mode = '${MODE}' AND ${ON_BOARD} AND year = ?`),
  /* 后传榜：走完了后传的局，按整局（前两年 + 后传）折成今天的美元排。
   * 跟总榜是两张榜，互不相干——接着走下去的人不该跟只走两年的人比。 */
  boardExtra: db.prepare(`SELECT id,nick,year,month,extra_score,extra_year_earned,extra_world_usd,
                                 extra_months,extra_result,extra_review,updated FROM runs
                          WHERE extra_status = 'done' AND extra_world_usd IS NOT NULL AND mode = '${MODE}' AND ${ON_BOARD}
                          ORDER BY extra_world_usd DESC LIMIT ?`),
  countExtra: db.prepare(`SELECT COUNT(*) n FROM runs WHERE extra_status = 'done' AND mode = '${MODE}' AND ${ON_BOARD}`),
  rankExtra: db.prepare(`SELECT COUNT(*) n FROM runs WHERE extra_status = 'done' AND mode = '${MODE}' AND ${ON_BOARD} AND extra_world_usd > ?`),
  boardFast: db.prepare(`SELECT id,nick,year,month,score,year_earned,world_usd,result,review,updated FROM runs
                         WHERE status = 'done' AND world_usd IS NOT NULL AND mode = '${MODE_FAST}' AND ${ON_BOARD}
                         ORDER BY world_usd DESC, updated DESC LIMIT ?`),
  countFast: db.prepare(`SELECT COUNT(*) n FROM runs WHERE status = 'done' AND mode = '${MODE_FAST}' AND ${ON_BOARD}`),
  rankFast: db.prepare(`SELECT COUNT(*) n FROM runs WHERE status = 'done' AND mode = '${MODE_FAST}' AND ${ON_BOARD} AND world_usd > ?`),
  aliasesOf: db.prepare(`SELECT target_token FROM token_aliases WHERE token = ?`),
  addAlias: db.prepare(`INSERT OR IGNORE INTO token_aliases (token, target_token) VALUES (?, ?)`),
  updPick: db.prepare(`UPDATE runs SET board_pick = ? WHERE id = ?`),
  delRun: db.prepare(`DELETE FROM runs WHERE id = ?`),
  delTraces: db.prepare(`DELETE FROM year_traces WHERE run_id = ?`),
};

function linkTokens(fromToken, toToken) {
  const a = String(fromToken || '').trim();
  const b = String(toToken || '').trim();
  if (!a || !b || a === b || !VALID_TOK.test(a) || !VALID_TOK.test(b)) return;
  q.addAlias.run(a, b);
  q.addAlias.run(b, a);
}

/* 2026-11-17 之前开新局会每次生成新 token；把早期同名完结局的 token 自动归并，
 * 保证总榜「每人最多展示两条」对历史多局用户同样生效。 */
{
  try {
    const legacy = db.prepare(`
      SELECT nick, token FROM runs
      WHERE mode = '${MODE}' AND created < 1790000000000 AND nick NOT IN ('无名', '试', '1', '2', 'x')
      ORDER BY created ASC
    `).all();
    const byNick = new Map();
    for (const r of legacy) {
      const k = String(r.nick || '').trim();
      if (!k) continue;
      if (!byNick.has(k)) byNick.set(k, []);
      byNick.get(k).push(r.token);
    }
    for (const toks of byNick.values()) {
      const uniq = [...new Set(toks)];
      if (uniq.length > 1) {
        for (let i = 1; i < uniq.length; i++) linkTokens(uniq[0], uniq[i]);
      }
    }
  } catch (e) {}
}

function expandTokens(tokenOrList) {
  const parts = Array.isArray(tokenOrList)
    ? tokenOrList
    : String(tokenOrList || '').split(',');
  const base = [...new Set(parts.map(s => String(s || '').trim()).filter(s => VALID_TOK.test(s)))];
  if (!base.length) return [];
  if (base.length > 1) {
    for (let i = 1; i < base.length; i++) linkTokens(base[0], base[i]);
  }
  const all = new Set(base);
  const queue = [...base];
  while (queue.length) {
    const t = queue.pop();
    for (const r of q.aliasesOf.all(t)) {
      if (r && r.target_token && !all.has(r.target_token)) {
        all.add(r.target_token);
        queue.push(r.target_token);
      }
    }
  }
  return [...all];
}

function buildTokenGroupMap() {
  const edges = db.prepare('SELECT token, target_token FROM token_aliases').all();
  const adj = new Map();
  for (const { token: a, target_token: b } of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  const canon = new Map();
  for (const start of adj.keys()) {
    if (canon.has(start)) continue;
    const comp = [start];
    const seen = new Set([start]);
    for (let i = 0; i < comp.length; i++) {
      for (const nb of (adj.get(comp[i]) || [])) {
        if (!seen.has(nb)) { seen.add(nb); comp.push(nb); }
      }
    }
    const rep = comp.slice().sort()[0];
    for (const t of comp) canon.set(t, rep);
  }
  return t => canon.get(t) || t;
}

/** 计算某位用户已结算记录中哪些上总榜（最多 2 条，默认选赚钱最多的前两名）。
 *  传入的 list 需已按 world_usd DESC 排好。 */
function pickUserWorldRuns(list) {
  if (!list.length) return { picked: [], isDefault: true };
  const defaultTop = list.slice(0, MAX_BOARD_PICKS);
  const hasCustom = list.some(r => r.board_pick === 1 || r.board_pick === 0);
  if (!hasCustom) {
    return { picked: defaultTop, isDefault: true };
  }
  const customPicked = list.filter(r => r.board_pick === 1).slice(0, MAX_BOARD_PICKS);
  const defaultIds = new Set(defaultTop.map(r => r.id));
  const isSameAsDefault = customPicked.length === defaultTop.length &&
    customPicked.every(r => defaultIds.has(r.id));
  return { picked: customPicked, isDefault: isSameAsDefault };
}

function syncUserBoardPicks(doneList, pickedSet) {
  if (!doneList.length) return true;
  const defaultTop = doneList.slice(0, MAX_BOARD_PICKS);
  const isDefault = pickedSet.size === defaultTop.length &&
    defaultTop.every(r => pickedSet.has(r.id));
  for (const r of doneList) {
    q.updPick.run(isDefault ? null : (pickedSet.has(r.id) ? 1 : 0), r.id);
  }
  return isDefault;
}

function userDoneWorldRuns(toks) {
  if (!toks.length) return [];
  const ph = toks.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, token, world_usd, updated, board_pick
    FROM runs
    WHERE token IN (${ph}) AND status = 'done' AND world_usd IS NOT NULL AND mode = '${MODE}' AND ${ON_BOARD}
    ORDER BY world_usd DESC, updated DESC, id ASC
  `).all(...toks);
}

function worldBoardRows() {
  const all = q.boardWorldAll.all();
  const groupOf = buildTokenGroupMap();
  const byUser = new Map();
  for (const r of all) {
    const g = groupOf(r.token);
    if (!byUser.has(g)) byUser.set(g, []);
    byUser.get(g).push(r);
  }
  const pickedIds = new Set();
  for (const list of byUser.values()) {
    for (const r of pickUserWorldRuns(list).picked) pickedIds.add(r.id);
  }
  return all.filter(r => pickedIds.has(r.id));
}

function createRun(state, nick, preferredToken) {
  const rid = id();
  const cleanPref = typeof preferredToken === 'string' ? preferredToken.trim() : '';
  const token = VALID_TOK.test(cleanPref) && cleanPref.length >= 12
    ? cleanPref
    : crypto.randomBytes(16).toString('base64url');
  const t = now();
  const runMode = (state && Number(state.targetMonths) === 12) ? MODE_FAST : MODE;
  q.ins.run(rid, token, nick, state.startYear || state.year, state.startMonth || state.month, JSON.stringify(state), 'playing', t, t, runMode);
  return { id: rid, token };
}

/** 读一局。**必须带对 token**——支持单条或逗号分隔的历史多 token 及别名映射，
 *  保证在同一浏览器开新局或找回旧局后，原存档的读写权都不丢失。 */
function loadRun(rid, token) {
  const row = q.get.get(rid);
  if (!row) return null;
  const toks = expandTokens(token);
  if (!toks.length || !toks.includes(row.token)) return null;
  return { row, state: JSON.parse(row.state) };
}

function saveRun(rid, state) { q.upd.run(JSON.stringify(state), now(), rid); }

/** 两年走完，结账。**只结得动一次**——冻结闸在 q.fin 的 WHERE 里。
 *  回 true 表示这一次真写进去了。 */
function finishRun(rid, state, result) {
  const r = q.fin.run(JSON.stringify(state), result.score, result.yearEarned, result.worldUsd,
    JSON.stringify(result), now(), rid);
  if (r.changes > 0) {
    const row = q.get.get(rid);
    if (row) {
      const toks = expandTokens(row.token);
      const doneList = userDoneWorldRuns(toks);
      const hasCustom = doneList.some(x => x.board_pick === 1 || x.board_pick === 0);
      if (hasCustom) {
        const picked = new Set(doneList.filter(x => x.board_pick === 1).map(x => x.id));
        if (picked.size > 0 && picked.size < MAX_BOARD_PICKS) picked.add(rid);
        syncUserBoardPicks(doneList, picked);
      }
    }
    return true;
  }
  return false;
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
const boardFast = (limit = 50) => q.boardFast.all(limit).map(r => ({ ...r, result: r.result ? JSON.parse(r.result) : null }));
const fastCount = () => q.countFast.get().n;
const rankFast = usd => q.rankFast.get(usd).n + 1;

/** 榜。给了 year 就是那一年的榜（按当年那种钱净赚多少排，每年内不限制条数），
 *  不给就是总榜（按折成今天的美元排，每位用户最多展示自选或默认赚钱最多的两条）。 */
function board(limit = 50, year = null) {
  const rows = year ? q.boardYear.all(year, limit) : worldBoardRows().slice(0, limit);
  return rows.map(r => {
    const { token: _t, board_pick: _bp, ...rest } = r;
    return { ...rest, result: r.result ? JSON.parse(r.result) : null };
  });
}

const yearsWithRuns = () => q.yearsWithRuns.all();

function myRuns(tokenOrList) {
  const toks = expandTokens(tokenOrList);
  if (!toks.length) return [];
  let rows;
  if (toks.length === 1) {
    rows = q.mine.all(toks[0]);
  } else {
    const ph = toks.map(() => '?').join(',');
    rows = db.prepare(`SELECT id,token,nick,year,month,status,score,year_earned,world_usd,result,created,updated,mode,
                              extra_status,extra_months,extra_score,extra_year_earned,extra_world_usd,extra_result,
                              review,extra_review,board_pick,COALESCE(on_board,1) AS on_board
                       FROM runs WHERE token IN (${ph}) ORDER BY created DESC LIMIT 100`).all(...toks);
  }
  const doneList = rows
    .filter(r => r.status === 'done' && r.world_usd != null && r.mode === MODE && Number(r.on_board ?? 1) === 1)
    .slice()
    .sort((a, b) => (b.world_usd - a.world_usd) || ((b.updated || 0) - (a.updated || 0)) || String(a.id).localeCompare(String(b.id)));
  const pickInfo = pickUserWorldRuns(doneList);
  const pickedIds = new Set(pickInfo.picked.map(r => r.id));
  const rankMap = new Map(doneList.map((r, i) => [r.id, i + 1]));
  return rows.map(r => {
    const { token: _t, ...rest } = r;
    const canPickBoard = r.status === 'done' && r.world_usd != null && r.mode === MODE && Number(r.on_board ?? 1) === 1;
    return {
      ...rest,
      canPickBoard,
      onBoard: canPickBoard && pickedIds.has(r.id),
      boardDefault: pickInfo.isDefault,
      boardRankInMine: rankMap.get(r.id) || null,
    };
  });
}

function setBoardPick(rid, tokenOrList, opts = {}) {
  const toks = expandTokens(tokenOrList);
  if (!toks.length) return { ok: false, code: 403, error: '无法识别当前浏览器记录' };
  const doneList = userDoneWorldRuns(toks);

  if (opts.reset) {
    const ph = toks.map(() => '?').join(',');
    db.prepare(`UPDATE runs SET board_pick = NULL WHERE token IN (${ph})`).run(...toks);
    const defaultIds = doneList.slice(0, MAX_BOARD_PICKS).map(r => r.id);
    return { ok: true, pickedIds: defaultIds, isDefault: true, maxPicks: MAX_BOARD_PICKS };
  }

  const found = loadRun(rid, toks);
  if (!found) return { ok: false, code: 404, error: '找不到这条记录，请从原来使用的浏览器操作' };
  const target = doneList.find(r => r.id === rid);
  if (!target) return { ok: false, code: 400, error: '只有已结算的记录才能放入总榜' };

  const cur = new Set(pickUserWorldRuns(doneList).picked.map(r => r.id));
  const wantPick = opts.pick != null ? !!opts.pick : !cur.has(rid);

  if (wantPick) {
    if (!cur.has(rid)) {
      if (cur.size >= MAX_BOARD_PICKS) {
        return {
          ok: false,
          code: 400,
          error: `总榜最多只能选 ${MAX_BOARD_PICKS} 条记录，请先取消一条已上榜记录`,
        };
      }
      cur.add(rid);
    }
  } else {
    cur.delete(rid);
  }

  const isDefault = syncUserBoardPicks(doneList, cur);
  return {
    ok: true,
    id: rid,
    onBoard: cur.has(rid),
    pickedIds: [...cur],
    isDefault,
    maxPicks: MAX_BOARD_PICKS,
  };
}

function deleteRun(rid, tokenOrList) {
  const found = loadRun(rid, tokenOrList);
  if (!found) return false;
  const toks = expandTokens(tokenOrList);
  const beforeDone = userDoneWorldRuns(toks);
  const beforePick = pickUserWorldRuns(beforeDone);
  const wasOnBoard = beforePick.picked.some(r => r.id === rid);
  const hadCustom = beforeDone.some(r => r.board_pick === 1 || r.board_pick === 0);

  q.delTraces.run(String(rid));
  const del = q.delRun.run(String(rid));
  if (!(del.changes > 0)) return false;

  if (hadCustom) {
    const afterDone = beforeDone.filter(r => r.id !== rid);
    const kept = new Set(beforePick.picked.filter(r => r.id !== rid).map(r => r.id));
    if (wasOnBoard && kept.size < Math.min(MAX_BOARD_PICKS, afterDone.length)) {
      for (const r of afterDone) {
        if (!kept.has(r.id)) {
          kept.add(r.id);
          if (kept.size >= MAX_BOARD_PICKS) break;
        }
      }
    }
    syncUserBoardPicks(afterDone, kept);
  }
  return true;
}

const doneCount = () => worldBoardRows().length;
const rankWorld = usd => worldBoardRows().filter(r => r.world_usd > usd).length + 1;
const rankInYear = (year, earned) => q.rankYear.get(year, earned).n + 1;
const doneInYear = year => q.countYear.get(year).n;

const setOnBoard = (rid, flag) => q.setOnBoard.run(flag ? 1 : 0, String(rid || ''));

/* ── 穿越者时空留痕与跨局因果 ─────────────────────────
 * 每个穿越者在某年某月做出的重大事迹、超凡异闻或与其他穿越者结下的关系（成婚、结拜、合股、宿敌），
 * 会留在这一年的时空里，影响后来进入同一年的穿越者。
 * 严格控制上下文长度：只记真正重要的大事，每条不超过 44 字，同局同年同一对象关系就地更新不刷屏。 */
const SKIP_NICK = /^(无名|截图|上线试跑|探一下|测试|机器人|test|bot|1|2|x)$/i;
const qTrace = {
  ins: db.prepare(`INSERT INTO year_traces (run_id,nick,year,month,city,kind,partner,bond_type,summary,importance,created)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
  findBond: db.prepare(`SELECT id FROM year_traces WHERE run_id = ? AND year = ? AND kind = 'bond' AND partner = ? LIMIT 1`),
  findBondAny: db.prepare(`SELECT id, year, bond_type FROM year_traces WHERE run_id = ? AND kind = 'bond' AND partner = ? ORDER BY created DESC LIMIT 1`),
  updBond: db.prepare(`UPDATE year_traces SET month = ?, city = ?, bond_type = ?, summary = ?, importance = ?, created = ? WHERE id = ?`),
  countRunYear: db.prepare(`SELECT COUNT(*) n FROM year_traces WHERE run_id = ? AND year = ? AND kind <> 'bond'`),
  dupCheck: db.prepare(`SELECT 1 FROM year_traces WHERE run_id = ? AND year = ? AND summary = ? LIMIT 1`),
  byYear: db.prepare(`SELECT yt.id,yt.run_id,yt.nick,yt.year,yt.month,yt.city,yt.kind,yt.partner,yt.bond_type,yt.summary,yt.importance,yt.created
                      FROM year_traces yt
                      LEFT JOIN runs r ON r.id = yt.run_id
                      WHERE yt.year = ? AND yt.run_id <> ?
                        AND (r.id IS NULL OR COALESCE(r.on_board, 1) = 1)
                      ORDER BY yt.importance DESC, yt.created DESC LIMIT 20`),
  bondsForNick: db.prepare(`SELECT yt.year,yt.month,yt.city,yt.nick,yt.partner,yt.bond_type,yt.summary
                            FROM year_traces yt
                            LEFT JOIN runs r ON r.id = yt.run_id
                            WHERE yt.kind = 'bond' AND (yt.nick = ? OR yt.partner = ?)
                              AND (r.id IS NULL OR COALESCE(r.on_board, 1) = 1)
                            ORDER BY yt.created DESC LIMIT 6`),
  playersInYear: db.prepare(`SELECT id,nick,year,month,state,score,status
                             FROM runs
                             WHERE mode IN ('${MODE}', '${MODE_FAST}') AND COALESCE(on_board, 1) = 1
                               AND year BETWEEN ? AND ?
                               AND id <> ?
                             ORDER BY CASE WHEN status = 'done' THEN 0 ELSE 1 END, updated DESC LIMIT 12`),
  insCapsule: db.prepare(`INSERT INTO year_traces (run_id,nick,year,month,city,kind,partner,bond_type,summary,importance,created,capsule_kind,capsule_item,capsule_clue)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  hasCapsuleKind: db.prepare(`SELECT 1 FROM year_traces WHERE run_id = ? AND capsule_kind = ? LIMIT 1`),
  findLegacies: db.prepare(`SELECT yt.id,yt.run_id,yt.nick,yt.year,yt.month,yt.city,yt.kind,yt.summary,
                                   yt.capsule_kind,yt.capsule_item,yt.capsule_clue,yt.claimed_by,yt.claimed_year
                            FROM year_traces yt
                            LEFT JOIN runs r ON r.id = yt.run_id
                            WHERE yt.capsule_kind IN ('cache', 'legacy')
                              AND yt.year < ?
                              AND yt.run_id <> ?
                              AND (r.id IS NULL OR COALESCE(r.on_board, 1) = 1)
                            ORDER BY
                              CASE WHEN yt.city = ? THEN 0 ELSE 1 END,
                              CASE WHEN yt.capsule_kind = 'cache' AND yt.claimed_by IS NULL THEN 0 ELSE 1 END,
                              yt.year DESC, yt.created DESC
                            LIMIT 12`),
  getTraceById: db.prepare(`SELECT * FROM year_traces WHERE id = ?`),
  claimCache: db.prepare(`UPDATE year_traces SET claimed_by = ?, claimed_year = ?, claimed_run_id = ?
                          WHERE id = ? AND capsule_kind = 'cache' AND claimed_by IS NULL AND run_id <> ?`),
  totalCount: db.prepare(`SELECT COUNT(*) n FROM year_traces`),
};

function addTrace(runId, tr) {
  if (!tr || !tr.summary || !tr.year) return false;
  const nick = String(tr.nick || '').trim();
  if (SKIP_NICK.test(nick)) return false;
  const rid = String(runId);
  const yr = Number(tr.year);
  const mo = Number(tr.month || 1);
  const city = String(tr.city || '');
  const summary = String(tr.summary).replace(/\s+/g, ' ').trim().slice(0, 54);
  const imp = Number(tr.importance || 2);

  if (tr.kind === 'bond' && tr.partner) {
    const partner = String(tr.partner).trim();
    if (!partner || partner === nick || SKIP_NICK.test(partner)) return false;
    const bType = tr.bondType ? String(tr.bondType) : null;
    const hit = qTrace.findBond.get(rid, yr, partner);
    if (hit && hit.id) {
      qTrace.updBond.run(mo, city, bType, summary, imp, now(), hit.id);
      return true;
    }
    const prevAny = qTrace.findBondAny.get(rid, partner);
    if (prevAny && prevAny.bond_type && bType && prevAny.bond_type === bType) {
      /* 同一局对同一穿越者跨年仍是相同名分（如去年已记「同盟」，今年又来「同盟」），不再跨年复制刷屏 */
      return false;
    }
  } else {
    if (qTrace.dupCheck.get(rid, yr, summary)) return false;
    const cnt = qTrace.countRunYear.get(rid, yr).n;
    if (cnt >= 3) return false; // 同一局在同一年最多留 3 条事迹，防刷屏撑爆上下文
  }
  qTrace.ins.run(
    rid, nick || '异客', yr, mo, city, String(tr.kind || 'deed'),
    tr.partner ? String(tr.partner) : null,
    tr.bondType ? String(tr.bondType) : null,
    summary, imp, now()
  );
  return true;
}

/* 那些还没多少真人踩过的年份，按年代哈希给两位在当年活动的先遣穿越者，
 * 这样玩家随便挑哪一年进去，都有鲜活的同道穿越者可以偶遇、对暗号、抢货、合谋、比武乃至成婚。
 * 一旦真人穿越者在该年留下了痕迹，就优先展示真人的名号与事迹。 */
const FELLOW_SURNAMES = ['沈', '林', '顾', '苏', '陆', '谢', '裴', '叶', '江', '白', '秦', '温', '程', '宋', '许', '唐', '周', '韩', '孟', '梁'];
const FELLOW_GIVENS = [
  '青', '晚', '知微', '无咎', '听澜', '玄度', '见山', '栖梧', '渡川', '星河', '长庚', '霜降',
  '望舒', '怀瑾', '惊蛰', '南枝', '折柳', '观潮', '枕河', '临风', '清晏', '明远', '辞镜', '砚舟',
];
const FELLOW_ROLES_MUNDANE = [
  { tag: '行商', stance: '商路竞合', desc: '靠前世眼光提前卡位紧俏百货与行情，既是抢筹劲敌，谈拢了也能联手做大局' },
  { tag: '掮客', stance: '抢筹劲敌', desc: '专在城中行市与牙行之间倒腾紧俏货源，下手极快，动辄与同行压价争抢' },
  { tag: '消息通', stance: '情报博弈', desc: '常驻茶馆与街头耳目网，手里攥着政策与行情风声，肯拿情报换实在筹码' },
  { tag: '巧匠', stance: '手艺切磋', desc: '借现代见识改良老行当工艺与铺面打法，爱找懂行同乡切磋或合伙分润' },
  { tag: '武侠', stance: '义气结交', desc: '身怀内家拳脚，在码头与行会间立稳脚跟，敬重有胆有识的同道，不服便要比划' },
];
const FELLOW_ROLES_DARK = [
  { tag: '玄学', stance: '同道引路', desc: '在城角支摊批八字看风水，暗里收罗带灵气的古物，爱拿半句现代俗语试探同乡' },
  { tag: '鬼市', stance: '暗市合股', desc: '常在子夜半步鬼市提灯出没，专做旧物奇货与偏门消息的买卖，谈价极精' },
  { tag: '奇巧', stance: '巧匠合作', desc: '在后院暗室捣鼓秘药器物与古法改良，常找懂现代门路的人合伙试制' },
  { tag: '丹方', stance: '奇门互市', desc: '在旧书肆和药铺寻觅残篇古方，手头握着偏门秘法但缺世俗本钱与销路' },
  { tag: '古祠', stance: '香火共济', desc: '修缮城郊荒废古祠，借旧时香火人脉在三教九流里穿梭，亦暗中收放旧物' },
];

function mix32(n) {
  let x = n >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

function fallbackFellows(year, city, avoidNick = '') {
  const y = Number(year) || 1948;
  const m1 = mix32(y * 2654435761);
  const m2 = mix32((y + 97) * 2246822519);
  const avoid = String(avoidNick || '').trim();
  const avoidTail = avoid.length >= 2 ? avoid.slice(-2) : '';
  const clashes = (sIdx, gIdx) => {
    if (!avoid) return false;
    const nm = FELLOW_SURNAMES[sIdx] + FELLOW_GIVENS[gIdx];
    return nm === avoid || (avoidTail && (FELLOW_GIVENS[gIdx] === avoidTail || nm.endsWith(avoidTail)));
  };
  /* 姓氏与名字分属两个互不相交的半区并配与 12 互质的步长，确保同年两人及连续多年绝不撞名撞字，亦不与当前主角撞字 */
  const s1 = ((y * 3) + (m1 % 3)) % 10;
  let g1 = (((y * 5) % 12) + 12) % 12;
  if (clashes(s1, g1)) g1 = (g1 + 1) % 12;
  const s2 = 10 + (((y * 7) + (m2 % 3)) % 10);
  let g2 = 12 + ((((y * 7) % 12) + 12) % 12);
  if (clashes(s2, g2)) g2 = 12 + (((g2 - 12) + 1) % 12);
  const name1 = FELLOW_SURNAMES[s1] + FELLOW_GIVENS[g1];
  const name2 = FELLOW_SURNAMES[s2] + FELLOW_GIVENS[g2];
  /* 每年必配一位偏市井商路竞合/博弈型与一位偏江湖暗面/奇门型同行，兼顾商战抢筹与暗面探索 */
  const r1 = FELLOW_ROLES_MUNDANE[(y * 2 + (m1 >>> 4)) % FELLOW_ROLES_MUNDANE.length];
  const r2 = FELLOW_ROLES_DARK[(y * 3 + (m2 >>> 4)) % FELLOW_ROLES_DARK.length];
  const c = city || '城里';
  const f1 = {
    nick: name1, year: y, month: (m1 % 6) + 1, city: c, kind: 'traveler', origin: 'fellow',
    tag: r1.tag, stance: r1.stance, desc: r1.desc,
    summary: `穿越者「${name1}」落脚${c}：${r1.desc}`,
  };
  const f2 = {
    nick: name2, year: y, month: (m2 % 6) + 4, city: c, kind: 'traveler', origin: 'fellow',
    tag: r2.tag, stance: r2.stance, desc: r2.desc,
    summary: `穿越者「${name2}」也在${c}：${r2.desc}`,
  };
  return (y % 2 === 0) ? [f1, f2] : [f2, f1];
}

/* 启动时若 year_traces 为空，从已有合乎当前规则的对局里提取头几条重要事迹入库 */
{
  try {
    if (qTrace.totalCount.get().n === 0) {
      const existing = db.prepare(`SELECT id,nick,year,month,state,score,status FROM runs WHERE mode = 'months24' AND COALESCE(on_board, 1) = 1 ORDER BY updated DESC LIMIT 30`).all();
      for (const r of existing) {
        if (SKIP_NICK.test(r.nick || '')) continue;
        let st; try { st = JSON.parse(r.state); } catch (e) { continue; }
        if (!st || !Array.isArray(st.months) || !st.months.length) continue;
        const traits = ((st.memo && st.memo.traits) || [])
          .filter(t => !t.lost && !/^与穿越者/.test(t.what))
          .map(t => t.what)
          .slice(0, 2);
        const city = st.city || '';
        const summary = traits.length
          ? `穿越者「${r.nick}」曾在${city}闯荡，挣下「${traits.join('、')}」的名头`
          : (r.score >= 5 ? `穿越者「${r.nick}」在${city}大展拳脚，两年攒下普通人 ${Math.round(r.score)} 年的收入` : '');
        if (summary) {
          addTrace(r.id, {
            year: r.year, month: r.month, city, nick: r.nick,
            kind: 'deed', summary: summary.slice(0, 50), importance: r.score >= 10 ? 3 : 2,
          });
        }
      }
    }
  } catch (e) { /* 忽略初始化回填异常 */ }
}

/** 读取某一年（及当前穿越者名下）的跨局时空留痕与同年活跃穿越者。
 *  严格限制条数与字数：最多 4 条多元化的当年大事 + 3 位同年穿越者名录 + 2 条本人跨局因果。 */
function yearEchoes(year, month = 12, opts = {}) {
  const yr = Number(year);
  const ex = String(opts.excludeRunId || '');
  const nick = String(opts.nick || '').trim();
  const city = String(opts.city || '');
  const rows = qTrace.byYear.all(yr, ex);

  const seenSummary = new Set();
  const runCounts = new Map();
  const bondPairSeen = new Set();
  const picked = [];
  for (const r of rows) {
    if (!r || seenSummary.has(r.summary)) continue;
    const rCount = runCounts.get(r.run_id) || 0;
    if (rCount >= 2) continue; // 同一局在同年最多展示 2 条，留位置给其他穿越者
    if (r.kind === 'bond' && r.partner) {
      const pk = `${r.nick}::${r.partner}`;
      if (bondPairSeen.has(pk)) continue;
      bondPairSeen.add(pk);
    }
    seenSummary.add(r.summary);
    runCounts.set(r.run_id, rCount + 1);
    picked.push({
      nick: r.nick, year: r.year, month: r.month, city: r.city,
      kind: r.kind, partner: r.partner, bondType: r.bond_type,
      summary: r.summary,
    });
    if (picked.length >= 4) break;
  }

  /* 组装同年活跃穿越者名录（优先展示真人穿越者，不足 3 位时由先遣穿越者补齐） */
  const fellows = [];
  const seenNick = new Set(nick ? [nick] : []);
  try {
    const pRows = qTrace.playersInYear.all(yr - 1, yr, ex);
    for (const pr of pRows) {
      const pNick = String(pr.nick || '').trim();
      if (!pNick || SKIP_NICK.test(pNick) || seenNick.has(pNick)) continue;
      let st; try { st = JSON.parse(pr.state); } catch (e) { continue; }
      if (!st || !Array.isArray(st.months) || st.months.length < 2) continue;
      const touchedYear = Number(pr.year) === yr || st.months.some(m => Number(m.year) === yr);
      if (!touchedYear) continue;
      const traits = ((st.memo && st.memo.traits) || [])
        .filter(t => !t.lost && !/^与穿越者/.test(t.what))
        .map(t => t.what)
        .slice(0, 2);
      const pCity = st.city || city || '城里';
      const desc = traits.length
        ? `在${pCity}经营「${traits.join('、')}」，风头正盛`
        : (st.persona ? `落脚${pCity}（${String(st.persona).slice(0, 18)}）` : `正在${pCity}闯荡谋局`);
      seenNick.add(pNick);
      fellows.push({
        nick: pNick, year: yr, city: pCity, origin: 'player',
        tag: '历届穿越者', stance: '真人留痕', desc,
        summary: `穿越者「${pNick}」在${pCity}：${desc}`,
      });
      if (fellows.length >= 2) break;
    }
  } catch (e) {}

  for (const fb of fallbackFellows(yr, city, nick)) {
    if (seenNick.has(fb.nick)) continue;
    seenNick.add(fb.nick);
    fellows.push(fb);
    if (fellows.length >= 3) break;
  }

  if (picked.length < 2) {
    for (const f of fellows) {
      if (!picked.some(p => p.nick === f.nick)) {
        picked.push({
          nick: f.nick, year: yr, month: f.month || 1, city: f.city || city,
          kind: 'traveler', partner: null, bondType: null,
          summary: f.summary,
        });
        if (picked.length >= 3) break;
      }
    }
  }

  const myBonds = [];
  if (nick && !SKIP_NICK.test(nick)) {
    const seenB = new Set();
    for (const b of qTrace.bondsForNick.all(nick, nick)) {
      const k = `${b.nick}::${b.partner}::${b.year}`;
      if (seenB.has(k)) continue;
      seenB.add(k);
      myBonds.push(b.summary);
      if (myBonds.length >= 2) break;
    }
  }
  const legacies = crossEraLegacies(yr, city, { excludeRunId: ex });
  return { traces: picked, fellows, myBonds, legacies };
}

/* ── 跨年代时空留物 / 百年字号接力 ─────────────────────────── */
function addCapsule(runId, cap) {
  if (!cap || !cap.item || !cap.clue || !cap.year) return null;
  const nick = String(cap.nick || '').trim();
  if (!nick || SKIP_NICK.test(nick)) return null;
  const rid = String(runId || '');
  const cKind = cap.capsuleKind === 'cache' ? 'cache' : 'legacy';
  if (qTrace.hasCapsuleKind.get(rid, cKind)) return null;
  const item = String(cap.item).replace(/\s+/g, ' ').trim().slice(0, 18);
  const clue = String(cap.clue).replace(/\s+/g, ' ').trim().slice(0, 42);
  const summary = String(cap.summary || `${nick}在${cap.city || '城里'}留下「${item}」`).slice(0, 54);
  const res = qTrace.insCapsule.run(
    rid, nick, Number(cap.year), Number(cap.month || 1), String(cap.city || ''),
    cKind === 'cache' ? 'capsule' : 'legacy',
    null, null, summary, 3, now(),
    cKind, item, clue
  );
  return {
    id: Number(res.lastInsertRowid || 0),
    year: Number(cap.year),
    month: Number(cap.month || 1),
    city: String(cap.city || ''),
    nick,
    capsuleKind: cKind,
    item,
    clue,
    summary,
  };
}

function claimCapsule(traceId, claimer = {}) {
  const tid = Number(traceId);
  if (!(tid > 0)) return null;
  const row = qTrace.getTraceById.get(tid);
  if (!row || row.capsule_kind !== 'cache') return null;
  const nick = String(claimer.nick || '').trim();
  const rid = String(claimer.runId || '');
  if (!nick || SKIP_NICK.test(nick) || row.run_id === rid) return null;
  const r = qTrace.claimCache.run(nick, Number(claimer.year || 0), rid, tid, rid);
  if (!(r.changes > 0)) return { alreadyClaimed: true, claimedBy: row.claimed_by, claimedYear: row.claimed_year, item: row.capsule_item, fromNick: row.nick, fromYear: row.year };
  return {
    claimed: true,
    id: tid,
    item: row.capsule_item,
    fromNick: row.nick,
    fromYear: row.year,
    city: row.city,
  };
}

const FALLBACK_CAPSULES = [
  { kind: 'cache', item: '槐树下的锈铁盒', clue: '城西老庙槐树根下三尺，刻着半句「奇变偶不变」' },
  { kind: 'legacy', item: '同源旧字号', clue: '老街深处挂着一块旧匾，掌柜还记得当年那位古怪东家的暗语' },
  { kind: 'cache', item: '砖缝里的油纸包', clue: '旧码头渡口石碑后头藏着一包硬货与一张手绘草图' },
  { kind: 'legacy', item: '半步茶寮旧约', clue: '老茶馆后厢留着一块寄茶木牌，报上旧年暗号能讨一条门路' },
];

function fallbackLegacyFor(year, city) {
  const yr = Number(year);
  if (!(yr >= 1931) || !city) return null;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < city.length; i++) { h ^= city.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const dec = Math.floor(yr / 10);
  const h2 = ((h ^ (dec * 2654435761)) >>> 0);
  const span = Math.min(28, Math.max(4, yr - 1926));
  const fromYear = Math.max(1926, yr - (4 + (h2 % Math.max(1, span - 3))));
  const nick = FELLOW_SURNAMES[h2 % FELLOW_SURNAMES.length] + FELLOW_GIVENS[(h2 >>> 5) % FELLOW_GIVENS.length];
  const tpl = FALLBACK_CAPSULES[h2 % FALLBACK_CAPSULES.length];
  return {
    id: null,
    origin: 'fallback',
    year: fromYear,
    city,
    nick,
    capsuleKind: tpl.kind,
    item: tpl.item,
    clue: tpl.clue,
    claimedBy: null,
    claimedYear: null,
  };
}

function crossEraLegacies(year, city, opts = {}) {
  const yr = Number(year);
  const ex = String(opts.excludeRunId || '');
  const c = String(city || '').trim();
  const out = [];
  if (yr > 1926) {
    try {
      const rows = qTrace.findLegacies.all(yr, ex, c);
      let hasCache = false, hasLegacy = false;
      for (const r of rows) {
        if (!r || !r.capsule_item) continue;
        if (c && r.city && r.city !== c) continue;
        if (r.capsule_kind === 'cache' && hasCache) continue;
        if (r.capsule_kind === 'legacy' && hasLegacy) continue;
        if (r.capsule_kind === 'cache') hasCache = true;
        if (r.capsule_kind === 'legacy') hasLegacy = true;
        out.push({
          id: r.id,
          origin: 'player',
          year: r.year,
          city: r.city,
          nick: r.nick,
          capsuleKind: r.capsule_kind,
          item: r.capsule_item,
          clue: r.capsule_clue || r.summary,
          claimedBy: r.claimed_by || null,
          claimedYear: r.claimed_year || null,
        });
        if (out.length >= 2) break;
      }
    } catch (e) {}
  }
  if (!out.length) {
    const fb = fallbackLegacyFor(yr, c);
    if (fb) out.push(fb);
  }
  return out;
}

/** 查当前浏览器用户的历史对局有没有收到来自其他穿越者的跨时空回响（暗盒被挖、被结缘等）。 */
function echoAlertsForTokens(tokenOrList) {
  const toks = expandTokens(tokenOrList);
  if (!toks.length) return [];
  try {
    const ph = toks.map(() => '?').join(',');
    const mine = db.prepare(`SELECT id, nick, year FROM runs WHERE token IN (${ph}) ORDER BY created DESC LIMIT 100`).all(...toks);
    if (!mine.length) return [];
    const runIds = mine.map(r => r.id);
    const nicks = [...new Set(mine.map(r => String(r.nick || '').trim()).filter(n => n && !SKIP_NICK.test(n)))];
    const alerts = [];
    const rPh = runIds.map(() => '?').join(',');
    const claimed = db.prepare(`
      SELECT year, city, capsule_item, claimed_by, claimed_year
      FROM year_traces
      WHERE run_id IN (${rPh}) AND claimed_by IS NOT NULL
      ORDER BY created DESC LIMIT 4
    `).all(...runIds);
    for (const c of claimed) {
      alerts.push({
        kind: 'capsule',
        text: `你在 ${c.year} 年${c.city}留下的「${c.capsule_item}」，被 ${c.claimed_year || ''} 年的穿越者「${c.claimed_by}」寻走了`,
      });
    }
    if (nicks.length) {
      const nPh = nicks.map(() => '?').join(',');
      const bonds = db.prepare(`
        SELECT nick, partner, year, city, bond_type, summary
        FROM year_traces
        WHERE kind = 'bond' AND partner IN (${nPh}) AND run_id NOT IN (${rPh})
        ORDER BY created DESC LIMIT 4
      `).all(...nicks, ...runIds);
      const seen = new Set();
      for (const b of bonds) {
        const k = `${b.nick}::${b.partner}::${b.year}`;
        if (seen.has(k)) continue;
        seen.add(k);
        alerts.push({
          kind: 'bond',
          text: `${b.year} 年${b.city}，穿越者「${b.nick}」在另一段岁月里与你的「${b.partner}」结下${b.bond_type || '渊源'}`,
        });
      }
    }
    return alerts.slice(0, 4);
  } catch (e) {
    return [];
  }
}

/** 查当前浏览器用户在哪些年份已完结，返回每年的朱砂印文供首页画卷墙盖印。 */
function myStamps(tokenOrList, stampFn) {
  const toks = expandTokens(tokenOrList);
  if (!toks.length) return {};
  try {
    const ph = toks.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, year, score, review, extra_review, mode, updated
      FROM runs
      WHERE token IN (${ph}) AND status = 'done' AND mode IN ('${MODE}', '${MODE_FAST}')
      ORDER BY score DESC, updated DESC
    `).all(...toks);
    const map = {};
    for (const r of rows) {
      if (map[r.year]) continue;
      let title = '', stamp = '';
      for (const raw of [r.extra_review, r.review]) {
        if (!raw) continue;
        try {
          const rv = JSON.parse(raw);
          if (rv && rv.stamp) { stamp = String(rv.stamp); title = rv.title || ''; break; }
          if (rv && rv.title) { title = String(rv.title); break; }
        } catch {}
      }
      const label = stamp || (typeof stampFn === 'function' ? stampFn(title, r.score) : (title.slice(0, 4) || '已走完'));
      map[r.year] = { id: r.id, stamp: label, title: title || label, score: r.score, mode: r.mode };
    }
    return map;
  } catch (e) {
    return {};
  }
}

module.exports = {
  db, createRun, loadRun, saveRun, finishRun, setOnBoard, board, myRuns, linkTokens, doneCount,
  rankWorld, rankInYear, doneInYear, yearsWithRuns, FILE, MODE, MODE_FAST,
  startExtra, finishExtra, saveReview, getRow, boardExtra, extraCount, rankExtra,
  boardFast, fastCount, rankFast,
  addTrace, addCapsule, claimCapsule, crossEraLegacies, echoAlertsForTokens, myStamps,
  yearEchoes, fallbackFellows, SKIP_NICK, deleteRun, setBoardPick, MAX_BOARD_PICKS,
};
