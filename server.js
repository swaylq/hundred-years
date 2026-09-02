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

const PORT = Number(process.env.HY_PORT || 8801);
const PUBLIC = path.join(__dirname, 'public');
const HAS_KEY = !!process.env.OPENROUTER_API_KEY;

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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(PUBLIC, '.' + rel);
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) return oops(res, 403, '不许');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return oops(res, 404, '没有这个页面');
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': ext === '.html' ? 'no-cache' : 'max-age=60, must-revalidate',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ── 给前端的存档视图 ──────────────────────────────── */
function view(s) {
  const cur = E.currencyOf(s.year, s.month);
  return {
    /* year/month 是**走到哪个月**，startYear/startMonth 才是开局那个月 */
    year: s.year, month: s.month,
    startYear: s.startYear, startMonth: s.startMonth,
    n: Math.min(s.n, E.MONTHS), months: E.MONTHS,
    finished: s.n > E.MONTHS,
    city: s.city, nick: s.nick, status: s.status,
    currency: cur, currencyName: E.CN[cur],
    cash: s.cash, cashText: E.money(s.cash, cur),
    assets: s.assets.map(a => ({ ...a, worthText: E.money(a.worth, cur) })),
    debts: s.debts.map(d => ({ ...d, amountText: E.money(d.amount, cur) })),
    standing: s.standing,
    netWorth: E.netWorth(s), netWorthText: E.money(E.netWorth(s), cur),
    income: E.incomeOf(s.year, s.month),
    incomeText: E.money(E.incomeOf(s.year, s.month), cur),
    listLimit: E.LIST_LIMIT,
    options: s.options || [],
    recent: s.months.slice(-3),
  };
}

/** 一局走过的每一个月，给结算页回看用 */
function monthList(s) {
  return (s.months || []).map(d => ({
    n: d.n, year: d.year, month: d.month,
    list: d.list, story: d.story, tally: d.tally,
    refused: d.refused || [], capped: !!d.capped,
  }));
}

/** 老存档（按天走的那一版）读不动，好好说一声，别抛异常 */
const isOldRun = s => !s || typeof s.n !== 'number' || !Array.isArray(s.months);
const OLD_SAY = '这一局是按天走的老规矩存的，新规矩一个月一步，接不上了。开一局新的吧。';

/* ── 路由 ──────────────────────────────────────────── */
const routes = {
  'GET /api/health': async (req, res) => json(res, 200, {
    ok: true, ai: HAS_KEY, model: HAS_KEY ? SIM.MODEL : null,
    years: CATALOG.filter(y => y.ready).length, total: CATALOG.length,
    runs: DB.doneCount(),
  }),

  'GET /api/years': async (req, res) => json(res, 200, { years: CATALOG }),

  'GET /api/year': async (req, res, q) => {
    const y = Number(q.y);
    const row = CATALOG.find(x => x.year === y);
    if (!row) return oops(res, 404, '没有这一年');
    const f = path.join(YEARS_DIR, `${y}.json`);
    if (!fs.existsSync(f)) return oops(res, 404, `${y} 年的背景还没写好`);
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
    json(res, 200, { card, months, ceiling: row.ceiling, city: row.city, switch: row.switch });
  },

  'POST /api/run': async (req, res) => {
    const b = await readBody(req);
    const year = Number(b.year), month = Number(b.month);
    if (!CATALOG.some(x => x.year === year && x.ready)) return oops(res, 400, '这一年还开不了');
    if (!(month >= 1 && month <= 12)) return oops(res, 400, '月份要在 1 到 12 之间');
    /* 一局二十四个月，走到头不能超出 2025 年 12 月 */
    if (!E.startable(year, month)) return oops(res, 400, `从这个月起走不满 ${E.MONTHS} 个月——最晚只能从 2024 年 1 月开局`);
    const nick = String(b.nick || '').trim().slice(0, 16) || '无名';
    const s = E.newRun({ year, month, nick });
    s.options = SIM.optionsLocal(s);
    const { id, token } = DB.createRun(s, nick);
    json(res, 200, { id, token, state: view(s), flavor: SIM.card(year).flavor });
  },

  'POST /api/month': async (req, res) => {
    const b = await readBody(req);
    const chk = E.checkList(b.list);
    if (!chk.ok) return json(res, 400, { error: chk.say, count: chk.n, limit: E.LIST_LIMIT });

    /* 先抢锁，再读存档。反过来的话，两个请求可能都读到同一份旧存档，
     * 后写的把先写的盖掉——那个月白算了。 */
    const lockKey = String(b.id || '');
    if (busy.has(lockKey)) return oops(res, 409, '这个月正在算，等它出来再点');
    busy.add(lockKey);
    try {
      const found = DB.loadRun(lockKey, String(b.token || ''));
      if (!found) return oops(res, 404, '找不到这一局，或者认领的串对不上');
      const s = found.state;
      if (isOldRun(s)) return oops(res, 409, OLD_SAY);
      if (s.status !== 'playing') return oops(res, 400, '这一局已经结了');
      if (s.n > E.MONTHS) return oops(res, 400, `${E.MONTHS} 个月走完了，去结算吧`);
      return await runOneMonth(req, res, b, s);
    } finally { busy.delete(lockKey); }
  },

  /* 明天能走的哪几条路。平常是跟正文同一次调用带回来的，不额外花钱；
   * 这个口子只在头一天和玩家点「换三条」时走，会真调一次模型。 */
  'POST /api/options': async (req, res) => {
    const b = await readBody(req);
    const id = String(b.id || '');
    if (busy.has(id)) return oops(res, 409, '这一天正在算，等它出来再说');
    const found = DB.loadRun(id, String(b.token || ''));
    if (!found) return oops(res, 404, '找不到这一局，或者认领的串对不上');
    const s = found.state;
    if (isOldRun(s)) return oops(res, 409, OLD_SAY);
    if (s.status !== 'playing' || s.n > E.MONTHS) return json(res, 200, { options: [], done: true });

    let out;
    /* 点一次换一份：没密钥的时候也得换得动，所以给本地那份加一个随机的引子 */
    const salt = Math.floor(Math.random() * 1e6);
    if (HAS_KEY && rateOk(clientIp(req)).ok) out = await SIM.runOptions(s, { salt });
    else out = { options: SIM.optionsLocal(s, salt), local: true };
    s.options = E.cleanOptions(out.options);
    if (!s.options.length) s.options = SIM.optionsLocal(s);
    DB.saveRun(id, s);
    json(res, 200, { options: s.options, local: !!out.local });
  },

  'POST /api/settle': async (req, res) => {
    const b = await readBody(req);
    const found = DB.loadRun(String(b.id || ''), String(b.token || ''));
    if (!found) return oops(res, 404, '找不到这一局');
    const s = found.state;
    if (s.status === 'done') return json(res, 200, { result: JSON.parse(found.row.result), already: true, months: monthList(s) });
    if (isOldRun(s)) return oops(res, 409, OLD_SAY);
    if (s.months.length < E.MONTHS) return oops(res, 400, `还差 ${E.MONTHS - s.months.length} 个月`);
    if (busy.has(String(b.id))) return oops(res, 409, '还有一个月在算，等它出来再结');
    const r = E.settle(s);
    r.endWorthText = E.money(r.endWorth, r.currency);
    r.currencyName = E.CN[r.currency];
    s.status = 'done';
    DB.finishRun(b.id, s, r);
    json(res, 200, {
      result: r,
      rankWorld: DB.rankWorld(r.worldUsd), ofWorld: DB.doneCount(),
      rankYear: DB.rankInYear(r.year, r.yearEarned), ofYear: DB.doneInYear(r.year),
      months: monthList(s),
    });
  },

  'GET /api/story': async (req, res, q) => {
    const found = DB.loadRun(String(q.id || ''), String(q.token || ''));
    if (!found) return oops(res, 404, '找不到这一局');
    const st = found.state;
    if (isOldRun(st)) return oops(res, 409, OLD_SAY);
    json(res, 200, { months: monthList(st), nick: st.nick, year: st.startYear, month: st.startMonth });
  },

  /* 榜分两层：给了 year 就是那一年的榜（只跟同年的人比，按当年那种钱净赚多少排），
   * 不给就是总榜（按「折成今天的美元」排）。 */
  'GET /api/board': async (req, res, q) => {
    const year = q.year ? Number(q.year) : null;
    if (year && !(year >= 1926 && year <= 2025)) return oops(res, 400, '年份要在 1926 到 2025 之间');
    const rows = DB.board(Math.min(Number(q.limit) || 50, 200), year);
    json(res, 200, {
      scope: year ? 'year' : 'world',
      year,
      total: year ? DB.doneInYear(year) : DB.doneCount(),
      yearsWithRuns: DB.yearsWithRuns(),
      rows: rows.map((r, i) => ({
        rank: i + 1, nick: r.nick, year: r.year, month: r.month,
        yearEarned: r.year_earned,
        yearEarnedText: r.result?.yearEarnedText || null,
        worldUsd: r.world_usd,
        worldUsdText: E.fmtUsd(r.world_usd || 0),
        score: r.score, scoreText: E.fmtScore(r.score),
        city: r.result?.city, ceiling: r.result?.ceiling,
        capped: !!r.result?.cappedTotal,
        at: r.updated,
      })),
    });
  },

  'GET /api/mine': async (req, res, q) => {
    if (!q.token) return json(res, 200, { rows: [] });
    json(res, 200, { rows: DB.myRuns(String(q.token)) });
  },

  'GET /api/load': async (req, res, q) => {
    const found = DB.loadRun(String(q.id || ''), String(q.token || ''));
    if (!found) return oops(res, 404, '找不到这一局');
    if (isOldRun(found.state)) return oops(res, 409, OLD_SAY);
    const out = { state: view(found.state), status: found.row.status };
    if (found.row.status === 'done' && found.row.result) out.result = JSON.parse(found.row.result);
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
      try { res.write(`event: error\ndata: ${JSON.stringify({ error: String(err.message).slice(0, 160) })}\n\n`); } catch (e) {}
      try { res.end(); } catch (e) {}
      return;
    }
    return oops(res, 500, String(err.message).slice(0, 160));
  }
}

async function runOneMonthInner(req, res, b, s) {
    const ip = clientIp(req);
    /* 没密钥的时候正文是本地模板，一瞬间就出来，没什么可流的 */
    const sse = (b.stream && HAS_KEY) ? openStream(res) : null;

    let out, usedLocal = false;
    if (HAS_KEY) {
      const r = rateOk(ip);
      if (!r.ok) {
        /* 撞了限流不让游戏坏掉——退回本地演算，并如实告诉玩家为什么 */
        out = SIM.runMonthLocal(s, b.list); usedLocal = true;
        out.why = r.why === 'ip' ? '你这十分钟问得太密了，这个月先由本地算' : '这会儿全站都很忙，这个月先由本地算';
      } else {
        try {
          out = await SIM.runMonth(s, b.list, sse ? { onStory: t => sse.send('story', { t }) } : {});
        } catch (err) {
          out = SIM.runMonthLocal(s, b.list); usedLocal = true; out.why = String(err.message).slice(0, 120);
          /* 流到一半断了：让前端把已经吐出去的半截正文擦掉，换成兜底的那份，
             不然屏幕上会剩着一段没头没尾的话。 */
          if (sse) sse.send('redo', {});
        }
      }
    } else { out = SIM.runMonthLocal(s, b.list); usedLocal = true; }

    const curNow = E.currencyOf(s.year, s.month);
    const res1 = E.applyMonth(s, out.delta);
    const tally = E.tallyLine(res1.entries, curNow);
    s.months.push({
      n: s.n, year: s.year, month: s.month, list: String(b.list).slice(0, 2000),
      story: out.delta.story, tally, entries: res1.entries,
      refused: out.delta.refused || [], capped: res1.capped, local: usedLocal,
    });
    /* 走完最后一个月就不再往前挪日历了：结算要按第 24 个月那个月份算。
     * 只把 n 记成 MONTHS+1，界面据此显示「走完了」。 */
    const switched = s.n < E.MONTHS ? E.advanceTo(s, s.n + 1) : (s.n = E.MONTHS + 1, []);
    /* 三条路跟正文是同一次调用回来的：不多花一次钱，也不让他多等。
     * 模型没给或者给了空的，就退回照年卡拼的那份——界面上永远有三条。
     * 放在推进之后：这三条说的是下个月，本地那份也该照下个月的年份拼。 */
    s.options = E.cleanOptions(out.delta.options);
    if (!s.options.length) s.options = SIM.optionsLocal(s);
    DB.saveRun(b.id, s);

    const played = s.months[s.months.length - 1];
    const payload = {
      /* 刚过完的是哪一个月——前端拿它写正文的小标题，别自己去猜 */
      at: { n: played.n, year: played.year, month: played.month },
      story: out.delta.story,
      tally,
      entries: res1.entries.map(e => ({ what: e.what, amount: e.amount, text: E.money(e.amount, curNow) })),
      refused: out.delta.refused || [],
      capped: res1.capped,
      overspent: res1.overspent > 0 ? E.money(res1.overspent, curNow) : null,
      /* 换之前那种钱的名字，直接用 applySwitch 返回的 from。
       * 原来是照 cur 猜的（`cur==='GOLDYUAN' ? 'FABI' : 'RMB1'`），
       * 1935 年印成「18.29 人民币（旧）换成了 18.29 法币」（该是银元），
       * 1949 年印成「人民币（旧）换成了人民币（旧）」。 */
      switched: switched.map(x => ({ say: x.say, before: E.money(x.before, x.from), after: E.money(x.after, x.cur) })),
      local: usedLocal, why: out.why || null,
      options: s.options,
      state: view(s),
      done: s.n > E.MONTHS,
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
    return oops(res, 404, '没这个口子');
  }
  try { await fn(req, res, u.query); }
  catch (err) {
    console.error(key, err);
    if (!res.headersSent) oops(res, 500, String(err.message).slice(0, 200));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const ready = CATALOG.filter(y => y.ready).length;
  console.log(`《这一百年》起在 http://127.0.0.1:${PORT}`);
  console.log(`年卡 ${ready}/${CATALOG.length} 张${ready < CATALOG.length ? '（没写好的年份进不去）' : ''}，模型 ${HAS_KEY ? SIM.MODEL : '没有密钥，走本地兜底'}`);
  console.log(`存档 ${DB.FILE}`);
});
