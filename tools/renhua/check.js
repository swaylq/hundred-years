'use strict';
/* 界面上写死的文案，说人话的闸。
 *
 *   node tools/renhua/check.js
 *
 * 只管界面上我自己写的那些字：禁用词一条都不许中，难读分不许超过 4.5。
 * **模型实时生成的正文不在这里管**——sway 定了「实时那些不管」，
 * 那一层的规矩写进 sim.js 的系统提示词里，不做事后过滤，也不做离线抽样。
 *
 * 难读分沿用《木兰令》那套：平均句长 + 一句里套几个逗号 + 最长一串不打标点。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const SAMPLE = arg('sample', 50);
const SHOW = arg('show', 0);

/* ── 禁用词：三类 ─────────────────────────────────── */
const BANS = [
  ['职场黑话', /(赋能|抓手|闭环|生态位|底层逻辑|方法论|颗粒度|拉通|复盘|沉淀|心智|护城河|降维|风口|红利|对齐颗粒)/],
  ['机器腔', /(值得注意的是|综上所述|归根结底|不可否认|在某种意义上|某种程度上|与此同时|总而言之|不是[^，。；]{1,14}，而是|真正[可怕要紧重要][的]?是|首先.{0,30}其次.{0,30}最后)/],
  ['游戏腔', /(玩家|数值|加成|触发条件|解锁|副本|难度系数|存档|本回合|属性值|收益率|投入产出比)/],
  ['说教', /(这告诉我们|由此可见|从中可以看出|人生就是|命运的齿轮|时代的洪流|历史的车轮|充满了挑战与机遇)/],
  ['公文腔', /(有了显著提高|取得了长足|发挥了重要作用|为.{2,8}奠定了基础|具有重要意义)/],

  /* 下面四类是 2026-09-03 从「系统白话」skill 抄下来的。
   * skill 只在有人想起来调它的时候生效，词表每次收工都跑——真正留得住的是这里。 */
  /* 「拟人历史」这一类先不开闸，等 sway 拍板。开了之后全项目只有一条会红：
   * 首页横幅「看那时候的中国怎么回你」。那句是这个游戏唯一一句让它听起来
   * 不像记账软件的话，改不改是产品取舍，不是文案问题——不该由脚本替人决定。
   * 定了就把下面这行的注释去掉，同时把横幅改掉，两件事必须一起做。 */
  // ['拟人历史', /((这一?年|那一?年|那时候|当年|时代|命运|历史)[的]?(中国|世道|城)?[^。；，]{0,6}(回你|回应你|眷顾|考验你|拥抱你|对你说|等着你))/],
  ['说明书腔', /(基于[^，。]{2,12}进行|该操作|用户需|系统将|策略性|进行[了]?[一二三]?[次项]?(操作|处理|计算))/],
  ['假诗意', /(落进历史|听见回响|与时代对话|时代的回响|历史的尘埃|命运的褶皱|见证.{0,4}命运)/],
  ['露实现', /(大模型|提示词|本地兜底|由本地算|认领的串|模拟器|JSON|按天走的老规矩)/],
];

/* ── 难读分 ───────────────────────────────────────── */
function hard(s) {
  const t = String(s || '').replace(/\s+/g, '');
  if (!t) return 0;
  const sents = t.split(/[。！？；]/).filter(x => x.length);
  if (!sents.length) return 0;
  const avgLen = sents.reduce((a, b) => a + b.length, 0) / sents.length;
  const commas = sents.reduce((a, b) => a + (b.match(/[，、]/g) || []).length, 0) / sents.length;
  const runs = t.split(/[，。！？；、：]/).map(x => x.length);
  const longest = Math.max(0, ...runs);
  return avgLen / 14 + commas / 2.2 + longest / 26;
}

function scan(text, where) {
  const out = [];
  for (const [kind, re] of BANS) {
    const m = String(text).match(re);
    if (m) out.push({ where, kind, word: m[0] });
  }
  return out;
}

/* ── 界面上写死的字 ─────────────────────────────────
 * 只挑「真的是给人读的句子」：去掉标签和 ${} 插值之后，
 * 汉字得占六成以上。不然会把代码片段和 CSS 选择器当成文案，
 * 难读分立刻飙到两百，这道闸就白设了。 */
function proseOnly(raw) {
  const s = String(raw)
    .replace(/\$\{[^}]*\}/g, '　')          // 模板插值
    .replace(/<[^>]*>/g, ' ')               // 标签
    .replace(/&#\d+;|&[a-z]+;/g, ' ')       // 实体
    .trim();
  const solid = s.replace(/\s/g, '');
  if (solid.length < 4) return null;
  const han = (solid.match(/[一-鿿]/g) || []).length;
  if (han / solid.length < 0.6) return null;
  if (/[{}<>]|=>|function|const |return /.test(s)) return null;
  return s;
}

function uiStrings() {
  const out = [];
  const add = (where, raw) => { const t = proseOnly(raw); if (t) out.push({ where, text: t }); };

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  for (const m of html.matchAll(/>([^<>]{4,})</g)) add('index.html', m[1]);
  for (const m of html.matchAll(/(?:placeholder|title)="([^"]{4,})"/g)) add('index.html', m[1].replace(/&#10;/g, ' '));

  /* 前端和服务端的中文串：只取单引号里的，模板串里混着代码，靠 proseOnly 兜住 */
  for (const f of ['public/app.js', 'server.js', 'engine.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const noComment = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
    for (const m of noComment.matchAll(/'([^'\\\n]{4,})'/g)) add(path.basename(f), m[1]);
    for (const m of noComment.matchAll(/`([^`]{4,})`/g)) add(path.basename(f), m[1]);
  }
  /* 同一句话可能在几处出现，去个重 */
  const seen = new Set();
  return out.filter(x => { const k = x.text; if (seen.has(k)) return false; seen.add(k); return true; });
}

/* ── 跑 ───────────────────────────────────────────── */
let bad = 0;


console.log('一、界面上写死的文案');
const ui = uiStrings();
const uiHits = ui.flatMap(u => scan(u.text, u.where).map(h => ({ ...h, text: u.text })));
if (uiHits.length) {
  bad += uiHits.length;
  for (const h of uiHits) console.log(`  x ${h.where} [${h.kind}] 「${h.word}」 —— ${h.text.slice(0, 46)}`);
} else {
  console.log(`  · ${ui.length} 条，一条不合格的都没有`);
}
const uiScored = ui.map(u => ({ ...u, h: hard(u.text) })).sort((a, b) => b.h - a.h);
if (uiScored.length) {
  console.log(`  · 难读分中位 ${uiScored[Math.floor(uiScored.length / 2)].h.toFixed(2)}，最高 ${uiScored[0].h.toFixed(2)}（${uiScored[0].where}：${uiScored[0].text.slice(0, 34)}）`);
  const tooHard = uiScored.filter(u => u.h > 4.5);
  if (tooHard.length) {
    bad += tooHard.length;
    for (const u of tooHard) console.log(`  x ${u.where} 难读分 ${u.h.toFixed(2)}：${u.text.slice(0, 60)}`);
  }
}

console.log(bad ? `\n没过，${bad} 条` : '\n全过');
process.exit(bad ? 1 : 0);
