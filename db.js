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
  aliasesOf: db.prepare(`SELECT target_token FROM token_aliases WHERE token = ?`),
  addAlias: db.prepare(`INSERT OR IGNORE INTO token_aliases (token, target_token) VALUES (?, ?)`),
};

function expandTokens(tokenOrList) {
  const parts = Array.isArray(tokenOrList)
    ? tokenOrList
    : String(tokenOrList || '').split(',');
  const base = [...new Set(parts.map(s => String(s || '').trim()).filter(s => VALID_TOK.test(s)))];
  if (!base.length) return [];
  const all = new Set(base);
  for (const t of base) {
    for (const r of q.aliasesOf.all(t)) {
      if (r && r.target_token) all.add(r.target_token);
    }
  }
  return [...all];
}

function linkTokens(fromToken, toToken) {
  if (!VALID_TOK.test(String(fromToken || '')) || !VALID_TOK.test(String(toToken || ''))) return;
  q.addAlias.run(fromToken, toToken);
}

function createRun(state, nick, preferredToken) {
  const rid = id();
  const cleanPref = typeof preferredToken === 'string' ? preferredToken.trim() : '';
  const token = VALID_TOK.test(cleanPref) && cleanPref.length >= 12
    ? cleanPref
    : crypto.randomBytes(16).toString('base64url');
  const t = now();
  q.ins.run(rid, token, nick, state.startYear || state.year, state.startMonth || state.month, JSON.stringify(state), 'playing', t, t, MODE);
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

function myRuns(tokenOrList) {
  const toks = expandTokens(tokenOrList);
  if (!toks.length) return [];
  if (toks.length === 1) return q.mine.all(toks[0]);
  const ph = toks.map(() => '?').join(',');
  return db.prepare(`SELECT id,nick,year,month,status,score,created,mode,
                            extra_status,extra_months,extra_score,review,extra_review
                     FROM runs WHERE token IN (${ph}) ORDER BY created DESC LIMIT 50`).all(...toks);
}
const doneCount = () => q.countDone.get().n;
const rankWorld = usd => q.rankWorld.get(usd).n + 1;
const rankInYear = (year, earned) => q.rankYear.get(year, earned).n + 1;
const doneInYear = year => q.countYear.get(year).n;

/* ── 穿越者时空留痕与跨局因果 ─────────────────────────
 * 每个穿越者在某年某月做出的重大事迹、超凡异闻或与其他穿越者结下的关系（成婚、结拜、合股、宿敌），
 * 会留在这一年的时空里，影响后来进入同一年的穿越者。
 * 严格控制上下文长度：只记真正重要的大事，每条不超过 42 字，每次最多取 4 条注入上下文。 */
const SKIP_NICK = /^(无名|截图|上线试跑|测试|test|bot|1|2|x)$/i;
const qTrace = {
  ins: db.prepare(`INSERT INTO year_traces (run_id,nick,year,month,city,kind,partner,bond_type,summary,importance,created)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)`),
  countRunYear: db.prepare(`SELECT COUNT(*) n FROM year_traces WHERE run_id = ? AND year = ? AND kind <> 'bond'`),
  dupCheck: db.prepare(`SELECT 1 FROM year_traces WHERE run_id = ? AND year = ? AND summary = ? LIMIT 1`),
  byYear: db.prepare(`SELECT id,run_id,nick,year,month,city,kind,partner,bond_type,summary,importance,created
                      FROM year_traces WHERE year = ? AND run_id <> ?
                      ORDER BY importance DESC, created DESC LIMIT 12`),
  bondsForNick: db.prepare(`SELECT year,month,city,nick,partner,bond_type,summary
                            FROM year_traces WHERE kind = 'bond' AND (nick = ? OR partner = ?)
                            ORDER BY created DESC LIMIT 3`),
  totalCount: db.prepare(`SELECT COUNT(*) n FROM year_traces`),
};

function addTrace(runId, tr) {
  if (!tr || !tr.summary || !tr.year) return false;
  const nick = String(tr.nick || '').trim();
  if (SKIP_NICK.test(nick)) return false;
  if (qTrace.dupCheck.get(String(runId), Number(tr.year), String(tr.summary))) return false;
  if (tr.kind !== 'bond') {
    const cnt = qTrace.countRunYear.get(String(runId), Number(tr.year)).n;
    if (cnt >= 3) return false; // 同一局在同一年最多留 3 条事迹，防刷屏撑爆上下文
  }
  qTrace.ins.run(
    String(runId), nick || '异客', Number(tr.year), Number(tr.month || 1),
    String(tr.city || ''), String(tr.kind || 'deed'),
    tr.partner ? String(tr.partner) : null,
    tr.bondType ? String(tr.bondType) : null,
    String(tr.summary).slice(0, 44),
    Number(tr.importance || 2),
    now()
  );
  return true;
}

/* 那些还没多少真人踩过的年份，按年代哈希给两位在当年活动的先遣穿越者，
 * 这样玩家随便挑哪一年进去，都有同道穿越者可以偶遇、合谋、比武乃至成婚。
 * 一旦真人穿越者在该年留下了足够多的痕迹，就优先展示真人的。 */
const FELLOW_SURNAMES = ['沈', '林', '顾', '苏', '陆', '谢', '裴', '叶', '江', '白', '秦', '温'];
const FELLOW_GIVENS = ['青', '晚', '知微', '无咎', '听澜', '玄度', '见山', '栖梧', '渡川', '星河', '长庚', '霜降'];
const FELLOW_ROLES = [
  { tag: '玄学', desc: '在城角支摊批八字看风水，暗里收罗带灵气的古物，待人随和' },
  { tag: '修仙', desc: '自称云游散修，在旧书肆和药铺寻觅丹方与吐纳残篇，性子清冷' },
  { tag: '武侠', desc: '身怀内家拳脚，在码头与镖行之间接护送险活，重义气' },
  { tag: '鬼怪', desc: '常在子夜半步鬼市提灯出没，专做阴阳两界奇货与凶宅平事的买卖' },
  { tag: '魔法', desc: '在钟表行后院熬制西洋炼金魔药、刻印符文器物，见多识广' },
  { tag: '克苏鲁', desc: '暗中调查海港深海黑石雕与异域密教手札，手里有不少稀罕情报' },
  { tag: '神魔', desc: '重修城郊一座荒废古祠，借落魄神明香火替人消灾祈福' },
  { tag: '行商', desc: '靠前世眼光倒腾紧俏百货与房产，手头宽裕，正寻同道合伙或结缘' },
];

function fallbackFellows(year, city) {
  const h1 = ((year * 2654435761) >>> 0);
  const h2 = (((year + 37) * 2246822519) >>> 0);
  const name1 = FELLOW_SURNAMES[h1 % FELLOW_SURNAMES.length] + FELLOW_GIVENS[(h1 >>> 5) % FELLOW_GIVENS.length];
  let name2 = FELLOW_SURNAMES[h2 % FELLOW_SURNAMES.length] + FELLOW_GIVENS[(h2 >>> 6) % FELLOW_GIVENS.length];
  if (name2 === name1) name2 = FELLOW_SURNAMES[(h2 + 3) % FELLOW_SURNAMES.length] + FELLOW_GIVENS[(h2 + 7) % FELLOW_GIVENS.length];
  const r1 = FELLOW_ROLES[h1 % FELLOW_ROLES.length];
  const r2 = FELLOW_ROLES[(h1 + 3 + (h2 % 4)) % FELLOW_ROLES.length];
  const c = city || '城里';
  return [
    { nick: name1, year, month: (h1 % 6) + 1, city: c, kind: 'traveler', summary: `穿越者「${name1}」落脚${c}：${r1.desc}` },
    { nick: name2, year, month: (h2 % 6) + 4, city: c, kind: 'traveler', summary: `穿越者「${name2}」也在${c}：${r2.desc}` },
  ];
}

/* 启动时若 year_traces 为空，从已有真实对局里提取头几条重要事迹入库 */
{
  try {
    if (qTrace.totalCount.get().n === 0) {
      const existing = db.prepare(`SELECT id,nick,year,month,state,score,status FROM runs WHERE mode = 'months24' ORDER BY updated DESC LIMIT 30`).all();
      for (const r of existing) {
        if (SKIP_NICK.test(r.nick || '')) continue;
        let st; try { st = JSON.parse(r.state); } catch (e) { continue; }
        if (!st || !Array.isArray(st.months) || !st.months.length) continue;
        const traits = ((st.memo && st.memo.traits) || []).filter(t => !t.lost).map(t => t.what).slice(0, 2);
        const city = st.city || '';
        const summary = traits.length
          ? `穿越者「${r.nick}」曾在${city}闯荡，挣下「${traits.join('、')}」的名头`
          : (r.score >= 5 ? `穿越者「${r.nick}」在${city}大展拳脚，两年攒下普通人 ${Math.round(r.score)} 年的收入` : '');
        if (summary) {
          addTrace(r.id, {
            year: r.year, month: r.month, city, nick: r.nick,
            kind: 'deed', summary: summary.slice(0, 42), importance: r.score >= 10 ? 3 : 2,
          });
        }
      }
    }
  } catch (e) { /* 忽略初始化回填异常 */ }
}

/** 读取某一年（及当前穿越者名下）的跨局时空留痕。
 *  严格限制条数与字数：最多返回 4 条当年大事/同行穿越者 + 2 条与本人相关的因果羁绊。 */
function yearEchoes(year, month = 12, opts = {}) {
  const ex = String(opts.excludeRunId || '');
  const nick = String(opts.nick || '').trim();
  const city = String(opts.city || '');
  const rows = qTrace.byYear.all(Number(year), ex);
  const seen = new Set();
  const picked = [];
  for (const r of rows) {
    if (seen.has(r.summary)) continue;
    seen.add(r.summary);
    picked.push({
      nick: r.nick, year: r.year, month: r.month, city: r.city,
      kind: r.kind, partner: r.partner, bondType: r.bond_type,
      summary: r.summary,
    });
    if (picked.length >= 4) break;
  }
  if (picked.length < 2) {
    for (const fb of fallbackFellows(Number(year), city)) {
      if (fb.nick !== nick && !picked.some(p => p.nick === fb.nick)) {
        picked.push(fb);
        if (picked.length >= 3) break;
      }
    }
  }
  const myBonds = (nick && !SKIP_NICK.test(nick))
    ? qTrace.bondsForNick.all(nick, nick).map(b => b.summary).slice(0, 2)
    : [];
  return { traces: picked, myBonds };
}

module.exports = {
  db, createRun, loadRun, saveRun, finishRun, board, myRuns, linkTokens, doneCount,
  rankWorld, rankInYear, doneInYear, yearsWithRuns, FILE,
  startExtra, finishExtra, saveReview, getRow, boardExtra, extraCount, rankExtra,
  addTrace, yearEchoes,
};
