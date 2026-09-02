'use strict';
/* 抽查年卡上的出处是不是真的。
 *
 *   node tools/check-sources.js --sample 20 [--year 1937] [--all]
 *
 * 硬闸只能查「有没有出处、够不够具体」，查不了「是不是真的」。
 * 这个脚本随机抽带 URL 的出处**真的去访问一遍**：
 *   · 打不开（404 / DNS 不存在 / 超时）→ 记一笔
 *   · 打得开但页面里一个相关的词都找不到 → 记一笔「对不上」
 *
 * 判据不是「一条都不许失效」——真实的链接会烂。判据是**捏造的会成批露馅**：
 * 随手编的 URL 多半整批打不开，或者打开了是毫不相干的页面。
 * 所以看的是**比例**，默认失效率超过 35% 就算没过。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'years');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : d; };
const SAMPLE = Number(arg('sample', 20));
const ONLY = arg('year') ? Number(arg('year')) : null;
const ALL = !!arg('all');
const BAD_RATE = 0.35;

/* ── 收集所有带 URL 的出处 ─────────────────────────── */
const all = [];
for (const f of fs.readdirSync(DIR).filter(x => /^\d{4}\.json$/.test(x))) {
  const y = Number(f.slice(0, 4));
  if (ONLY && y !== ONLY) continue;
  let c;
  try { c = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { continue; }
  for (const s of (c.sources || [])) {
    if (s && s.url && /^https?:\/\//.test(s.url)) all.push({ year: y, ...s });
  }
}
if (!all.length) { console.log('年卡里一条带 URL 的出处都没有'); process.exit(1); }

/* 均匀抽，别只抽头几年 */
let pick = all;
if (!ALL && all.length > SAMPLE) {
  const step = all.length / SAMPLE;
  pick = Array.from({ length: SAMPLE }, (_, i) => all[Math.floor(i * step)]);
}

/* ── 访问 ──────────────────────────────────────────── */
function fetchUrl(u, redirects = 0) {
  return new Promise(resolve => {
    let mod;
    try { mod = new URL(u).protocol === 'http:' ? http : https; } catch (e) { return resolve({ ok: false, why: 'URL 本身不合法' }); }
    const req = mod.get(u, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; hundred-years-source-check/1)', 'accept-language': 'zh-CN,zh;q=0.9' },
      timeout: 20000,
    }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects < 4) {
        r.resume();
        return resolve(fetchUrl(new URL(r.headers.location, u).href, redirects + 1));
      }
      if (r.statusCode !== 200) { r.resume(); return resolve({ ok: false, why: `HTTP ${r.statusCode}` }); }
      const chunks = []; let n = 0;
      r.on('data', d => { n += d.length; if (n < 800000) chunks.push(d); });
      r.on('end', () => resolve({ ok: true, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', e => resolve({ ok: false, why: String(e.code || e.message).slice(0, 40) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, why: '超时' }); });
  });
}

/** 页面里有没有跟这条出处沾边的东西：年份，或者 cite 里那几个实词 */
function looksRelated(body, s) {
  const text = String(body).replace(/<[^>]*>/g, ' ');
  if (text.includes(String(s.year))) return true;
  const words = String(s.cite).match(/[一-鿿]{2,}|[A-Za-z]{4,}/g) || [];
  return words.slice(0, 8).some(w => text.includes(w));
}

(async () => {
  console.log(`年卡里共 ${all.length} 条带 URL 的出处，抽 ${pick.length} 条真去访问一遍\n`);
  let dead = 0, unrelated = 0, fine = 0;
  const notes = [];
  for (let i = 0; i < pick.length; i += 5) {
    const batch = pick.slice(i, i + 5);
    const res = await Promise.all(batch.map(s => fetchUrl(s.url)));
    for (const [k, r] of res.entries()) {
      const s = batch[k];
      if (!r.ok) { dead++; notes.push(`  ✗ ${s.year} [${s.for}] ${r.why} — ${s.url.slice(0, 78)}`); }
      else if (!looksRelated(r.body, s)) { unrelated++; notes.push(`  ? ${s.year} [${s.for}] 打得开，但页面里跟这条出处对不上 — ${s.url.slice(0, 70)}`); }
      else fine++;
    }
    process.stdout.write(`\r  查过 ${Math.min(i + 5, pick.length)}/${pick.length}`);
  }
  console.log('\n');
  for (const n of notes) console.log(n);
  const bad = dead + unrelated;
  const rate = bad / pick.length;
  console.log(`\n打得开且对得上 ${fine} 条 · 打不开 ${dead} 条 · 对不上 ${unrelated} 条 · 失效率 ${(rate * 100).toFixed(0)}%（上限 ${BAD_RATE * 100}%）`);
  if (rate > BAD_RATE) {
    console.log('\n没过。失效率这么高，多半不是链接烂了，是有人在编出处——挑几条人工看一眼。');
    process.exit(1);
  }
  console.log('\n过了');
})();
