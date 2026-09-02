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
      const ctype = String(r.headers['content-type'] || '');
      const chunks = []; let n = 0;
      r.on('data', d => { n += d.length; if (n < 4000000) chunks.push(d); });  // 4MB：统计局公报页 1.2–2.5MB，「人民生活」那一章在靠后位置，800KB 会把它截掉、把好出处误判成「数字对不上」
      r.on('end', () => {
        const buf = Buffer.concat(chunks);
        /* PDF / 图片 / 压缩包读不出文字层，只能确认「这个文件真的在」，
         * 不能拿它判数字对不对——不然一整批 PDF 出处会被冤枉成编造。 */
        const opaque = /pdf|image\/|octet-stream|zip/i.test(ctype) || buf.slice(0, 5).toString() === '%PDF-';
        resolve({ ok: true, body: buf.toString('utf8'), opaque, ctype });
      });
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

/** **这条才是真正管用的**：把 cite 里出现的数字挑出来，一个个去页面里找。
 *
 *  「打得开 + 沾边」拦不住最阴的那种错——**真出处 + 真数字里掺一句编的**。
 *  实测抓到过一条：某张卡的 money 出处引了张忠民那篇文章，
 *  20.65 / 13.92 / 9.30 / 226718 / 72962 / 136665 / 17091 / 37.83 八个数全对，
 *  末尾却多一句「1930 年复旦大学调查上海 54000 名人力车夫」——
 *  那篇文章里根本没有「复旦」也没有「54000」。
 *
 *  只看四位以上的数（年份除外）：三位以下的数太容易在页面上撞见。
 *  找不到的比例超过一半才报——页面可能换了排版、数字带千分位、或者是 PDF。 */
/* cite 里自己写明了「这个数是估的/折的/没核到」，就不拿它跟页面对——
 * 那不是编造，那是老实交代。实测 1957 那条写着「长期流传的全国统销价，
 * 没有找到原始价目表核对，属存疑」，照样被判「数字对不上」，等于罚老实人。
 * 要抓的是**说得斩钉截铁、页面上却没有**的那种。 */
const HEDGE = /(存疑|估算|估值|折算|推算|外推|未核|没核|未能核|没有找到|查不到|长期流传|不是原始|非直接|按.{0,8}推|另据.{0,6}志|外省)/;

function numbersMissing(body, s) {
  if (HEDGE.test(String(s.cite))) return { hedged: true };
  const text = String(body).replace(/<[^>]*>/g, ' ').replace(/,/g, '');
  const nums = [...new Set((String(s.cite).match(/\d+(?:\.\d+)?/g) || [])
    .filter(n => {
      const v = Number(n);
      if (n.includes('.')) return n.replace('.', '').length >= 3;   // 20.65 这种算
      if (v >= 1900 && v <= 2030) return false;                     // 年份不算
      return n.length >= 4;                                         // 54000、226718 这种算
    }))];
  if (nums.length < 2) return null;                                  // 数太少，判不了
  const missing = nums.filter(n => !text.includes(n));
  return { nums, missing };
}

(async () => {
  console.log(`年卡里共 ${all.length} 条带 URL 的出处，抽 ${pick.length} 条真去访问一遍\n`);
  let dead = 0, unrelated = 0, fine = 0, fabricated = 0, opaque = 0, hedged = 0;
  const notes = [];
  for (let i = 0; i < pick.length; i += 5) {
    const batch = pick.slice(i, i + 5);
    const res = await Promise.all(batch.map(s => fetchUrl(s.url)));
    for (const [k, r] of res.entries()) {
      const s = batch[k];
      if (!r.ok) { dead++; notes.push(`  ✗ ${s.year} [${s.for}] ${r.why} — ${s.url.slice(0, 78)}`); }
      else if (r.opaque) { opaque++; fine++; }
      else if (!looksRelated(r.body, s)) { unrelated++; notes.push(`  ? ${s.year} [${s.for}] 打得开，但页面里跟这条出处对不上 — ${s.url.slice(0, 70)}`); }
      else {
        const nm = numbersMissing(r.body, s);
        if (nm && nm.hedged) { hedged++; fine++; }
        else if (nm && nm.missing.length && nm.missing.length / nm.nums.length > 0.5) {
          fabricated++;
          notes.push(`  ！${s.year} [${s.for}] 页面打得开、也对得上，但 cite 里 ${nm.nums.length} 个数有 ${nm.missing.length} 个在页面上找不到：${nm.missing.slice(0, 6).join('、')}`);
        } else fine++;
      }
    }
    process.stdout.write(`\r  查过 ${Math.min(i + 5, pick.length)}/${pick.length}`);
  }
  console.log('\n');
  for (const n of notes) console.log(n);
  const bad = dead + unrelated;
  const rate = bad / pick.length;
  console.log(`\n打得开且数字对得上 ${fine} 条（其中 ${opaque} 条是 PDF/图片核不了数字，${hedged} 条 cite 里自己写明是估算/折算，不参与比对）`);
  console.log(`打不开 ${dead} 条 · 内容对不上 ${unrelated} 条 · **数字对不上 ${fabricated} 条** · 失效率 ${(rate * 100).toFixed(0)}%（上限 ${BAD_RATE * 100}%）`);
  let failed = false;
  if (rate > BAD_RATE) {
    console.log('\n没过。失效率这么高，多半不是链接烂了，是有人在编出处——挑几条人工看一眼。');
    failed = true;
  }
  if (fabricated) {
    console.log(`\n没过。有 ${fabricated} 条「！」——页面打得开，但 cite 里报的数在页面上找不到。`);
    console.log('这是最该管的一种：真出处 + 真数字里掺一句编的。逐条人工核，把编的那半句删掉。');
    failed = true;
  }
  if (failed) process.exit(1);
  console.log('\n过了');
})();
