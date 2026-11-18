'use strict';
/* 《这一百年》的服务端。没有框架，Node 自带的 http 就够。
 *
 *   secret exec OPENROUTER_API_KEY -- node server.js
 *   端口默认 8801，改环境变量 HY_PORT
 *
 * 不带密钥也起得来：/api/health 回 ai:false，每个月的演算走本地兜底，
 * 能玩完一局，只是正文是模板。
 *
 * 一局是二十四个月。玩家盯着屏幕等的那一次调用（/api/month）默认走流式：
 * 正文边写边往外吐，写完再把这个月的账和状态一次性发过去。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const E = require('./engine.js');
const SIM = require('./sim.js');
const DB = require('./db.js');
const VOICE = require('./voice-asr.js');

const PORT = Number(process.env.HY_PORT || 8801);
const PUBLIC = path.join(__dirname, 'public');
const IMG_DIR = path.join(__dirname, 'data', 'images');
fs.mkdirSync(IMG_DIR, { recursive: true });
const HAS_KEY = !!process.env.OPENROUTER_API_KEY;
const { execFile } = require('child_process');

/* ── 每月插画：落盘保存、按局+月份去重防重复扣费 ───────────── */
const imgJobs = new Map();
const cleanRunId = id => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
function findImgFile(runId, n) {
  const sid = cleanRunId(runId), num = Number(n);
  if (!sid || !(num >= 1 && num <= 120)) return null;
  for (const ext of ['jpg', 'png', 'webp']) {
    const f = path.join(IMG_DIR, `${sid}-${num}.${ext}`);
    if (fs.existsSync(f)) return { file: f, ext };
  }
  return null;
}
function imgUrlOf(runId, n) {
  const hit = findImgFile(runId, n);
  return hit ? `/api/month-image?id=${encodeURIComponent(cleanRunId(runId))}&n=${Number(n)}` : null;
}
function compressToJpg(rawBuf, rawExt, destJpg) {
  return new Promise(resolve => {
    const tmp = `${destJpg}.tmp.${rawExt || 'png'}`;
    try { fs.writeFileSync(tmp, rawBuf); } catch (e) { return resolve(false); }
    execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', '960', tmp, '--out', destJpg], err => {
      try { fs.unlinkSync(tmp); } catch (e) {}
      if (!err && fs.existsSync(destJpg)) return resolve(true);
      try { fs.writeFileSync(destJpg, rawBuf); return resolve(true); } catch (e) { return resolve(false); }
    });
  });
}
function ensureMonthImage(runId, s, played) {
  const sid = cleanRunId(runId), num = Number(played && played.n);
  if (!sid || !(num >= 1 && num <= 120) || !HAS_KEY) return Promise.resolve(null);
  const existing = imgUrlOf(sid, num);
  if (existing) return Promise.resolve(existing);
  const key = `${sid}:${num}`;
  if (imgJobs.has(key)) return imgJobs.get(key);
  const job = (async () => {
    try {
      const out = await SIM.runMonthImage(s, played);
      const dest = path.join(IMG_DIR, `${sid}-${num}.jpg`);
      await compressToJpg(out.buffer, out.ext, dest);
      return imgUrlOf(sid, num);
    } catch (err) {
      console.error('生成月度插画失败：', String(err && err.message).slice(0, 200));
      return null;
    } finally {
      imgJobs.delete(key);
    }
  })();
  imgJobs.set(key, job);
  return job;
}

function findFinaleImgFile(runId, extra = false) {
  const sid = cleanRunId(runId);
  if (!sid) return null;
  const tag = extra ? 'finale-extra' : 'finale';
  for (const ext of ['jpg', 'png', 'webp']) {
    const f = path.join(IMG_DIR, `${sid}-${tag}.${ext}`);
    if (fs.existsSync(f)) return { file: f, ext };
  }
  return null;
}
function finaleImgUrlOf(runId, extra = false) {
  const sid = cleanRunId(runId);
  const hit = findFinaleImgFile(sid, extra);
  return hit ? `/api/finale-image?id=${encodeURIComponent(sid)}${extra ? '&extra=1' : ''}` : null;
}
function ensureFinaleImage(runId, s, r, rev, extra = false) {
  const sid = cleanRunId(runId);
  if (!sid || !HAS_KEY) return Promise.resolve(null);
  const existing = finaleImgUrlOf(sid, extra);
  if (existing) return Promise.resolve(existing);
  const tag = extra ? 'finale-extra' : 'finale';
  const key = `${sid}:${tag}`;
  if (imgJobs.has(key)) return imgJobs.get(key);
  const job = (async () => {
    try {
      const out = await SIM.runFinaleImage(s, r, rev);
      const dest = path.join(IMG_DIR, `${sid}-${tag}.jpg`);
      await compressToJpg(out.buffer, out.ext, dest);
      return finaleImgUrlOf(sid, extra);
    } catch (err) {
      console.error('生成结算收官插画失败：', String(err && err.message).slice(0, 200));
      return null;
    } finally {
      imgJobs.delete(key);
    }
  })();
  imgJobs.set(key, job);
  return job;
}

/* ── 限流：每调一次模型都是真金白银 ─────────────────── */
const WINDOW = Number(process.env.HY_RATE_WINDOW || 10 * 60 * 1000);
const PER_IP = Number(process.env.HY_RATE_IP || 60);
const TOTAL = Number(process.env.HY_RATE_ALL || 600);
const hits = new Map();
let allHits = [];

function rateOk(ip) {
  const t = Date.now(), cut = t - WINDOW;
  allHits = allHits.filter(x => x > cut);
  const mine = (hits.get(ip) || []).filter(x => x > cut);
  if (mine.length >= PER_IP) return { ok: false, why: 'ip' };
  if (allHits.length >= TOTAL) return { ok: false, why: 'all' };
  mine.push(t); hits.set(ip, mine); allHits.push(t);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(x => x > cut)) hits.delete(k);
  return { ok: true };
}

/** 线上真实 IP 只能从 X-Forwarded-For 读，而且只在连接来自回环时才信它——
 *  非回环连接上的这个头是客户端自己写的，信了等于没限流。 */
function clientIp(req) {
  const sock = req.socket.remoteAddress || '';
  const loopback = sock === '127.0.0.1' || sock === '::1' || sock === '::ffff:127.0.0.1';
  if (loopback) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return sock;
}

/* ── 一局一把锁 ──────────────────────────────────────
 * 同一局同时来两个「过完这一天」，两边都会读同一份存档、各算各的，
 * 后写的把先写的盖掉——那一天白算了，钱也对不上。
 * 前端把按钮禁了，但接口是公开的，得在这边挡住。 */
const busy = new Set();

/* ── 年份目录，起服务时装一次 ───────────────────────── */
const YEARS_DIR = path.join(__dirname, 'data', 'years');
const CATALOG = E.SPINE.years.map(y => {
  const f = path.join(YEARS_DIR, `${y.year}.json`);
  const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  return {
    year: y.year, city: y.city, ceiling: y.ceiling,
    era: c ? c.era : null,
    ready: !!c,
    /* 二十四个月要走得完：最晚只能从 2024 年 1 月开局 */
    startMonths: Array.from({ length: 12 }, (_, i) => i + 1).filter(m => E.startable(y.year, m)),
    currencies: y.currencies.map(x => E.CN[x]),
    switch: y.switch ? { month: y.switch.month, day: y.switch.day, say: y.switch.say } : null,
  };
});

/* ── 小工具 ────────────────────────────────────────── */
const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': b.length, 'cache-control': 'no-store' });
  res.end(b);
};
const oops = (res, code, say) => json(res, code, { error: say });

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', d => { n += d.length; if (n > limit) { req.destroy(); reject(new Error('太大了')); } else parts.push(d); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { reject(new Error('不是合法的 JSON')); } });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) return oops(res, 403, '无法访问此页面');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return oops(res, 404, '没有这个页面');
    const ext = path.extname(file).toLowerCase();
    const noCache = ext === '.html' || ext === '.js' || ext === '.css';
    const isAsset = rel.startsWith('/assets/') || rel === '/favicon.ico';
    const cc = noCache ? 'no-store' : (isAsset ? 'public, max-age=604800' : 'max-age=60, must-revalidate');
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': cc,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/* ── 给前端的存档视图 ──────────────────────────────── */
function view(s, runId) {
  const cur = E.currencyOf(s.year, s.month);
  const rid = runId || s.id || '';
  return {
    /* year/month 是**走到哪个月**，startYear/startMonth 才是开局那个月 */
    year: s.year, month: s.month,
    startYear: s.startYear, startMonth: s.startMonth,
    /* months 是**这一局要走几个月**：没接后传就是 24，接了就是 24+N */
    n: Math.min(s.n, E.lastMonthOf(s)), months: E.lastMonthOf(s),
    mainMonths: E.MONTHS,
    phase: s.phase === 'extra' ? 'extra' : 'main',
    finished: s.n > E.lastMonthOf(s),
    city: s.city, nick: s.nick, status: s.status,
    currency: cur, currencyName: E.CN[cur],
    cash: s.cash, cashText: E.money(s.cash, cur),
    assets: s.assets.map(a => ({ ...a, worthText: E.money(a.worth, cur) })),
    debts: s.debts.map(d => ({ ...d, amountText: E.money(d.amount, cur) })),
    persona: s.persona || '',
    /* 这一局记着的事，整份发给界面——「不要丢失任何记忆」是要看得见的 */
    memo: s.memo || E.newMemo(),
    netWorth: E.netWorth(s), netWorthText: E.money(E.netWorth(s), cur),
    income: E.incomeOf(s.year, s.month),
    incomeText: E.money(E.incomeOf(s.year, s.month), cur),
    listLimit: E.LIST_LIMIT,
    options: s.options || [],
    recent: s.months.slice(-3).map(d => {
      const summary = d.summary || E.deriveSummary(d.story, '');
      const headline = E.deriveHeadline(d.headline, summary, '', d.story);
      return {
        ...d,
        headline,
        summary,
        assetsAdded: d.assetsAdded || [],
        image: (rid && imgUrlOf(rid, d.n)) || d.image || null,
      };
    }),
  };
}

/** 一局走过的每一个月，给结算页回看用 */
function monthList(s, runId) {
  /* 「走过的路」那一句只在回顾的时候给——玩的时候摆在旁边太乱（sway 2026-09-04）。
   * 结算页每个月折起来的那一行用它当摘要，一眼扫得完二十四个月。 */
  const rid = runId || s.id || '';
  const trail = new Map(((s.memo || {}).trail || []).map(t => [t.n, t]));
  return (s.months || []).map(d => {
    const t = trail.get(d.n);
    const say = t ? t.say : '';
    const summary = d.summary || E.deriveSummary(d.story, say);
    const headline = E.deriveHeadline(d.headline, summary, say, d.story);
    return {
      n: d.n, year: d.year, month: d.month,
      list: d.list, headline, summary, story: d.story, tally: d.tally,
      assetsAdded: d.assetsAdded || [],
      say, worth: t ? t.worth : '',
      refused: d.refused || [], overTop: !!d.overTop,
      moved: d.moved || null,
      worldTrace: d.worldTrace || null,
      image: (rid && imgUrlOf(rid, d.n)) || d.image || null,
    };
  });
}

/** 老存档（按天走的那一版）读不动，好好说一声，别抛异常 */
const isOldRun = s => !s || typeof s.n !== 'number' || !Array.isArray(s.months);
const OLD_SAY = '这条旧版记录无法继续，请重新开始一局。';

/* 名次。两年那一刻上总榜和年榜；接着走下去的那一段只上后传榜。 */
const mainRanks = r => ({
  rankWorld: DB.rankWorld(r.worldUsd), ofWorld: DB.doneCount(),
  rankYear: DB.rankInYear(r.year, r.yearEarned), ofYear: DB.doneInYear(r.year),
});
const extraRanks = r => ({ rankExtra: DB.rankExtra(r.worldUsd), ofExtra: DB.extraCount() });

/** 给一局的一段（两年那一段，或后传那一段）写一篇收梢。一段只写一次，写完存库里。
 *  结算页（POST /api/review）和榜上点进来的面板（GET /api/peek）都走这儿：
 *  谁先要，谁触发那一次调用，之后端的都是同一份。
 *  回 { review }；别人正在写就回 { writing: true }；这一段还没结账回 { error, code }。 */
async function writeReview(id, row, s, extra, req) {
  const have = extra ? row.extra_review : row.review;
  if (have) return { review: JSON.parse(have), cached: true };
  const rj = extra ? row.extra_result : row.result;
  if (!rj) return { error: '请先结算成绩，再生成总结', code: 400 };
  const lock = (extra ? 'revx:' : 'rev:') + id;
  if (busy.has(lock)) return { writing: true };
  busy.add(lock);
  try {
    const r = JSON.parse(rj);
    /* 两年那一篇只看前二十四个月——玩家要是已经接着往下走了，
     * 后面那些月份不该混进两年的收梢里。 */
    const src = (!extra && s.months.length > E.MONTHS) ? { ...s, months: s.months.slice(0, E.MONTHS) } : s;
    let rev;
    if (HAS_KEY && rateOk(clientIp(req)).ok) {
      try { rev = await SIM.runReview(src, r); }
      catch (err) {
        console.error('总评退回本地：', String(err.message).slice(0, 300));
        rev = SIM.reviewLocal(src, r); rev.local = true;
      }
    } else { rev = SIM.reviewLocal(src, r); rev.local = true; }
    DB.saveReview(id, JSON.stringify(rev), extra);
    return { review: rev };
  } finally { busy.delete(lock); }
}

/* ── 路由 ──────────────────────────────────────────── */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, {
    ok: true, ai: HAS_KEY, model: HAS_KEY ? SIM.MODEL : null,
    voice: VOICE.hasVoice(), voiceRealtime: VOICE.hasRealtime(),
    years: CATALOG.filter(y => y.ready).length, total: CATALOG.length,
    runs: DB.doneCount(),
  }),

  'POST /api/transcribe': async (req, res) =>
    VOICE.handleTranscribe(req, res, { DB, rateOk, clientIp, json, oops }),

  'POST /api/transcribe/refine': async (req, res) =>
    VOICE.handleRefine(req, res, { DB, rateOk, clientIp, readBody, json, oops }),

  'GET /api/years': async (req, res) => json(res, 200, { years: CATALOG }),

  'GET /api/year': async (req, res, q) => {
    const y = Number(q.y);
    const row = CATALOG.find(x => x.year === y);
    if (!row) return oops(res, 404, '没有这一年');
    const f = path.join(YEARS_DIR, `${y}.json`);
    if (!fs.existsSync(f)) return oops(res, 404, `${y} 年的背景资料暂未开放`);
    const card = JSON.parse(fs.readFileSync(f, 'utf8'));
    const months = [];
    for (let m = 1; m <= 12; m++) {
      months.push({
        month: m,
        currency: E.CN[E.currencyAt(y, m, 1)],
        income: E.incomeAtDay(y, m, 1),
        incomeText: E.money(E.incomeAtDay(y, m, 1), E.currencyAt(y, m, 1)),
        startCash: E.money(E.startingCash(y, m), E.currencyAt(y, m, 1)),
        events: (card.events || []).filter(e => e.month === m).map(e => e.text),
      });
    }
    const echoes = DB.yearEchoes(y, 12, { city: row.city }).traces;
    json(res, 200, { card, months, ceiling: row.ceiling, city: row.city, switch: row.switch, echoes });
  },

  'POST /api/run': async (req, res) => {
    const b = await readBody(req);
    const year = Number(b.year), month = Number(b.month);
    if (!CATALOG.some(x => x.year === year && x.ready)) return oops(res, 400, '这一年暂时无法开始游戏');
    if (!(month >= 1 && month <= 12)) return oops(res, 400, '月份要在 1 到 12 之间');
    /* 一局二十四个月，走到头不能超出 2025 年 12 月 */
    if (!E.startable(year, month)) return oops(res, 400, `从这个月开始不足 ${E.MONTHS} 个月。最晚可从 2024 年 1 月开始`);
    const nick = String(b.nick || '').trim().slice(0, 16) || '无名';
    /* 主角设定：玩家写的一句「他是个什么人」，50 个汉字封顶，明摆着的超人写法顶回去 */
    const per = E.checkPersona(b.persona);
    if (!per.ok) return json(res, 400, { error: per.say, count: per.n, limit: E.PERSONA_LIMIT });
    const s = E.newRun({ year, month, nick, persona: per.text });
    const echoes = DB.yearEchoes(year, month, { nick, city: s.city });
    s.options = SIM.optionsLocal(s, 0, echoes);
    const { id, token } = DB.createRun(s, nick, String(b.token || '').split(',')[0].trim());
    s.id = id;
    DB.saveRun(id, s);
    json(res, 200, { id, token, state: view(s, id), flavor: SIM.card(year).flavor, echoes: echoes.traces });
  },

  'POST /api/month': async (req, res) => {
    const b = await readBody(req);
    const chk = E.checkList(b.list);
    if (!chk.ok) return json(res, 400, { error: chk.say, count: chk.n, limit: E.LIST_LIMIT });

    /* 先抢锁，再读存档。反过来的话，两个请求可能都读到同一份旧存档，
     * 后写的把先写的盖掉——那个月白算了。 */
    const lockKey = String(b.id || '');
    if (busy.has(lockKey)) return oops(res, 409, '正在生成本月结果，请稍等');
    busy.add(lockKey);
    try {
      const found = DB.loadRun(lockKey, String(b.token || ''));
      if (!found) return oops(res, 404, '无法读取这条记录，请从原来使用的浏览器打开');
      const s = found.state;
      if (isOldRun(s)) return oops(res, 409, OLD_SAY);
      if (s.status !== 'playing' && s.status !== 'extra') return oops(res, 400, '本局已结算');
      if (s.n > E.lastMonthOf(s)) return oops(res, 400, `${E.lastMonthOf(s)} 个月已完成，可以查看成绩了`);
      return await runOneMonth(req, res, b, s);
    } finally { busy.delete(lockKey); }
  },

  /* 明天能走的哪几条路。平常是跟正文同一次调用带回来的，不额外花钱；
   * 这个口子只在头一天和玩家点「换三条」时走，会真调一次模型。 */
  'POST /api/options': async (req, res) => {
    const b = await readBody(req);
    const id = String(b.id || '');
    if (busy.has(id)) return oops(res, 409, '正在处理本月计划，请稍等');
    const found = DB.loadRun(id, String(b.token || ''));
    if (!found) return oops(res, 404, '无法读取这条记录，请从原来使用的浏览器打开');
    const s = found.state;
    if (isOldRun(s)) return oops(res, 409, OLD_SAY);
    if ((s.status !== 'playing' && s.status !== 'extra') || s.n > E.lastMonthOf(s)) return json(res, 200, { options: [], done: true });

    let out;
    /* 点一次换一份：没密钥的时候也得换得动，所以给本地那份加一个随机的引子 */
    const salt = Math.floor(Math.random() * 1e6);
    const echoes = DB.yearEchoes(s.year, s.month, { excludeRunId: id, nick: s.nick, city: s.city });
    if (HAS_KEY && rateOk(clientIp(req)).ok) out = await SIM.runOptions(s, { salt, echoes });
    else out = { options: SIM.optionsLocal(s, salt, echoes), local: true };
    s.options = E.cleanOptions(out.options);
    if (!s.options.length) s.options = SIM.optionsLocal(s, 0, echoes);
    DB.saveRun(id, s);
    json(res, 200, { options: s.options, local: !!out.local });
  },

  /* 结账。同一个口子管两种收梢：走完两年那一次（成绩上总榜、年榜，写完就冻住），
   * 和接着走下去之后那一次（成绩只上后传榜，一个字都不碰前面那份）。 */
  'POST /api/settle': async (req, res) => {
    const b = await readBody(req);
    const found = DB.loadRun(String(b.id || ''), String(b.token || ''));
    if (!found) return oops(res, 404, '找不到这一局');
    const s = found.state, row = found.row;
    if (isOldRun(s)) return oops(res, 409, OLD_SAY);
    const extra = s.phase === 'extra';
    const last = E.lastMonthOf(s);

    /* 结过的原样端回去。两年那一刻的成绩绝不重算——重算一次就等于没冻。 */
    if (!extra && row.status === 'done' && row.result) {
      const r0 = JSON.parse(row.result);
      const rev0 = row.review ? JSON.parse(row.review) : null;
      if (HAS_KEY && !finaleImgUrlOf(b.id, false)) ensureFinaleImage(b.id, s, r0, rev0, false).catch(() => {});
      return json(res, 200, {
        result: r0, already: true, ...mainRanks(r0), months: monthList(s, b.id),
        review: rev0, finaleImage: finaleImgUrlOf(b.id, false), extraRoom: E.extraRoom(s),
      });
    }
    if (extra && row.extra_status === 'done' && row.extra_result) {
      const r0 = JSON.parse(row.extra_result);
      const rev0 = row.extra_review ? JSON.parse(row.extra_review) : null;
      if (HAS_KEY && !finaleImgUrlOf(b.id, true)) ensureFinaleImage(b.id, s, r0, rev0, true).catch(() => {});
      return json(res, 200, {
        result: r0, already: true, phase: 'extra', ...extraRanks(r0), months: monthList(s, b.id),
        review: rev0, finaleImage: finaleImgUrlOf(b.id, true),
        main: row.result ? JSON.parse(row.result) : null,
      });
    }
    if (s.months.length < last) return oops(res, 400, `还差 ${last - s.months.length} 个月`);
    if (busy.has(String(b.id))) return oops(res, 409, '本月结果还在生成，请完成后再结算');

    const r = E.settle(s);
    r.endWorthText = E.money(r.endWorth, r.currency);
    r.currencyName = E.CN[r.currency];
    s.status = 'done';
    const traits = ((s.memo && s.memo.traits) || []).filter(t => !t.lost).map(t => t.what).slice(0, 2);
    if (traits.length || r.score >= 3) {
      const summary = traits.length
        ? `穿越者「${s.nick}」曾在${s.city}闯荡，留下「${traits.join('、')}」的传说`
        : `穿越者「${s.nick}」曾在${s.city}攒下普通人 ${Math.round(r.score)} 年的家业`;
      DB.addTrace(b.id, {
        year: s.startYear || s.year, month: s.startMonth || s.month, city: s.city, nick: s.nick,
        kind: 'deed', summary: summary.slice(0, 42), importance: r.score >= 8 ? 3 : 2,
      });
    }
    if (extra) {
      DB.finishExtra(b.id, s, r);
      if (HAS_KEY) ensureFinaleImage(b.id, s, r, null, true).catch(() => {});
      return json(res, 200, {
        result: r, phase: 'extra', ...extraRanks(r), months: monthList(s, b.id),
        finaleImage: finaleImgUrlOf(b.id, true),
        main: row.result ? JSON.parse(row.result) : null,      // 两年那一刻的成绩，对照着看
      });
    }
    const wrote = DB.finishRun(b.id, s, r);
    if (!wrote) {
      /* 冻结闸挡下了：库里已经有一份两年的成绩，端那一份出来 */
      const r0 = JSON.parse(DB.getRow(b.id).result);
      return json(res, 200, { result: r0, already: true, ...mainRanks(r0), months: monthList(s, b.id), finaleImage: finaleImgUrlOf(b.id, false) });
    }
    if (HAS_KEY) ensureFinaleImage(b.id, s, r, null, false).catch(() => {});
    json(res, 200, { result: r, ...mainRanks(r), months: monthList(s, b.id), finaleImage: finaleImgUrlOf(b.id, false), extraRoom: E.extraRoom(s) });
  },

  /* 接着走下去：两年结完账，最多再走五年。
   * 两年那一刻的成绩已经封在库里，这里只把存档接回「第 24 个月刚过完」的样子。 */
  'POST /api/extend': async (req, res) => {
    const b = await readBody(req);
    const found = DB.loadRun(String(b.id || ''), String(b.token || ''));
    if (!found) return oops(res, 404, '无法读取这条记录，请从原来使用的浏览器打开');
    const s = found.state;
    if (isOldRun(s)) return oops(res, 409, OLD_SAY);
    if (found.row.status !== 'done') return oops(res, 400, '先把前两年过完，才能接着往下走');
    if (s.phase === 'extra') return oops(res, 400, '这一局已经接着往下走过了');
    const r = E.reopen(s);
    if (!r.ok) return oops(res, 400, r.say);
    s.options = SIM.optionsLocal(s);        // 头一个月的三条路走本地那份，不额外花钱
    DB.startExtra(b.id, s, r.room);
    json(res, 200, {
      state: view(s), room: r.room, to: r.to,
      switched: (r.events || []).filter(Boolean).map(x => ({ say: x.say, before: E.money(x.before, x.from), after: E.money(x.after, x.cur) })),
    });
  },

  /* 收梢的那一篇总评。一局只写一次，写完存库里，再问端的是同一份。
   * 写的活在 writeReview 里，榜上点进来的面板（GET /api/peek）也走它。 */
  'POST /api/review': async (req, res) => {
    const b = await readBody(req);
    const found = DB.loadRun(String(b.id || ''), String(b.token || ''));
    if (!found) return oops(res, 404, '找不到这一局');
    const s = found.state, row = found.row;
    if (isOldRun(s)) return oops(res, 409, OLD_SAY);
    const out = await writeReview(String(b.id), row, s, !!b.extra, req);
    if (out.error) return oops(res, out.code, out.error);
    if (out.writing) return oops(res, 409, '正在写回顾总结，请稍等');
    json(res, 200, out);
  },

  /* 榜上点进来看的那一块：成绩单 + 收梢的总评，谁都看得到，不用 token（sway 2026-09-03 晚些时候：
   * 「排行榜每个人可以点击进去，看到 AI 总结的面板」）。
   * **不给清单、不给正文、不给他记着的人和事、不给「他是个什么人」**——那些是玩的人自己写的，
   * 只在 /api/detail 里、认得 token 才给（同一天早些时候定的）。收梢是记事人写的一篇话，
   * 是「总结」，不是「走过的路」。
   * 还没写过收梢的局，谁先点进来谁触发那一次写——写在后台，这边先把成绩端出去，
   * 回 writing:true 让前端过几秒再来问；写完存库里，往后端的都是同一份。 */
  'GET /api/peek': async (req, res, q) => {
    const id = String(q.id || '');
    const row = DB.getRow(id);
    if (!row) return oops(res, 404, '没有这一局');
    if (row.mode && row.mode !== 'months24') return oops(res, 409, '旧版记录暂不支持查看');
    if (row.status !== 'done' || !row.result) return oops(res, 403, '这一局还没走完，结算后才能查看成绩');
    let st = null;
    try { st = JSON.parse(row.state); } catch (e) {}
    if (!st || isOldRun(st)) return oops(res, 409, OLD_SAY);
    const result = JSON.parse(row.result);
    /* 自己的局：面板上多一颗「看每个月写了什么」，点过去走 /api/detail */
    const mine = !!(q.token && DB.loadRun(id, String(q.token)));
    const swallow = err => console.error('榜上要的收梢没写成：', String(err && err.message).slice(0, 200));
    const review = row.review ? JSON.parse(row.review) : null;
    if (!review) writeReview(id, row, st, false, req).catch(swallow);
    const xDone = row.extra_status === 'done' && !!row.extra_result;
    const extraReview = xDone && row.extra_review ? JSON.parse(row.extra_review) : null;
    if (xDone && !extraReview) writeReview(id, row, st, true, req).catch(swallow);
    json(res, 200, {
      id: row.id, nick: row.nick, year: row.year, month: row.month, city: st.city,
      created: row.created, updated: row.updated, mine,
      result, rank: mainRanks(result),
      review, writing: !review,
      finaleImage: finaleImgUrlOf(id, false),
      extraStatus: row.extra_status || null,
      extraTo: row.extra_months || 0,
      extraResult: xDone ? JSON.parse(row.extra_result) : null,
      extraReview, extraWriting: xDone && !extraReview,
      extraFinaleImage: xDone ? finaleImgUrlOf(id, true) : null,
      extraRank: row.extra_world_usd != null ? extraRanks({ worldUsd: row.extra_world_usd }) : null,
    });
  },

  /* 一局的详情：清单、二十四个月的正文、他记着的人和事、开局写的那句「他是个什么人」。
   * **只给开局的那个人看**（sway 2026-09-03）——具体怎么走的是他自己的事。
   * 认人靠开局发的那串 token，跟写这一局用的是同一串。
   * 别人从榜上点进来看的是 /api/peek：只有成绩和收梢，没有这些。 */
  'GET /api/detail': async (req, res, q) => {
    const id = String(q.id || '');
    const row = DB.getRow(id);
    if (!row) return oops(res, 404, '没有这一局');
    if (!DB.loadRun(id, String(q.token || ''))) return oops(res, 403, '每个月的打算与经历只有本人能看，排行榜可看成绩单与回顾');
    if (row.mode && row.mode !== 'months24') return oops(res, 409, '旧版记录暂不支持查看详情');
    if (row.status !== 'done' || !row.result) return oops(res, 403, '这一局还没走完，结算后才能查看成绩');
    let st = null;
    try { st = JSON.parse(row.state); } catch (e) {}
    if (!st || isOldRun(st)) return oops(res, 409, OLD_SAY);
    const result = JSON.parse(row.result);
    json(res, 200, {
      id: row.id, nick: row.nick, year: row.year, month: row.month, city: st.city,
      persona: st.persona || '', created: row.created, updated: row.updated,
      mainMonths: E.MONTHS,
      result, review: row.review ? JSON.parse(row.review) : null,
      finaleImage: finaleImgUrlOf(id, false),
      rank: mainRanks(result),
      /* 后传：接着走下去的那一段。extraStatus 是 playing 就是还在走。 */
      extraStatus: row.extra_status || null,
      extraTo: row.extra_months || 0,
      extraRoom: row.extra_status ? 0 : E.extraRoom(st),   // 还能往下走几个月
      extraResult: row.extra_result ? JSON.parse(row.extra_result) : null,
      extraReview: row.extra_review ? JSON.parse(row.extra_review) : null,
      extraFinaleImage: row.extra_status === 'done' ? finaleImgUrlOf(id, true) : null,
      extraRank: row.extra_world_usd != null ? extraRanks({ worldUsd: row.extra_world_usd }) : null,
      months: monthList(st, id),
      memo: st.memo || null,
    });
  },

  'GET /api/story': async (req, res, q) => {
    const found = DB.loadRun(String(q.id || ''), String(q.token || ''));
    if (!found) return oops(res, 404, '找不到这一局');
    const st = found.state;
    if (isOldRun(st)) return oops(res, 409, OLD_SAY);
    json(res, 200, { months: monthList(st, q.id), nick: st.nick, year: st.startYear, month: st.startMonth });
  },

  'GET /api/month-image': async (req, res, q) => {
    const hit = findImgFile(q.id, q.n);
    if (!hit) return oops(res, 404, '插画尚未生成');
    fs.stat(hit.file, (err, st) => {
      if (err || !st.isFile()) return oops(res, 404, '插画尚未生成');
      const mime = hit.ext === 'png' ? 'image/png' : hit.ext === 'webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, {
        'content-type': mime,
        'content-length': st.size,
        'cache-control': 'public, max-age=86400',
      });
      fs.createReadStream(hit.file).pipe(res);
    });
  },

  'POST /api/month-image': async (req, res) => {
    const b = await readBody(req);
    const id = String(b.id || '');
    const n = Number(b.n);
    const found = DB.loadRun(id, String(b.token || ''));
    if (!found) return oops(res, 404, '找不到这一局');
    const existing = imgUrlOf(id, n);
    if (existing) return json(res, 200, { ok: true, status: 'ready', image: existing });
    if (!HAS_KEY) return json(res, 200, { ok: false, status: 'unavailable' });
    const s = found.state;
    const played = (s.months || []).find(d => Number(d.n) === n);
    if (!played) return oops(res, 404, '还没有这一个月的记录');
    const url = await ensureMonthImage(id, s, played);
    if (!url) return json(res, 200, { ok: false, status: 'failed' });
    played.image = url;
    DB.saveRun(id, s);
    return json(res, 200, { ok: true, status: 'ready', image: url });
  },

  'GET /api/finale-image': async (req, res, q) => {
    const hit = findFinaleImgFile(q.id, q.extra === '1' || q.extra === 'true');
    if (!hit) return oops(res, 404, '插画尚未生成');
    fs.stat(hit.file, (err, st) => {
      if (err || !st.isFile()) return oops(res, 404, '插画尚未生成');
      const mime = hit.ext === 'png' ? 'image/png' : hit.ext === 'webp' ? 'image/webp' : 'image/jpeg';
      res.writeHead(200, {
        'content-type': mime,
        'content-length': st.size,
        'cache-control': 'public, max-age=86400',
      });
      fs.createReadStream(hit.file).pipe(res);
    });
  },

  'POST /api/finale-image': async (req, res) => {
    const b = await readBody(req);
    const id = String(b.id || '');
    const extra = !!b.extra;
    const row = DB.getRow(id);
    if (!row || row.status !== 'done') return oops(res, 404, '找不到这一局');
    const existing = finaleImgUrlOf(id, extra);
    if (existing) return json(res, 200, { ok: true, status: 'ready', image: existing });
    if (!HAS_KEY) return json(res, 200, { ok: false, status: 'unavailable' });
    let s = null, r = null, rev = null;
    try { s = JSON.parse(row.state); } catch (e) {}
    try { r = JSON.parse(extra ? row.extra_result : row.result); } catch (e) {}
    try { rev = JSON.parse(extra ? row.extra_review : row.review); } catch (e) {}
    if (!s || !r) return oops(res, 400, '尚未完成结算');
    const url = await ensureFinaleImage(id, s, r, rev, extra);
    if (!url) return json(res, 200, { ok: false, status: 'failed' });
    return json(res, 200, { ok: true, status: 'ready', image: url });
  },

  /* 榜分两层：给了 year 就是那一年的榜（只跟同年的人比，按当年那种钱净赚多少排），
   * 不给就是总榜（按「折成今天的美元」排）。 */
  'GET /api/board': async (req, res, q) => {
    const limit = Math.min(Number(q.limit) || 50, 200);
    const parseTitle = raw => { try { return raw ? JSON.parse(raw).title || null : null; } catch (e) { return null; } };
    /* 后传榜：走完两年又接着走下去的那些局，按整局折成今天的美元排。
     * 跟总榜是两张榜——多走五年的人不该跟只走两年的人比。 */
    if (q.scope === 'extra') {
      const rows = DB.boardExtra(limit);
      return json(res, 200, {
        scope: 'extra', year: null, total: DB.extraCount(), yearsWithRuns: DB.yearsWithRuns(),
        /* 榜上发 id 只为了点进 /api/peek 看成绩和收梢；拿着 id 能试的别的口子
         * （detail / load / story / review / month）全都要 token，对不上一律 403 或 404。 */
        rows: rows.map((r, i) => ({
          rank: i + 1, id: r.id, nick: r.nick, year: r.year, month: r.month,
          months: E.MONTHS + (r.extra_months || 0), extraMonths: r.extra_months || 0,
          yearEarned: r.extra_year_earned, yearEarnedText: r.extra_result?.yearEarnedText || null,
          worldUsd: r.extra_world_usd, worldUsdText: E.fmtUsd(r.extra_world_usd || 0),
          score: r.extra_score, scoreText: E.fmtScore(r.extra_score),
          city: r.extra_result?.city,
          title: parseTitle(r.extra_review),
          image: finaleImgUrlOf(r.id, true) || finaleImgUrlOf(r.id, false),
          at: r.updated,
        })),
      });
    }
    const year = q.year ? Number(q.year) : null;
    if (year && !(year >= 1926 && year <= 2025)) return oops(res, 400, '年份要在 1926 到 2025 之间');
    const rows = DB.board(limit, year);
    json(res, 200, {
      scope: year ? 'year' : 'world',
      year,
      total: year ? DB.doneInYear(year) : DB.doneCount(),
      yearsWithRuns: DB.yearsWithRuns(),
      rows: rows.map((r, i) => ({
        rank: i + 1, id: r.id, nick: r.nick, year: r.year, month: r.month,
        yearEarned: r.year_earned,
        yearEarnedText: r.result?.yearEarnedText || null,
        worldUsd: r.world_usd,
        worldUsdText: E.fmtUsd(r.world_usd || 0),
        score: r.score, scoreText: E.fmtScore(r.score),
        city: r.result?.city,
        title: parseTitle(r.review),
        image: finaleImgUrlOf(r.id, false),
        at: r.updated,
      })),
    });
  },

  'GET /api/mine': async (req, res, q) => {
    const raw = q.tokens || q.token;
    if (!raw) return json(res, 200, { rows: [] });
    const rows = DB.myRuns(String(raw)).map(r => {
      const isEx = r.extra_status === 'done';
      let image = finaleImgUrlOf(r.id, isEx) || finaleImgUrlOf(r.id, false);
      if (!image) {
        const cap = Math.max(24, Number(r.month) || 0, Number(r.extra_months) || 0) + 2;
        for (let m = cap; m >= 1; m--) {
          const u = imgUrlOf(r.id, m);
          if (u) { image = u; break; }
        }
      }
      let title = '';
      for (const s of [r.extra_review, r.review]) {
        if (!s) continue;
        try {
          const rv = JSON.parse(s);
          if (rv && rv.title) { title = String(rv.title); break; }
        } catch {}
      }
      const yInfo = E.yearOf(r.year);
      let city = (yInfo && yInfo.city) || '';
      let stepN = null, totalMonths = E.MONTHS;
      if (r.status !== 'done' || r.extra_status === 'playing') {
        try {
          const full = DB.getRow(r.id);
          const st = full && full.state ? JSON.parse(full.state) : null;
          if (st) {
            if (st.city) city = st.city;
            totalMonths = E.lastMonthOf(st);
            stepN = Math.min(Number(st.n) || 1, totalMonths);
          }
        } catch {}
      }
      return { ...r, city, stepN, totalMonths, image, title };
    });
    json(res, 200, { rows });
  },

  'GET /api/load': async (req, res, q) => {
    const found = DB.loadRun(String(q.id || ''), String(q.token || ''));
    if (!found) return oops(res, 404, '找不到这一局');
    if (isOldRun(found.state)) return oops(res, 409, OLD_SAY);
    /* 正在走后传的局，库里的 status 是 done（两年那份成绩冻在那儿），
     * 可它还在过日子——对界面来说就是 playing，不然接着走下去的局刷新一下就回不去了。 */
    const st = found.state;
    const out = { state: view(st, q.id), status: st.status === 'extra' ? 'playing' : found.row.status };
    if (st.status !== 'extra' && found.row.status === 'done' && found.row.result) out.result = JSON.parse(found.row.result);
    json(res, 200, out);
  },
};

/* 一次 SSE：正文边写边发，写完把这个月的账和状态一次性发过去。
 * 不用 EventSource（那只能 GET，清单得走 POST），前端拿 fetch 读流。 */
function openStream(res) {
  /* 不要自己写 connection 头，交给 Node 定；写死 keep-alive 会跟它的分块编码打架 */
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no',           // 前面要是有反代，别让它攒着不发
  });
  res.write(': 开始\n\n');
  let dead = false;
  res.on('close', () => { dead = true; });
  return {
    get dead() { return dead; },
    send(event, data) { if (!dead) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); },
    end() { if (!dead) res.end(); },
  };
}

/* 真正算一个月的那一段，从路由里拆出来，好让上面那把锁包住它 */
async function runOneMonth(req, res, b, s) {
  try {
    return await runOneMonthInner(req, res, b, s);
  } catch (err) {
    console.error('过一个月出错', err);
    if (res.headersSent) {
      /* 流已经开了：好好收个尾，别把连接吊死 */
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: '本月结果生成失败，计划已保留，请重试。' })}\n\n`); } catch (e) {}
      try { res.end(); } catch (e) {}
      return;
    }
    return oops(res, 500, '暂时无法完成操作，请稍后重试。');
  }
}

async function runOneMonthInner(req, res, b, s) {
    const ip = clientIp(req);
    /* 没密钥的时候正文是本地模板，一瞬间就出来，没什么可流的 */
    const sse = (b.stream && HAS_KEY) ? openStream(res) : null;
    const echoes = DB.yearEchoes(s.year, s.month, { excludeRunId: b.id, nick: s.nick, city: s.city });

    let out, usedLocal = false;
    if (HAS_KEY) {
      const r = rateOk(ip);
      if (!r.ok) {
        /* 撞了限流不让游戏坏掉——退回本地演算，并如实告诉玩家为什么 */
        out = SIM.runMonthLocal(s, b.list, { echoes }); usedLocal = true;
        out.why = r.why === 'ip' ? '你这十分钟问得太密了，这个月先由本地算' : '这会儿全站都很忙，这个月先由本地算';
      } else {
        try {
          out = await SIM.runMonth(s, b.list, sse ? {
            onField: (field, t) => {
              if (field === 'headline' || field === 'summary') sse.send(field, { t });
            },
            echoes,
          } : { echoes });
        } catch (err) {
          /* 原话只进服务端日志。它是服务商回的英文 JSON，直接印到页面上，
             玩家读到的是「HTTP 402 {"error":{"message":"This request would exceed
             your available credits…」——既看不懂，又把内部情况摊开了。 */
          console.error('这个月退回本地演算：', String(err.message).slice(0, 300));
          out = SIM.runMonthLocal(s, b.list, { echoes }); usedLocal = true;
          out.why = '模型这会儿叫不动，这个月先由本地算';
          /* 流到一半断了：让前端把已经吐出去的半截正文擦掉，换成兜底的那份，
             不然屏幕上会剩着一段没头没尾的话。 */
          if (sse) sse.send('redo', {});
        }
      }
    } else { out = SIM.runMonthLocal(s, b.list, { echoes }); usedLocal = true; }

    const curNow = E.currencyOf(s.year, s.month);
    /* 顶回去的理由只能是「那一年没有这东西」。模型偶尔会替玩家把事否掉
     * （「属于犯罪活动」「风险大于收益」），那种拒绝在这儿扔掉——
     * 留着它，下个月的提示词还会拿它当「上个月顶回去过」接着顶。 */
    out.delta.refused = E.cleanRefused(out.delta.refused, E.scanAnachronism(b.list, s.year));
    const res1 = E.applyMonth(s, out.delta);
    /* 他这个月要是走了（换城、出海），人跟着搬——年卡照旧用原来那座城的。 */
    const moved = E.applyMove(s, out.delta.moveTo);
    /* 这个月有几成是他自己写的、撞没撞上奇遇。跟 sim.buildUser 里算的是同一个函数、
     * 同一份存档（还没 push、还没 advanceTo），所以结果一定一样；记下来是为了回头能查。 */
    const sd = E.serendipity(s, b.list);
    const bt = E.speculation(s, b.list);
    /* 把这个月压成的那几行并进记忆。**要在 advanceTo 之前**——
     * 记的是刚过完的这个月，挪完日历再记就串到下个月头上了。 */
    const tally = E.tallyLine(res1.entries, curNow);
    const memoAdd = E.applyMemo(s, out.delta, { n: s.n, year: s.year, month: s.month, tally });
    const traceCand = E.extractWorldTrace(s, { year: s.year, month: s.month, list: b.list }, out.delta, res1);
    const traceSaved = traceCand && DB.addTrace(b.id, traceCand) ? traceCand : null;

    const assetsAdded = (out.delta.assetsAdd || [])
      .slice(0, 8)
      .map(a => String((a && a.name) || '').trim())
      .filter(Boolean);
    const memoLine = (out.delta.memo && out.delta.memo.line) || '';
    const summaryText = String(out.delta.summary || '').trim() || E.deriveSummary(out.delta.story, memoLine);
    const headlineText = E.deriveHeadline(out.delta.headline, summaryText, memoLine, out.delta.story);

    s.months.push({
      n: s.n, year: s.year, month: s.month, list: String(b.list).slice(0, 2000),
      headline: headlineText,
      summary: summaryText,
      story: out.delta.story, tally, entries: res1.entries,
      assetsAdded,
      refused: out.delta.refused || [], local: usedLocal,
      /* 这个月挣得超过了「那一年做到头的一个月」。以前这里是削顶的记号，
       * 2026-09-03 不削了，留着它只为在界面上给这个月一句话。 */
      overTop: res1.gained > E.monthTop(s.year, s.month),
      moved: moved || null,
      worldTrace: traceSaved || null,
      luck: sd.luck, fresh: Math.round(sd.fresh * 100) / 100,
      /* 押了本钱的月份：赢没赢、几倍、押的是哪一段行情——回头查「投机是不是又一直亏」用 */
      bet: bt.bet ? { win: bt.win, mult: bt.mult, market: bt.market ? bt.market.what : null, align: bt.align } : null,
      /* 进了货却没记下东西——下个月的提示词里要拿它提醒模型自己补上 */
      missedGoods: res1.missedGoods || null,
    });
    /* 走完最后一个月就不再往前挪日历了：结算要按第 24 个月那个月份算。
     * closeOut 只做两件事：把 n 记成 MONTHS+1、最后一个月要是换币的月份就补折一次
     * （不折的话，正好停在 1949 年 5 月的人能攥着一堆该作废的钱走人）。 */
    const switched = s.n < E.lastMonthOf(s) ? E.advanceTo(s, s.n + 1) : [E.closeOut(s)].filter(Boolean);
    /* 三条路跟正文是同一次调用回来的：不多花一次钱，也不让他多等。
     * 模型没给或者给了空的，就退回照年卡拼的那份——界面上永远有三条。
     * 放在推进之后：这三条说的是下个月，本地那份也该照下个月的年份拼。 */
    const nextEchoes = DB.yearEchoes(s.year, s.month, { excludeRunId: b.id, nick: s.nick, city: s.city });
    s.options = E.cleanOptions(out.delta.options);
    if (!s.options.length) s.options = SIM.optionsLocal(s, 0, nextEchoes);
    s.id = b.id;
    DB.saveRun(b.id, s);

    const played = s.months[s.months.length - 1];
    /* 当月结算后立刻在后台启动插画生成（约 5 秒），不阻塞文字返回 */
    if (HAS_KEY) ensureMonthImage(b.id, s, played).catch(() => {});

    const payload = {
      /* 刚过完的是哪一个月——前端拿它写正文的小标题，别自己去猜 */
      at: { n: played.n, year: played.year, month: played.month },
      list: played.list,
      headline: played.headline,
      summary: played.summary,
      story: out.delta.story,
      assetsAdded: played.assetsAdded || [],
      image: imgUrlOf(b.id, played.n) || null,
      imagePending: HAS_KEY && !imgUrlOf(b.id, played.n),
      tally,
      /* 整张账单共用一个单位（`tallyLine` 里那句话也是同一把尺子），
       * 不然同一屏上会挤着「−1800 法币」「−80.00 法币」「1.54 亿法币」三种写法。 */
      entries: (() => {
        const sum = res1.entries.reduce((t, e) => t + e.amount, 0);
        const unit = E.unitOf([...res1.entries.map(e => e.amount), sum]);
        return res1.entries.map(e => ({ what: e.what, amount: e.amount, text: E.moneyIn(e.amount, unit, curNow) }));
      })(),
      refused: out.delta.refused || [],
      moved: moved || null,
      worldTrace: traceSaved || null,
      overTop: played.overTop,
      overspent: res1.overspent > 0 ? E.money(res1.overspent, curNow) : null,
      /* 换之前那种钱的名字，直接用 applySwitch 返回的 from。
       * 原来是照 cur 猜的（`cur==='GOLDYUAN' ? 'FABI' : 'RMB1'`），
       * 1935 年印成「18.29 人民币（旧）换成了 18.29 法币」（该是银元），
       * 1949 年印成「人民币（旧）换成了人民币（旧）」。 */
      switched: switched.map(x => ({ say: x.say, before: E.money(x.before, x.from), after: E.money(x.after, x.cur) })),
      memoAdd,
      local: usedLocal, why: out.why || null,
      options: s.options,
      state: view(s, b.id),
      done: s.n > E.lastMonthOf(s),
    };
    if (sse) { sse.send('done', payload); sse.end(); }
    else json(res, 200, payload);
  }


const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  const key = `${req.method} ${u.pathname}`;
  const fn = routes[key];
  if (!fn) {
    if (req.method === 'GET') return serveStatic(req, res, u.pathname);
    return oops(res, 404, '请求的功能不存在');
  }
  try { await fn(req, res, u.query); }
  catch (err) {
    console.error(key, err);
    if (!res.headersSent) oops(res, 500, '暂时无法完成操作，请稍后重试。');
  }
});

server.on('upgrade', (req, socket, head) => {
  if (VOICE.matchesAsrUpgrade(req.url)) {
    VOICE.handleAsrUpgrade(req, socket, head, { DB, rateOk, clientIp });
    return;
  }
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

server.listen(PORT, '127.0.0.1', () => {
  const ready = CATALOG.filter(y => y.ready).length;
  console.log(`《这一百年》起在 http://127.0.0.1:${PORT}`);
  console.log(`年卡 ${ready}/${CATALOG.length} 张${ready < CATALOG.length ? '（没写好的年份进不去）' : ''}，模型 ${HAS_KEY ? SIM.MODEL : '没有密钥，走本地兜底'}，语音 ${VOICE.hasRealtime() ? '实时流式' : VOICE.hasVoice() ? '整段转写' : '未开启'}`);
  console.log(`存档 ${DB.FILE}`);
});
