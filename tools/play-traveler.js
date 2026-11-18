'use strict';
/* 拟真穿越者端到端试玩一局（24 个月）：
 * 走真实 HTTP + SSE 接口（选年 → 开局 → 24 个月手写打算与同行穿越者互动 → 结算 → 判词 → 收官画卷），
 * 输出结构化诊断摘要到 logs/play-traveler-latest.json，供巡检与游戏性调优使用。
 *
 *   secret exec OPENROUTER_API_KEY -- node tools/play-traveler.js [--year 1948] [--month 3]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const E = require('../engine.js');
const SIM = require('../sim.js');
const OR = require('./or.js');

const BASE = process.env.HY_URL || 'http://127.0.0.1:8801';
const LOG_DIR = path.join(__dirname, '..', 'logs');
const BOT_TOKEN = process.env.HY_BOT_TOKEN || 'hy-traveler-chronicle-bot';

const TRAVELER_POOL = [
  { nick: '周怀瑾', persona: '算盘极精的旧账房，懂点看相风水，说话留三分余地', style: '商贾与玄门兼修' },
  { nick: '宋惊蛰', persona: '码头出身的硬朗拳师，讲义气，爱打抱不平也肯冒险跑单帮', style: '江湖武侠与跑船倒货' },
  { nick: '陈望舒', persona: '心思活络的钟表匠学徒，手巧心细，对奇物秘术格外好奇', style: '手艺经营与炼金奇物' },
  { nick: '唐白露', persona: '见多识广的茶楼女掌柜，擅长察言观色、攒局拉线与倒腾紧俏货', style: '人脉攒局与囤货投机' },
  { nick: '许寒山', persona: '半路出家的游方郎中，认得草药古方，总想寻访隐世练气门径', style: '医药行商与浅层求道' },
  { nick: '孟南枝', persona: '胆大心细的报馆跑街记者，消息灵通，敢押大行情也爱结交异客', style: '情报套利与同行结盟' },
  { nick: '韩折柳', persona: '走南闯北的古玩牙人，眼毒嘴甜，爱逛夜市鬼市淘换真家伙', style: '古玩捡漏与百鬼夜行' },
  { nick: '冯观潮', persona: '留洋回来的机械技师，信奉实业兴家，喜欢跟同道合伙办厂开铺', style: '实业改良与商路竞合' },
  { nick: '顾听松', persona: '沉稳持重的粮行买手，擅长看天时物价囤实货躲风浪', style: '民生实货与稳健扩张' },
  { nick: '苏枕河', persona: '性子洒脱的戏班琴师，三教九流都熟，爱跟同乡穿越者对暗号切磋', style: '市井交游与奇闻探秘' },
  { nick: '谢临风', persona: '脑子活泛的个体倒爷，哪儿有风口就往哪儿钻，敢拼敢闯', style: '风口套利与跨城闯荡' },
  { nick: '叶知秋', persona: '旧书肆修书匠，熟读医卜星相残卷，待人温和却极有主见', style: '旧籍寻踪与同道共研' },
];

const arg = (k, d = null) => {
  const i = process.argv.indexOf('--' + k);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

function httpJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, BASE);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: data
        ? { 'content-type': 'application/json', 'content-length': data.length }
        : {},
    }, res => {
      const parts = [];
      res.on('data', d => parts.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(parts).toString('utf8');
        let j = null;
        try { j = JSON.parse(raw); } catch (e) {}
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} ${urlPath}: ${(j && j.error) || raw.slice(0, 160)}`));
        }
        resolve(j);
      });
    });
    req.on('error', reject);
    req.setTimeout(95000, () => req.destroy(new Error(`timeout ${urlPath}`)));
    if (data) req.write(data);
    req.end();
  });
}

function postMonthStream(body) {
  return new Promise((resolve, reject) => {
    const u = new URL('/api/month', BASE);
    const data = Buffer.from(JSON.stringify({ ...body, stream: true, skipAutoImage: true }));
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length },
    }, res => {
      const ct = String(res.headers['content-type'] || '');
      if (res.statusCode >= 400 || !ct.includes('text/event-stream')) {
        const parts = [];
        res.on('data', d => parts.push(d));
        res.on('end', () => {
          const raw = Buffer.concat(parts).toString('utf8');
          let j = null; try { j = JSON.parse(raw); } catch (e) {}
          if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${(j && j.error) || raw.slice(0, 160)}`));
          else resolve({ donePayload: j, streamedHeadline: '', streamedSummary: '', redos: 0 });
        });
        return;
      }
      const { StringDecoder } = require('string_decoder');
      const dec = new StringDecoder('utf8');
      let buf = '', streamedHeadline = '', streamedSummary = '', redos = 0, donePayload = null, streamErr = null;
      res.on('data', chunk => {
        buf += dec.write(chunk);
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const blk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const em = /^event: (.+)$/m.exec(blk);
          const dm = /^data: (.*)$/m.exec(blk);
          if (!em || !dm) continue;
          let payload;
          try { payload = JSON.parse(dm[1]); } catch (e) { continue; }
          if (em[1] === 'headline') streamedHeadline += payload.t || '';
          else if (em[1] === 'summary') streamedSummary += payload.t || '';
          else if (em[1] === 'redo') { streamedHeadline = ''; streamedSummary = ''; redos++; }
          else if (em[1] === 'error') streamErr = payload.error || 'stream error';
          else if (em[1] === 'done') donePayload = payload;
        }
      });
      res.on('end', () => {
        if (streamErr) return reject(new Error(streamErr));
        if (!donePayload) return reject(new Error('SSE ended without done event'));
        resolve({ donePayload, streamedHeadline, streamedSummary, redos });
      });
    });
    req.on('error', reject);
    req.setTimeout(105000, () => req.destroy(new Error('SSE /api/month timeout')));
    req.write(data);
    req.end();
  });
}

async function chooseTargetYearMonth() {
  const { years } = await httpJson('GET', '/api/years');
  const board = await httpJson('GET', '/api/board?limit=50');
  const startable = years.filter(y => y.ready && (y.startMonths || []).length > 0);
  const argY = Number(arg('year'));
  const argM = Number(arg('month'));
  if (argY) {
    const hit = startable.find(x => x.year === argY);
    if (!hit) throw new Error(`年份 ${argY} 不可开局`);
    const m = argM && hit.startMonths.includes(argM) ? argM : hit.startMonths[Math.floor(Math.random() * hit.startMonths.length)];
    return { year: hit.year, month: m };
  }

  /* 兼顾两类场景：一半概率跳进已有穿越者足迹的年份形成跨局联动，一半概率开拓空白年代 */
  const activeYears = (board.yearsWithRuns || [])
    .map(r => r.year)
    .filter(y => startable.some(s => s.year === y || s.year === y - 1));
  if (activeYears.length > 0 && Math.random() < 0.45) {
    const baseY = activeYears[Math.floor(Math.random() * activeYears.length)];
    const cand = startable.filter(s => Math.abs(s.year - baseY) <= 1);
    const pick = cand[Math.floor(Math.random() * cand.length)];
    const m = pick.startMonths[Math.floor(Math.random() * pick.startMonths.length)];
    return { year: pick.year, month: m };
  }

  const eras = [
    startable.filter(y => y.year >= 1926 && y.year <= 1949),
    startable.filter(y => y.year >= 1950 && y.year <= 1977),
    startable.filter(y => y.year >= 1978 && y.year <= 2005),
    startable.filter(y => y.year >= 2006 && y.year <= 2024),
  ].filter(g => g.length > 0);
  const grp = eras[Math.floor(Math.random() * eras.length)];
  const pick = grp[Math.floor(Math.random() * grp.length)];
  const m = pick.startMonths[Math.floor(Math.random() * pick.startMonths.length)];
  return { year: pick.year, month: m };
}

async function draftPlayerPlan(st, yearCard, monthIdx) {
  const fellows = st.fellows || [];
  const bonds = st.travelerBonds || [];
  const wantTravelerFocus = monthIdx === 2 || monthIdx === 6 || monthIdx === 12 || monthIdx === 18 || (bonds.length > 0 && monthIdx % 5 === 0);
  const sys = `你是正在玩《这一百年》的真人穿越者「${st.nick}」。
人物底子：${st.persona}（偏好方向：${st.style || '顺势而为'}）。
你要写出这一个月（第 ${st.n}/24 个月，${st.year} 年 ${st.month} 月，${st.city}）的具体行动打算，字数控制在 45 到 85 个汉字之间。
要求：
1. 像真正在那个年代闯荡的聪明现代人一样写具体行动：去哪儿、找谁、做什么买卖或学什么手艺、怎么应对当月时局或通胀换币。
2. 严禁写 ${st.year} 年还不存在的现代科技物件（禁用：${((yearCard.tech && yearCard.tech['没有']) || []).slice(0, 8).join('、')}），也不要写毁天灭地/殖民星球等离谱神通。
3. ${wantTravelerFocus
    ? `**本月重点与同行穿越者互动**：主动点名城里的穿越者（${[...bonds.map(b => `${b.nick}[已${b.rel}]`), ...fellows.map(f => `${f.nick}[${f.stance || f.tag}]`)].slice(0, 3).join('、')}），去跟对方对暗号试探、合伙做一笔买卖、互通情报、切磋较量、或加深结拜/知己/姻缘关系，同时兼顾手头营生！`
    : `围绕既有家业与人脉稳步升级，若顺手也可跟同城穿越者或老熟人配合。`}
只输出行动打算正文（纯文本一段话），不要加标题、引号或解释。`;

  const recentTxt = (st.recent || []).slice(-2).map(d =>
    `第${d.n}月(${d.year}.${d.month})：${d.summary || ''}（${d.tally || ''}）`
  ).join('\n') || '刚落地第 1 个月';
  const user = `当前现金：${st.cashText}，总家底：${st.netWorthText}（普通人年收入 ${st.incomeText}）。
手里家当：${(st.assets || []).map(a => `${a.name}(${a.worthText})`).join('、') || '无'}。
已攒本事/产业：${((st.memo && st.memo.traits) || []).filter(t => !t.lost).map(t => t.what).join('、') || '暂无'}。
同年活跃穿越者：${fellows.map(f => `${f.nick}（${f.desc || f.summary}）`).join('；') || '暂无'}。
当年谋生门路：${(yearCard.money || []).map(m => m.way).join('；')}。
近期经历：\n${recentTxt}
参考路子：${(st.options || []).map(o => o.what).join(' / ')}。
请写出第 ${st.n} 个月的具体打算：`;

  const raw = await OR.call(SIM.MODEL, sys, user, { maxTokens: 260, temperature: 0.88, tries: 2 });
  const clean = String(raw || '').replace(/^["'「『]+|["'」』]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
  return clean || ((st.options && st.options[0] && st.options[0].what) || `在${st.city}打听行情，先找份稳当差事站稳脚跟`);
}

(async () => {
  const t0 = Date.now();
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const target = await chooseTargetYearMonth();
  const yearData = await httpJson('GET', `/api/year?y=${target.year}`);
  const existingNames = new Set((yearData.fellows || []).map(f => f.nick));
  const candidates = TRAVELER_POOL.filter(p => !existingNames.has(p.nick));
  const pickedProfile = candidates[Math.floor(Math.random() * candidates.length)] || TRAVELER_POOL[0];

  console.log(`=== 开启试玩：${target.year} 年 ${target.month} 月 · ${yearData.city} ===`);
  console.log(`穿越者：${pickedProfile.nick} ｜ 底子：${pickedProfile.persona}`);
  console.log(`同年同行：${(yearData.fellows || []).map(f => `${f.nick}[${f.stance || f.tag}]`).join('、') || '无'}`);

  const started = await httpJson('POST', '/api/run', {
    year: target.year,
    month: target.month,
    nick: pickedProfile.nick,
    persona: pickedProfile.persona,
    token: BOT_TOKEN,
  });

  const runId = started.id;
  const token = started.token;
  let state = { ...started.state, style: pickedProfile.style };
  const monthLogs = [];
  const cards = new Map([[target.year, yearData.card]]);

  for (let i = 1; i <= E.MONTHS; i++) {
    if (!cards.has(state.year)) {
      const yd = await httpJson('GET', `/api/year?y=${state.year}`);
      cards.set(state.year, yd.card);
    }
    const plan = await draftPlayerPlan(state, cards.get(state.year), i);
    const { donePayload: d, redos } = await postMonthStream({ id: runId, token, list: plan });
    state = { ...d.state, style: pickedProfile.style };

    const rec = {
      n: d.at.n,
      ym: `${d.at.year}.${String(d.at.month).padStart(2, '0')}`,
      plan,
      headline: d.headline,
      summary: d.summary,
      storyLen: E.countHan(String(d.story || '').replace(/\*\*/g, '')),
      summaryLen: E.countHan(String(d.summary || '').replace(/\*\*/g, '')),
      hasHighlight: /\*\*[^*]+\*\*/.test(String(d.story || '')) && /\*\*[^*]+\*\*/.test(String(d.summary || '')),
      local: !!d.local,
      why: d.why || null,
      redos,
      tally: d.tally,
      netWorthText: d.state.netWorthText,
      assetsAdded: d.assetsAdded || [],
      refused: d.refused || [],
      moved: d.moved || null,
      bond: d.bond || null,
      worldTrace: d.worldTrace || null,
      options: (d.options || []).map(o => o.what),
    };
    monthLogs.push(rec);
    const bondTag = rec.bond ? ` [同行:${rec.bond.with}·${rec.bond.rel}]` : '';
    const locTag = rec.local ? ` [LOCAL:${rec.why || 'fallback'}]` : '';
    console.log(`  M${String(rec.n).padStart(2, '0')} ${rec.ym} | ${rec.headline} | 家底 ${rec.netWorthText}${bondTag}${locTag}`);
  }

  const settled = await httpJson('POST', '/api/settle', { id: runId, token });
  const revOut = await httpJson('POST', '/api/review', { id: runId, token, extra: false });
  const finImg = await httpJson('POST', '/api/finale-image', { id: runId, extra: false });

  const diagnostics = {
    runId,
    nick: pickedProfile.nick,
    persona: pickedProfile.persona,
    startYm: `${target.year}-${String(target.month).padStart(2, '0')}`,
    endYm: `${settled.result.endYear}-${String(settled.result.endMonth).padStart(2, '0')}`,
    city: settled.result.city,
    score: Number(settled.result.score.toFixed(2)),
    scoreText: settled.result.scoreText,
    yearEarnedText: settled.result.yearEarnedText,
    worldUsd: Math.round(settled.result.worldUsd),
    worldUsdText: settled.result.worldUsdText,
    rankWorld: settled.rankWorld,
    ofWorld: settled.ofWorld,
    reviewTitle: revOut.review && revOut.review.title,
    became: revOut.review && revOut.review.became,
    finaleImage: finImg && finImg.image,
    elapsedSec: Math.round((Date.now() - t0) / 1000),
    localFallbackCount: monthLogs.filter(m => m.local).length,
    streamRedoCount: monthLogs.reduce((a, m) => a + m.redos, 0),
    bondsFormed: monthLogs.filter(m => m.bond).map(m => ({ n: m.n, ym: m.ym, ...m.bond })),
    worldTracesLeft: monthLogs.filter(m => m.worldTrace).map(m => ({ n: m.n, ym: m.ym, summary: m.worldTrace.summary })),
    refusedMonths: monthLogs.filter(m => m.refused.length > 0).map(m => ({ n: m.n, refused: m.refused })),
    travelerOptionMonths: (() => {
      const tNames = [...new Set([
        ...(yearData.fellows || []).map(f => f.nick),
        ...(state.fellows || []).map(f => f.nick),
        ...(state.travelerBonds || []).map(b => b.nick),
        ...monthLogs.filter(m => m.bond && m.bond.with).map(m => m.bond.with),
      ].filter(Boolean))];
      return monthLogs.filter(m => m.options.some(o =>
        /穿越者|暗号|同城|同道/.test(o) || tNames.some(nm => o.includes(nm))
      )).length;
    })(),
    missingHighlightMonths: monthLogs.filter(m => !m.hasHighlight).map(m => m.n),
    storyLenRange: [Math.min(...monthLogs.map(m => m.storyLen)), Math.max(...monthLogs.map(m => m.storyLen))],
    summaryLenRange: [Math.min(...monthLogs.map(m => m.summaryLen)), Math.max(...monthLogs.map(m => m.summaryLen))],
    spendReport: OR.report(),
  };

  const fullReport = { diagnostics, review: revOut.review, result: settled.result, months: monthLogs };
  fs.writeFileSync(path.join(LOG_DIR, `play-traveler-${runId}.json`), JSON.stringify(fullReport, null, 2));
  fs.writeFileSync(path.join(LOG_DIR, 'play-traveler-latest.json'), JSON.stringify(fullReport, null, 2));

  console.log('\n=== DIAGNOSTICS ===');
  console.log(JSON.stringify(diagnostics, null, 2));
})();
