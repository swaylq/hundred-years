'use strict';
/* 《这一百年》的前端。没有打包器，一个文件。 */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MONTHS = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];

const TOKEN_KEY = 'hy.token';
const RUN_KEY = 'hy.run';
let token = localStorage.getItem(TOKEN_KEY) || '';
let years = [], picked = null, pickedMonth = null, run = null;

/* ── 网络 ──────────────────────────────── */
async function api(path, opts) {
  let r;
  try { r = await fetch(path, opts); }
  catch (e) { throw new Error('连接失败，请检查网络后重试。'); }
  let j = null;
  try { j = await r.json(); } catch (e) { /* 下面按状态码报 */ }
  if (!r.ok) throw Object.assign(new Error((j && j.error) || `请求失败，请稍后重试（${r.status}）`), { body: j });
  return j;
}
const post = (p, b) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

let toastT = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3600);
}

/* ── 换屏 ──────────────────────────────── */
function go(name) {
  $$('.screen').forEach(s => s.classList.toggle('on', s.id === 's-' + name));
  $$('#top nav button').forEach(b => b.classList.toggle('on', b.dataset.go === name));
  document.body.dataset.screen = name;
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (name === 'board') loadBoard();
  if (name === 'mine') loadMine();
}
$$('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));

/* ── 一百年的格子 ──────────────────────── 
   按年代排成一墙：每行一个年代，左边一道刻度。
   1926 之前和 2025 之后的空位画成虚框，好让人看出这一百年从哪里起、到哪里止。 */
async function loadYears() {
  const d = await api('/api/years');
  years = d.years;
  const g = $('#grid'); g.innerHTML = '';
  const cap = $('#grid-cap');
  const CAP0 = cap.textContent;
  const byYear = new Map(years.map(y => [y.year, y]));
  const dec0 = Math.floor(years[0].year / 10) * 10;
  const dec1 = Math.floor(years[years.length - 1].year / 10) * 10;
  for (let dec = dec0; dec <= dec1; dec += 10) {
    const r = (dec - dec0) / 10 + 1;
    const lab = el('div', 'decade', String(dec));
    lab.style.setProperty('--r', r);
    g.appendChild(lab);
    for (let y = dec; y < dec + 10; y++) {
      const c = y - dec + 2;
      const info = byYear.get(y);
      if (!info) {
        const gh = el('i', 'ghost');
        gh.style.setProperty('--r', r); gh.style.setProperty('--c', c);
        g.appendChild(gh); continue;
      }
      const b = el('button', 'yr d' + heat(info.ceiling));
      b.style.setProperty('--r', r); b.style.setProperty('--c', c);
      /* 一局二十四个月，走到头不能超出 2025 年 12 月，所以 2024 年以后只剩几个月能开局 */
      const canStart = info.ready && (info.startMonths || []).length > 0;
      b.disabled = !canStart;
      b.setAttribute('aria-label', y + ' 年');
      b.appendChild(el('span', '', String(y)));
      if (info.switch) b.appendChild(el('i', 'sw'));
      const say = !info.ready ? `${y} 年还没准备好，先挑别的年份吧。`
        : !canStart ? `从 ${y} 年开始走不满 24 个月，最晚只能从 2024 年 1 月开局。`
        : `${y} · ${info.city}${info.era ? ' —— ' + info.era : ''}` + (info.switch ? `（${info.switch.month} 月币制改革）` : '');
      const show = () => { cap.textContent = say; };
      const hide = () => { cap.textContent = CAP0; };
      b.addEventListener('mouseenter', show); b.addEventListener('focus', show);
      b.addEventListener('mouseleave', hide); b.addEventListener('blur', hide);
      b.addEventListener('click', () => openYear(y));
      g.appendChild(b);
    }
  }
}
/* 红的深浅按这一年的上限分档。上限最高 20 年，老档位（60/20/4）最深那档永远用不到。 */
const heat = c => c >= 14 ? 3 : c >= 7 ? 2 : c >= 2 ? 1 : 0;

/* ── 一年的详情 ────────────────────────── */
async function openYear(y) {
  go('year');
  const head = $('#year-head');
  head.innerHTML = `<div class="big">${y}</div><div class="era">正在翻开这一年…</div>`;
  $('#year-body').innerHTML = ''; $('#year-intro').innerHTML = ''; $('#months').innerHTML = ''; $('#start-box').hidden = true;
  $('#mo-detail').textContent = '点选上面的月份，查看当月开局的本钱和大事。';
  let d;
  try { d = await api('/api/year?y=' + y); }
  catch (e) { head.innerHTML = `<div class="big">${y}</div><div class="era">${esc(e.message)}</div>`; return; }
  picked = y; pickedMonth = null;
  const c = d.card;

  head.innerHTML =
    `<div class="big">${y}</div>
     <div class="era">${esc(c.era)}</div>
     <div class="mood">${esc(c.economy.mood)}</div>
     <div class="chips">
       <span class="chip">落脚：${esc(d.city)}</span>
       ${d.switch ? `<span class="chip chip-sw">${d.switch.month} 月币制改革</span>` : ''}
     </div>`;

  /* 开场白和换钱提醒在挑月份上面，别的资料在动身按钮下面 */
  const intro = $('#year-intro'); intro.innerHTML = '';
  intro.appendChild(el('div', 'flavor', c.flavor));
  if (d.switch) intro.appendChild(el('div', 'warn', `这一年 ${d.switch.month} 月 ${d.switch.day} 日币制改革：${d.switch.say}`));
  if (d.echoes && d.echoes.length) {
    const ecBox = el('div', 'block');
    ecBox.appendChild(el('h4', '', '同年时空的穿越者与留痕'));
    const ul = el('ul');
    for (const tr of d.echoes) ul.appendChild(el('li', '', tr.summary));
    ecBox.appendChild(ul);
    ecBox.appendChild(el('p', 'hint', '进城后可寻访这些穿越者，与他们合伙、结拜或成婚。你做出的大事也会记入这一年。'));
    intro.appendChild(ecBox);
  }

  const body = $('#year-body'); body.innerHTML = '';
  if (c.economy.number) body.appendChild(blockList('当年经济', [[c.economy.number, '']]));
  body.appendChild(blockList('当年大事', (c.events || []).map(e => [`${e.month} 月`, e.text])));
  body.appendChild(blockPrices('物价参考', c.prices || []));
  body.appendChild(blockList('谋生门路', (c.money || []).map(m => [m.way, m.who])));
  body.appendChild(blockList('严查的买卖', (c.forbidden || []).map(f => [f.what, f.why])));
  body.appendChild(blockTags('当时已有的东西', (c.tech['日常'] || []).concat(c.tech['稀罕'] || []), false));
  body.appendChild(blockTags('当时还没有的', c.tech['没有'] || [], true));
  body.appendChild(blockList('常见祸事与风险', (c.risks || []).map(r => [r.what, r.hit])));

  const mo = $('#months'); mo.innerHTML = '';
  const info = (years || []).find(x => x.year === y) || {};
  const ok = new Set(info.startMonths || d.months.map(m => m.month));
  for (const m of d.months) {
    const b = el('button', 'mo');
    b.innerHTML = `<span class="n">${m.month} 月</span><i class="dot${m.events.length ? '' : ' off'}"></i>`;
    b.disabled = !ok.has(m.month);
    b.setAttribute('aria-pressed', 'false');
    b.title = b.disabled ? '从这个月起走不满 24 个月' : (m.events.join('；') || '这个月城里平稳，没什么大事');
    b.addEventListener('click', () => pickMonth(m, b));
    mo.appendChild(b);
  }
  $('#start').textContent = `穿去 ${y} 年`;
}

function blockList(title, rows) {
  const b = el('div', 'block'); b.appendChild(el('h4', '', title));
  const ul = el('ul');
  for (const [a, x] of rows) {
    const li = el('li');
    li.appendChild(document.createTextNode(a));
    if (x) { li.appendChild(document.createTextNode(' ')); li.appendChild(el('span', 'who', '— ' + x)); }
    ul.appendChild(li);
  }
  b.appendChild(ul); return b;
}
function blockPrices(title, rows) {
  const b = el('div', 'block'); b.appendChild(el('h4', '', title));
  const g = el('div', 'pricegrid');
  /* 查资料写的年卡，价钱一栏常常带一段括号里的说明，1948 年甚至是一整句话。
     括号前那截当价钱（短的不许断行），括号那截另起一行当小字；
     光价钱就超过十二个字的，整个放开让它换行——否则手机上会横向溢出。 */
  for (const p of rows) {
    const d = el('div');
    const s = String(p.price == null ? '' : p.price);
    const m = s.match(/^([^（(]*)([（(][\s\S]*)?$/);
    const main = (m ? m[1] : s).trim(), note = (m && m[2] ? m[2] : '').trim();
    d.appendChild(el('span', '', p.item));
    d.appendChild(el('b', main.length > 12 ? 'long' : '', main));
    /* 两个来源合成那行小字：
       ① price 里括号那截（上面刚拆出来的）
       ② 独立的 note 字段——考据太长时从 item 挪过来的那些
          （「这是哪个市的价」「按什么折算的」「是不是估的」） */
    const small = [note, p.note].filter(Boolean).join(' ');
    if (small) d.appendChild(el('small', 'pnote', small));
    g.appendChild(d);
  }
  b.appendChild(g);
  if (rows.some(p => p.note)) {
    b.appendChild(el('p', 'hint', '价格下方的小字是史料出处或折算说明。'));
  }
  return b;
}
function blockTags(title, items, no) {
  const b = el('div', 'block'); b.appendChild(el('h4', '', title));
  const r = el('div', 'tagrow');
  for (const t of items) r.appendChild(el('span', 'tag' + (no ? ' no' : ''), t));
  b.appendChild(r); return b;
}

function pickMonth(m, btn) {
  pickedMonth = m.month;
  $$('.mo').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
  btn.classList.add('on'); btn.setAttribute('aria-pressed', 'true');
  const ev = m.events.length ? `当月大事：${m.events.join('；')}。` : '这个月城里平稳，没有载入史册的大事。';
  /* 二十四个月之后是哪一年哪一月，当场算给他看 */
  const a0 = picked * 12 + m.month - 1;
  const t = a0 + 23;
  const to = `${Math.floor(t / 12)} 年 ${t % 12 + 1} 月`;
  /* 这二十四个月里会不会撞上换钱——年份格子上那颗蓝点说的就是这件事，
     但撞不撞得上要看落在哪个月，得在这儿说清楚，别让人白点。 */
  const sw = [];
  for (const y of (years || [])) {
    if (!y.switch) continue;
    const k = y.year * 12 + y.switch.month - 1;
    if (k >= a0 && k <= t) sw.push(`${y.year} 年 ${y.switch.month} 月${y.switch.day > 1 ? `（${y.switch.day} 日，当月底折算）` : ''}币制改革`);
  }
  $('#mo-detail').innerHTML =
    `<div class="month-period"><b>${picked} 年 ${m.month} 月 — ${to}</b><span>共 24 个月</span></div>` +
    `<div class="month-facts"><span>开局本钱<b>${esc(m.startCash)}</b></span><span>普通人年收入<b>${esc(m.incomeText)}</b></span></div>` +
    `<p>${esc(ev)}</p>` +
    (sw.length ? `<p class="month-warning"><b>这 24 个月里会赶上换币：${esc(sw.join('；'))}</b><br>到时候手里的现金会按官方比率折算，囤下的实物家当则按市价保值。</p>` : '');
  $('#start-box').hidden = false;
}

/* 设定框的字数：跟清单一个数法，只数汉字，标点和数字不计 */
const HAN = /[\u4e00-\u9fff\u3400-\u4dbf]/gu;
$('#persona').addEventListener('input', () => {
  const n = ($('#persona').value.match(HAN) || []).length;
  const el2 = $('#persona-count');
  el2.textContent = `${n} / 50 字`;
  el2.classList.toggle('over', n > 50);
});

$('#start').addEventListener('click', async () => {
  if (!pickedMonth) return toast('请先挑一个开始的月份');
  const btn = $('#start'); const was = btn.textContent;
  btn.disabled = true; btn.textContent = '正在开局…';
  try {
    const nick = $('#nick').value.trim();
    const persona = $('#persona').value.trim();
    const d = await post('/api/run', { year: picked, month: pickedMonth, nick, persona });
    token = d.token; localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(RUN_KEY, d.id);
    run = { id: d.id, state: d.state };
    refFor = null; $('#ref').open = false; $('#ref-body').innerHTML = '';
    renderPlay({ story: d.flavor, tally: '', refused: [], first: true });
    go('play');
    /* 落地那三条是照年卡拼的，先摆上去不让他等；接着换一份模型写的，
       上面有他落地这座城当下的人和价钱。换不来就还是那三条。 */
    post('/api/options', { id: d.id, token }).then(r => {
      if (run && run.id === d.id && r.options && r.options.length) { run.state.options = r.options; renderPicks(r.options); }
    }).catch(() => {});
  } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = was;
});

/* 玩的时候也要翻得到这一年的物价和禁忌——
   人在写这个月做什么，总得知道一斤米多少钱、什么事碰不得。 */
let refFor = null;
async function loadRef(year) {
  if (refFor === year) return;
  const box = $('#ref-body'); box.innerHTML = '';
  box.appendChild(el('p', 'hint', '正在翻阅资料…'));
  try {
    const d = await api('/api/year?y=' + year);
    const c = d.card;
    box.innerHTML = '';
    box.appendChild(blockPrices('物价参考', c.prices || []));
    box.appendChild(blockList('谋生门路', (c.money || []).map(m => [m.way, m.who])));
    box.appendChild(blockList('严查的买卖', (c.forbidden || []).map(f => [f.what, f.why])));
    box.appendChild(blockTags('当时还没有的', c.tech['没有'] || [], true));
    refFor = year;
  } catch (e) { box.innerHTML = ''; box.appendChild(el('p', 'hint', '资料没能读出来：' + e.message)); }
}
$('#ref').addEventListener('toggle', () => { if ($('#ref').open && run) loadRef(run.state.year); });

/* ── 玩 ────────────────────────────────── */
/* 跟 engine.js 的 unitOf() / moneyIn() 一个写法，只在读档时给没带 text 的分录用。
   一组数共用一个单位，同一张账单上不许一行写「万」下一行写光数目。 */
const UNITS = [{ min: 1e12, div: 1e12, name: '万亿' }, { min: 1e8, div: 1e8, name: '亿' }, { min: 1e4, div: 1e4, name: '万' }, { min: 0, div: 1, name: '' }];
const unitOf = nums => { const big = Math.max(0, ...[].concat(nums).map(n => Math.abs(Number(n)) || 0)); const u = UNITS.find(x => big >= x.min); return { ...u, dp: u.div > 1 || big < 100 ? 2 : 0 }; };
const moneyIn = (n, unit, cur) => `${(n / unit.div).toFixed(unit.dp)} ${unit.name}${cur || '元'}`;
const fmtMoney = (n, cur) => moneyIn(n, unitOf(n), cur);

/* 从玩家写的当月打算里提取核心词，用来给正文里对应的句子和关键词做高亮 */
const STOP_PHRASES = /(这个月|本月|打算|计划|准备|想要|我要|我想|先去|再去|然后|或者|以及|顺便|继续|一下|一个|一些|一点|进来|出去|起来|下来|过去|过来|那里|这里|那边|这边)/g;
const STOP_CHARS = /[把将去到找和跟与在给向往从为替被让叫拿用靠按照比朝对的了着过得地呢吗吧啊呀么之及或并又也还就才都只先再多，。！？；、：“”‘’（）()【】\s]+/;
function planKeywords(list) {
  const raw = String(list || '').replace(STOP_PHRASES, ' ');
  const parts = raw.split(STOP_CHARS).map(s => s.trim()).filter(s => s.length >= 2);
  const out = new Set();
  for (const p of parts) {
    if (p.length <= 4) out.add(p);
    if (p.length >= 4) {
      for (let i = 0; i <= p.length - 2; i += 2) out.add(p.slice(i, i + 2));
      for (let i = 0; i < p.length - 1; i++) out.add(p.slice(i, i + 2));
    }
  }
  return [...out].filter(w => w.length >= 2).sort((a, b) => b.length - a.length).slice(0, 12);
}

function highlightKeysInHtml(html, keys) {
  if (!keys.length) return html;
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(' + keys.map(escRe).join('|') + ')', 'g');
  return html.replace(re, m => `<b class="story-key">${m}</b>`);
}

function formatStory(story, list) {
  const raw = String(story || '');
  if (!raw) return '';
  const keys = planKeywords(list);
  let safe = esc(raw);

  if (safe.includes('**')) {
    safe = safe.replace(/\*\*([^*\n]+)\*\*/g, (_, inner) => `<mark class="story-hl">${highlightKeysInHtml(inner, keys)}</mark>`);
    /* 流式输出到一半还没闭合的 ** 也实时高亮，不露出星号 */
    safe = safe.replace(/\*\*([^*\n]+)$/g, (_, inner) => `<mark class="story-hl">${highlightKeysInHtml(inner, keys)}</mark>`);
    return safe;
  }

  if (!keys.length) return safe;
  const sents = safe.match(/[^。！？；\n]+[。！？；]?|\n+/g) || [safe];
  const scored = sents.map(s => {
    const hits = keys.filter(k => s.includes(k));
    return { s, score: hits.length };
  });
  const maxScore = Math.max(0, ...scored.map(x => x.score));
  if (maxScore === 0) return safe;
  const threshold = maxScore >= 2 ? 2 : 1;
  return scored.map(({ s, score }) => {
    if (score >= threshold) return `<mark class="story-hl">${highlightKeysInHtml(s, keys)}</mark>`;
    return s;
  }).join('');
}

function renderPlay(last, opts = {}) {
  const s = run.state;
  const now = Math.min(s.n, s.months);
  const done = !!s.finished || s.n > s.months;
  const traits = ((s.memo || {}).traits || []).filter(t => !t.lost);

  /* 左边那一栏：日历页、二十四道刻度、家底、四条杠 */
  const ticks = Array.from({ length: s.months }, (_, i) =>
    `<i class="${i < s.n - 1 || done ? 'on' : (i === s.n - 1 ? 'now' : '')}"></i>`).join('');
  /* 家当摊开写会把整块挤爆——真跑出来过一屏二十多样、把日历都顶出屏幕。
     只摆最值钱的三样，其余折进「还有 N 样」，点开才展开。 */
  const subs = [];
  if ((s.assets && s.assets.length) || (s.debts && s.debts.length)) subs.push(`现金 <b>${esc(s.cashText)}</b>`);
  if (s.assets && s.assets.length) {
    const all = [...s.assets].sort((x, y) => (y.worth || 0) - (x.worth || 0));
    const 摆 = all.slice(0, 3), 藏 = all.slice(3);
    const one = a => esc(a.name) + ' ' + esc(a.worthText);
    subs.push(`家当 <b>${摆.map(one).join('，')}</b>` + (藏.length
      ? `<details class="more-assets"><summary>还有 ${藏.length} 样</summary><b>${藏.map(one).join('，')}</b></details>`
      : ''));
  }
  if (s.debts && s.debts.length) subs.push(`欠款 <b>${s.debts.map(d => esc(d.who) + ' ' + esc(d.amountText)).join('，')}</b>`);
  $('#play-bar').innerHTML =
    `<div class="cal">
       <div class="cal-top">${s.year} 年</div>
       <div class="cal-num${opts.flip ? ' flip' : ''}">${MONTHS[s.month - 1]}</div>
       <div class="cal-foot"><span class="of">第 ${now} / ${s.months} 个月</span> · ${esc(s.city)}</div>
     </div>
     <div class="ticks" style="grid-template-columns:repeat(${Math.min(s.months, 30)},1fr)">${ticks}</div>
     <div class="money"><span class="lab">家底</span><b class="cash">${esc(s.netWorthText)}</b><div class="sub">${subs.join('<br>')}</div></div>` +
    /* 屏幕上只有钱这一个数（sway 2026-09-04）。身手、脑子、摊子多大、手底下多少人，
       全在下面这一栏的文字里默默攒着，照样影响往后走得动什么，只是不摆成数值。 */
    (traits.length ? `<div class="traits"><span class="lab">本事与家业</span>${
      traits.map(t => `<i title="${esc((t.notes || []).map(x => x.note).join('；'))}">${esc(t.what)}</i>`).join('')}</div>` : '') +
    (s.persona ? `<div class="who-line">${esc(s.persona)}</div>` : '');

  /* 正文 */
  const box = $('#play-story'); box.innerHTML = '';
  box.classList.toggle('fresh', !!opts.flip);
  const at = last.at || prevMonthOf(s);
  const myList = last.list || ((s.recent && s.recent.length && !last.first) ? s.recent[s.recent.length - 1].list : '');
  box.appendChild(el('div', 'day-head', last.head || (last.first
    ? `${s.year} 年 ${s.month} 月 · ${s.city}`
    : `第 ${at.n} 个月 · ${at.year} 年 ${at.month} 月`)));
  if (myList && !last.first) {
    const pb = el('div', 'my-plan');
    pb.innerHTML = `<span class="mp-lab">本月打算</span><span class="mp-txt">${esc(myList)}</span>`;
    box.appendChild(pb);
  }
  const sp = el('p', '');
  sp.innerHTML = formatStory(last.story || '', myList);
  box.appendChild(sp);

  /* 每月结算插画：已经画好的直接摆出来，还在画的先放占位框并在后台拉取 */
  const imgUrl = last.image || ((s.recent && s.recent.length && !last.first) ? s.recent[s.recent.length - 1].image : null);
  if (imgUrl && !last.first) {
    const fig = el('figure', 'month-art');
    const im = el('img'); im.src = imgUrl; im.alt = `第 ${at.n} 个月插画`; im.loading = 'lazy';
    fig.appendChild(im);
    box.appendChild(fig);
  } else if (!last.first && at && at.n && run && run.id && (last.story || '').length > 10) {
    const waitBox = el('figure', 'month-art pending');
    waitBox.id = 'month-art-box';
    waitBox.innerHTML = '<span>正在绘制本月插画…</span>';
    box.appendChild(waitBox);
    requestMonthImage(run.id, at.n);
  }

  if (last.entries && last.entries.length) {
    const t = el('div', 'tally');
    const unit = unitOf(last.entries.map(e => e.amount));   // 读老档时也是整张账单一个单位
    for (const e of last.entries) {
      const r = el('div', 'e' + (e.amount < 0 ? ' out' : ''));
      r.appendChild(el('span', '', e.what));
      r.appendChild(el('i', 'lead'));
      const text = e.text || moneyIn(e.amount, unit, s.currencyName);
      r.appendChild(el('b', '', (e.amount >= 0 ? '+' : '−') + text.replace('-', '')));
      t.appendChild(r);
    }
    const net = String(last.tally || '').match(/净[进出][^；]*$/);
    if (net) t.appendChild(el('div', 'net', net[0]));
    box.appendChild(t);
  } else if (last.tally) box.appendChild(el('div', 'tally-line', last.tally));

  if (last.switched && last.switched.length) {
    for (const sw of last.switched) {
      const w = el('div', 'refused');
      w.appendChild(el('b', '', '本月币制改革'));
      const ul = el('ul'); ul.appendChild(el('li', '', `${sw.say} 你手里的 ${sw.before} 折成了 ${sw.after}。`));
      w.appendChild(ul); box.appendChild(w);
    }
  }
  if (last.moved && last.moved.to) {
    box.appendChild(el('div', 'note', `这个月你从${last.moved.from}搬到了${last.moved.to}。`));
  }
  if (last.worldTrace && last.worldTrace.summary) {
    const label = last.worldTrace.kind === 'bond' ? '穿越者结缘' : '时空留痕';
    box.appendChild(el('div', 'note', `【${label}】${last.worldTrace.summary}（已记入 ${last.worldTrace.year} 年时空）`));
  }
  if (last.refused && last.refused.length) {
    const w = el('div', 'refused');
    w.appendChild(el('b', '', '没办成的事'));
    const ul = el('ul');
    for (const r of last.refused) ul.appendChild(el('li', '', `${r.what} — ${r.why}`));
    w.appendChild(ul); box.appendChild(w);
  }
  if (last.overTop) box.appendChild(el('div', 'note', '这个月赚得丰厚，已全数入账。'));
  if (last.overspent) box.appendChild(el('div', 'note', `手头现金不够，有 ${last.overspent} 的开销没付出去。`));
  if (last.local) box.appendChild(el('div', 'note', '这个月暂按固定规则推演' + (last.why ? `（${last.why}）` : '') + '。'));

  /* 写清单 */
  $('#list').disabled = done;
  $('#write-label').textContent = done
    ? (s.phase === 'extra' ? '这几年过完了' : '满两年了')
    : `第 ${s.n} 个月，打算做什么？`;
  const send = $('#send'); send.classList.remove('busy');
  if (done) { send.disabled = false; send.textContent = s.phase === 'extra' ? '去算总账' : '去算这两年的账'; send.onclick = settle; }
  else { send.disabled = countHan($('#list').value) === 0; send.textContent = '过这个月'; send.onclick = sendMonth; }

  renderPicks(done ? [] : (last.options || s.options || []));

  renderMemo(s.memo);

  const lb = $('#ledger-body'); lb.innerHTML = '';
  for (const d of (s.recent || []).slice().reverse()) {
    const r = el('div', 'row');
    r.appendChild(el('span', 'd', `${d.year} 年 ${d.month} 月`));
    r.appendChild(el('span', 't', d.tally || (d.story || '').slice(0, 40)));
    lb.appendChild(r);
  }
  $('#ledger').hidden = !(s.recent && s.recent.length);
}

/* 这一局记着的事。每过一个月，模型把刚发生的压成几行，游戏只添不删——
   摊开给玩家看，是因为「一件都没丢」这件事得看得见，不能只是嘴上说。 */
function renderMemo(m) {
  const box = $('#memo'), body = $('#memo-body');
  const has = m && ((m.trail || []).length || (m.people || []).length || (m.threads || []).length || (m.traits || []).length);
  box.hidden = !has;
  if (!has) return;
  body.innerHTML = '';
  const open = (m.threads || []).filter(t => !t.done);
  const closed = (m.threads || []).filter(t => t.done);
  $('#memo-sum').textContent = '攒下的人脉与家业';


  const block = (title, rows) => {
    if (!rows.length) return;
    body.appendChild(el('h4', 'memo-h', title));
    for (const [a2, b2] of rows) {
      const r = el('div', 'row');
      r.appendChild(el('span', 'd', a2));
      r.appendChild(el('span', 't', b2));
      body.appendChild(r);
    }
  };
  const tr = m.traits || [];
  if (tr.length) {
    body.appendChild(el('h4', 'memo-h', '本事与家业'));
    for (const t of tr) {
      body.appendChild(el('div', 'memo-who' + (t.lost ? ' lost' : ''),
        t.what + (t.lost ? `（第 ${t.first}–${t.lost} 个月有过）` : '')));
      for (const x of (t.notes || [])) {
        const r = el('div', 'row');
        r.appendChild(el('span', 'd', `第 ${x.n} 个月`));
        r.appendChild(el('span', 't', x.note));
        body.appendChild(r);
      }
    }
  }
  block('还没了结的事', open.map(t => [`第 ${t.opened} 个月起`, t.what + (t.note ? ` —— ${t.note}` : '')]));
  /* 「走过的路」玩的时候不摆出来——二十四行压在旁边太乱（sway 2026-09-04）。
     游戏照旧一条不少地记着，收工那一页每个月折起来的那一行就是它。 */
  /* 一个人一小段：名字一行，跟他之间发生过的事一个月一行。
     挤成一段读不下去——第 1 个月怎么认识的和第 20 个月什么交情，得看得出先后。 */
  if ((m.people || []).length) {
    body.appendChild(el('h4', 'memo-h', '认识的人'));
    for (const p of m.people) {
      body.appendChild(el('div', 'memo-who', p.who));
      for (const x of (p.notes || [])) {
        const r = el('div', 'row');
        r.appendChild(el('span', 'd', `第 ${x.n} 个月`));
        r.appendChild(el('span', 't', x.note));
        body.appendChild(r);
      }
    }
  }
  if (closed.length) block('已经了结的事', closed.map(t => [`第 ${t.done} 个月`, t.what]));
  if ((m.folded || []).length) block('更早的经历', [['', m.folded.join('、')]]);
}

/* 三条路。点一条就写进下面的格子里，还能接着改、接着添——
   写什么仍旧是自己说了算，这三条只是免得对着空格子发呆。 */
function renderPicks(list) {
  const box = $('#picks'), body = $('#picks-list');
  body.innerHTML = '';
  box.hidden = !(list && list.length);
  if (box.hidden) return;
  for (const o of list) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'p';
    b.appendChild(el('b', '', o.what || ''));
    if (o.why) b.appendChild(el('em', '', o.why));
    b.onclick = () => { writeIn(o.what || ''); b.classList.add('used'); };
    body.appendChild(b);
  }
}

/* 填进格子：接在已经写的后面另起一行，光标留在末尾，字数当场重算 */
function writeIn(text) {
  const t = $('#list');
  if (t.disabled) return;
  const had = t.value.replace(/\s+$/, '');
  t.value = had ? had + '\n' + text : text;
  t.dispatchEvent(new Event('input'));
  t.focus();
  t.setSelectionRange(t.value.length, t.value.length);
}

$('#picks-more').addEventListener('click', async () => {
  if (!run) return;
  const btn = $('#picks-more');
  btn.disabled = true; btn.textContent = '正在换…';
  try {
    const d = await post('/api/options', { id: run.id, token });
    if (d.options && d.options.length) { run.state.options = d.options; renderPicks(d.options); }
  } catch (e) { toast(e.message); }
  btn.disabled = false; btn.textContent = '换三条';
});

const countHan = s => (String(s).match(/[一-鿿]/g) || []).length;
$('#list').addEventListener('input', () => {
  const n = countHan($('#list').value);
  const lim = (run && run.state.listLimit) || 500;
  const c = $('#count');
  c.textContent = `${n} / ${lim} 字`;
  c.classList.toggle('over', n > lim);
  $('#send').disabled = n === 0 || n > lim;
});

/* 上一个月是哪一年哪一月——读档回来时 last 里没有 at，就从最近几个月里取 */
function prevMonthOf(s) {
  const last = (s.recent || [])[(s.recent || []).length - 1];
  return last ? { n: last.n, year: last.year, month: last.month } : { n: Math.max(1, s.n - 1), year: s.year, month: s.month };
}

let imgReqKey = '';
async function requestMonthImage(runId, n) {
  const key = `${runId}:${n}`;
  imgReqKey = key;
  try {
    const d = await post('/api/month-image', { id: runId, token, n });
    if (imgReqKey !== key) return;
    const box = $('#month-art-box');
    if (d && d.ok && d.image) {
      if (run && run.state && Array.isArray(run.state.recent)) {
        const hit = run.state.recent.find(x => Number(x.n) === Number(n));
        if (hit) hit.image = d.image;
      }
      if (box) {
        box.classList.remove('pending');
        box.innerHTML = '';
        const im = el('img'); im.src = d.image; im.alt = `第 ${n} 个月插画`; im.loading = 'lazy';
        box.appendChild(im);
      }
    } else if (box) {
      box.remove();
    }
  } catch (e) {
    if (imgReqKey === key && $('#month-art-box')) $('#month-art-box').remove();
  }
}

/* 正文边写边往屏幕上落。一个月的正文三五百字，一次性等它写完要十几秒，
   流式的话第一句话两秒就到，人不会以为卡住了。 */
function beginStream(at, list) {
  const box = $('#play-story'); box.innerHTML = '';
  box.classList.remove('fresh');
  box.appendChild(el('div', 'day-head', `第 ${at.n} 个月 · ${at.year} 年 ${at.month} 月`));
  if (list) {
    const pb = el('div', 'my-plan');
    pb.innerHTML = `<span class="mp-lab">本月打算</span><span class="mp-txt">${esc(list)}</span>`;
    box.appendChild(pb);
  }
  const p = el('p', 'live', '');
  box.appendChild(p);
  return p;
}

async function sendMonth() {
  const list = $('#list').value;
  const n = countHan(list);
  const lim = run.state.listLimit || 500;
  if (n === 0) return toast('先写下这个月打算干什么');
  if (n > lim) return toast(`超了 ${n - lim} 个汉字，删减一点再交吧`);
  const send = $('#send');
  send.disabled = true; send.textContent = '正在过这个月…'; send.classList.add('busy');
  /* 先把日历翻到正在算的这个月，再开始接正文 */
  const at = { n: run.state.n, year: run.state.year, month: run.state.month };
  const sticky = getComputedStyle($('#play-bar')).position === 'sticky';
  const goTop = () => {
    const top = $('#top').getBoundingClientRect().height + 14;
    const y = sticky ? $('#play-story').getBoundingClientRect().top + window.scrollY - top : 0;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  };
  try {
    const r = await fetch('/api/month', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: run.id, token, list, stream: true }),
    });
    if (!r.ok) {
      let say = '提交失败，请重试（' + r.status + '）';
      try { say = (await r.json()).error || say; } catch (e) {}
      throw new Error(say);
    }
    let d = null;
    if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
      const p = beginStream(at, list);
      goTop();
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '', story = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const em = /^event: (.+)$/m.exec(block), dm = /^data: (.*)$/m.exec(block);
          if (!em || !dm) continue;
          let data; try { data = JSON.parse(dm[1]); } catch (e) { continue; }
          if (em[1] === 'story') { story += data.t; p.innerHTML = formatStory(story, list); }
          else if (em[1] === 'redo') { story = ''; p.textContent = ''; }   // 半路断了，等兜底那份
          else if (em[1] === 'error') throw new Error(data.error || '这个月没能推演出来，请再试一次');
          else if (em[1] === 'done') d = data;
        }
      }
      if (!d) throw new Error('连接断了，你写的打算还留着，再点一次即可');
    } else {
      d = await r.json();
    }
    run.state = d.state;
    $('#list').value = ''; $('#count').textContent = `0 / ${d.state.listLimit} 字`; $('#count').classList.remove('over');
    renderPlay(d, { flip: true });
    goTop();
    if (d.done) toast(d.state.phase === 'extra' ? '这几年过完了，可以去算总账了' : '满两年了，可以去算这两年的账了');
  } catch (e) {
    toast(e instanceof TypeError ? '网络连接断了，你写的打算还留着，请再试一次。' : e.message);
    /* 出错了别把半截正文留在屏幕上——把上个月那一屏重画回来 */
    renderPlay(lastOf(run.state));
    send.disabled = false; send.textContent = '过这个月'; send.classList.remove('busy');
  }
}

/* ── 结算 ──────────────────────────────── */
async function settle() {
  const send = $('#send');
  send.disabled = true; send.textContent = '正在算账…'; send.classList.add('busy');
  try {
    const d = await post('/api/settle', { id: run.id, token });
    const phase = d.phase || d.result.phase || 'main';
    renderDone(d.result, d, d.months, { review: d.review, extraRoom: d.extraRoom, phase, main: d.main });
    localStorage.removeItem(RUN_KEY);
    go('done');
    /* 总评是另一次调用：账先出来，收梢的那一篇边等边写 */
    if (!d.review) fetchReview(run.id, phase === 'extra');
  } catch (e) {
    toast(e.message);
    send.disabled = false;
    send.textContent = run.state.phase === 'extra' ? '去算总账' : '去算这两年的账';
    send.classList.remove('busy');
  }
}

/* 成绩单那张卡。结算页和详情页共用一张。 */
function scoreCard(r, ranks, opts = {}) {
  const yrs = (r.score < 0 ? '−' : '') + Math.abs(r.score).toFixed(2);
  const card = el('div', 'score-card' + (opts.extra ? ' extra' : ''));
  card.appendChild(el('div', 'who', `${r.nick} · ${r.year} 年 ${r.month} 月 → ${r.endYear} 年 ${r.endMonth} 月 · ${r.city}`));
  card.appendChild(el('div', 'num' + (r.yearEarned < 0 ? ' neg' : ''), r.yearEarnedText));
  card.appendChild(el('div', 'unit', `${opts.extra ? `前前后后 ${(r.months / 12).toFixed(0)} 年` : '这两年'}净赚（按当时流通的钱算）`));
  const yearsEl = el('div', 'years');
  yearsEl.innerHTML = `抵得上当时普通人 <b>${yrs}</b> 年的收入`;
  card.appendChild(yearsEl);
  const rank = el('div', 'rank');
  if (opts.extra) {
    rank.innerHTML = `两年之后榜第 <b>${ranks?.rankExtra ?? '—'}</b> 名（共 ${ranks?.ofExtra ?? '—'} 局）<br><span class="rk-note">满两年后继续走的成绩单独排名，不进总榜</span>`;
  } else {
    rank.innerHTML = `${r.year} 年榜第 <b>${ranks?.rankYear ?? '—'}</b> 名（共 ${ranks?.ofYear ?? '—'} 局）<br>总榜第 <b>${ranks?.rankWorld ?? '—'}</b> 名（共 ${ranks?.ofWorld ?? '—'} 局）`;
  }
  card.appendChild(rank);
  const stamp = el('div', 'stamp', opts.extra ? '续走结算' : '两年结算'); stamp.setAttribute('aria-hidden', 'true');
  card.appendChild(stamp);
  return card;
}

/* 成绩单下面那张明细表 */
function scoreKv(r) {
  const yrs = (r.score < 0 ? '−' : '') + Math.abs(r.score).toFixed(2);
  const kv = el('div', 'kv');
  const rows = [
    ['开局本钱', r.startCashText || fmtMoney(r.startCash, r.currencyName)],
    ['收官家底', r.endWorthText || fmtMoney(r.endWorth, r.currencyName)],
    ['当时普通人年收入', r.incomeText || fmtMoney(r.income, r.currencyName)],
    ['抵得上几年收入', yrs + ' 年'],
    ['折合当年美元', r.usdThen != null ? fmtUsdCN(r.usdThen) : '—'],
    ['折合今天美元', r.worldUsdText || '—'],
    ['走过时间', (r.months || 0) + ' 个月'],
  ];
  for (const [k, v] of rows) { const d = el('div'); d.appendChild(el('span', '', k)); d.appendChild(el('b', '', v)); kv.appendChild(d); }
  return kv;
}

function renderDone(r, ranks, months, opts = {}) {
  const extra = opts.phase === 'extra';
  const b = $('#done-body'); b.innerHTML = '';
  b.appendChild(scoreCard(r, ranks, { extra }));
  b.appendChild(scoreKv(r));

  const rev = $('#done-review'); rev.innerHTML = '';
  if (opts.review) renderReview(rev, opts.review);

  renderExtendBox(r, opts);

  /* 回头看走过的日子。一个文字游戏打完不给人读一遍，等于没写过。
     放在「再来一局」下面——二十几条列表压在按钮上头的话，按钮就跑到屏幕外去了。 */
  const dbox = $('#done-days'); dbox.innerHTML = '';
  if (months && months.length) {
    dbox.appendChild(el('h3', 'mh', '逐月回顾'));
    dbox.appendChild(el('p', 'hint', '点开任意月份，重看当月写下的打算、经历和账单。'));
    monthCards(dbox, months, { mainMonths: 24 });
  }
}

/* 一个月一张折叠卡。结算页和详情页共用。 */
function monthCards(box, months, opts = {}) {
  const cut = opts.mainMonths || 24;
  months.forEach((d, i) => {
    if (d.n === cut + 1) {
      const line = el('div', 'extra-cut');
      line.appendChild(el('b', '', '两年之后'));
      line.appendChild(el('span', '', '前两年的成绩已定格，往后走的单独计分。'));
      box.appendChild(line);
    }
    const det = el('details', 'day' + (d.n > cut ? ' is-extra' : ''));
    const sum = el('summary');
    sum.appendChild(el('b', 'dn', `${d.year} 年 ${d.month} 月`));
    /* 折起来的这一行就是那个月的月记——一眼扫得完这些年；账和正文点开再看。
       玩的时候左边那一折里不摆月记（二十四行太乱），回顾的时候才摆。
       老档没有月记，退回显示那一行账。 */
    sum.appendChild(el('span', 'dt', d.say || d.tally || ''));
    if (d.worth) sum.appendChild(el('em', 'dw', d.worth));
    det.appendChild(sum);
    const dbx = el('div', 'daybox');
    dbx.appendChild(el('div', 'mylist', '当月打算：' + (d.list || '')));
    const dp = el('p', '');
    dp.innerHTML = formatStory(d.story || '', d.list || '');
    dbx.appendChild(dp);
    if (d.image) {
      const fig = el('figure', 'month-art');
      const im = el('img'); im.src = d.image; im.alt = `${d.year} 年 ${d.month} 月插画`; im.loading = 'lazy';
      fig.appendChild(im);
      dbx.appendChild(fig);
    }
    if (d.say && d.tally) dbx.appendChild(el('div', 'note', d.tally));
    if (d.moved && d.moved.to) dbx.appendChild(el('div', 'note', `这个月你从${d.moved.from}搬到了${d.moved.to}。`));
    if (d.worldTrace && d.worldTrace.summary) {
      const label = d.worldTrace.kind === 'bond' ? '穿越者结缘' : '时空留痕';
      dbx.appendChild(el('div', 'note', `【${label}】${d.worldTrace.summary}`));
    }
    if (d.refused && d.refused.length) {
      const w = el('div', 'refused');
      w.appendChild(el('b', '', '没办成的事'));
      const ul = el('ul');
      for (const x of d.refused) ul.appendChild(el('li', '', `${x.what} — ${x.why}`));
      w.appendChild(ul); dbx.appendChild(w);
    }
    det.appendChild(dbx);
    box.appendChild(det);
  });
}

/* ── 收梢的那一篇 ──────────────────────── */
function renderReview(box, rv) {
  box.innerHTML = '';
  if (!rv) return;
  box.appendChild(el('div', 'rev-cap', rv.phase === 'extra' ? '这几年回顾' : '这两年回顾'));
  box.appendChild(el('h3', 'rev-title', rv.title || '这些日子'));
  if (rv.became) box.appendChild(el('p', 'rev-became', rv.became));
  const v = el('div', 'rev-text');
  for (const seg of String(rv.verdict || '').split('\n')) if (seg.trim()) v.appendChild(el('p', '', seg.trim()));
  box.appendChild(v);
  if (rv.turns && rv.turns.length) {
    const t = el('div', 'rev-turns');
    t.appendChild(el('b', '', '转折点'));
    const ul = el('ul');
    for (const x of rv.turns) {
      const li = el('li');
      if (x.when) li.appendChild(el('i', '', x.when));
      li.appendChild(document.createTextNode(x.what || ''));
      ul.appendChild(li);
    }
    t.appendChild(ul); box.appendChild(t);
  }
  if (rv.missed) {
    const m = el('div', 'rev-missed');
    m.appendChild(el('b', '', '当时没走的另一条路'));
    m.appendChild(el('p', '', rv.missed));
    box.appendChild(m);
  }
  if (rv.local) box.appendChild(el('p', 'note', '总结暂时没生成出来，先按账本替你梳理了一遍。'));
}

async function fetchReview(id, extra, into) {
  const box = into || $('#done-review');
  box.innerHTML = '';
  box.appendChild(el('div', 'rev-wait', extra ? '正在写这几年的回顾…' : '正在写这两年的回顾…'));
  try {
    const d = await post('/api/review', { id, token, extra: !!extra });
    renderReview(box, d.review);
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(el('p', 'note', '回顾没写出来：' + e.message));
    const again = el('button', 'ghost-btn', '再试一次');
    again.addEventListener('click', () => fetchReview(id, extra, box));
    box.appendChild(again);
  }
}

/* ── 接着走下去 ────────────────────────── */
const roomText = n => n >= 12
  ? `${Math.floor(n / 12)} 年${n % 12 ? `零 ${n % 12} 个月` : ''}`
  : `${n} 个月`;

function renderExtendBox(r, opts) {
  const box = opts.into || $('#done-more');
  box.innerHTML = ''; box.hidden = false;
  box.className = 'more-box';
  if (opts.phase === 'extra') {
    const m = opts.main;
    box.appendChild(el('h3', 'mh', '前两年的成绩'));
    box.appendChild(el('p', 'hint', m
      ? `净赚 ${m.yearEarnedText}，抵得上当时普通人 ${m.score.toFixed(2)} 年的收入。这份成绩已经定格在总榜和年榜上。`
      : '前两年的成绩已经定格，后面接着走的单独计分。'));
    return;
  }
  const id = opts.id || (run && run.id);
  if (!id) { box.hidden = true; return; }
  const room = Number(opts.extraRoom || 0);
  box.appendChild(el('h3', 'mh', '还要接着往下过吗？'));
  if (!room) {
    box.appendChild(el('p', 'hint', '已经走到 2025 年 12 月，没法再往后接了。'));
    return;
  }
  box.appendChild(el('p', 'hint', '前两年的成绩已经定格在榜上。接着往下过最多还能走 ' + roomText(room) + '，成绩单另算。'));
  const btn = el('button', 'primary', `接着过下去（最多 ${roomText(room)}）`);
  btn.addEventListener('click', () => extendRun(btn, room, id));
  box.appendChild(btn);
}

async function extendRun(btn, room, id) {
  btn.disabled = true; btn.classList.add('busy'); btn.textContent = '正在接上…';
  try {
    const d = await post('/api/extend', { id, token });
    run = { id, state: d.state };
    localStorage.setItem(RUN_KEY, id);
    renderPlay({
      head: '接着往下过',
      story: `前两年的账已经结清定格。你留在${d.state.city}继续过日子，往前最多还有 ${roomText(d.room)}。`,
      switched: d.switched, options: d.state.options,
    }, { flip: true });
    go('play');
  } catch (e) {
    toast(e.message);
    btn.disabled = false; btn.classList.remove('busy'); btn.textContent = `接着过下去（最多 ${roomText(room)}）`;
  }
}

/* ── 一局的详情 ──────────────────────────
   清单和正文是玩的人自己的东西，只有自己的局进得来（从「我的局」，或榜上面板里那颗
   「看每个月写了什么」）。服务端也认这串 token，光有 id 拿不到详情。 */
let detailBack = 'mine';
async function openDetail(id, back = 'mine') {
  const box = $('#detail-body');
  box.innerHTML = '<p class="wait">正在打开记录…</p>';
  detailBack = back;
  go('detail');
  try {
    renderDetail(await api(`/api/detail?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`), id);
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(el('p', 'empty', '记录没能打开：' + e.message));
  }
}

function renderDetail(d, id) {
  const box = $('#detail-body'); box.innerHTML = '';
  const r = d.result;
  box.appendChild(el('h2', 'det-h', `${d.nick} 的 ${r.year} 年`));
  if (d.persona) box.appendChild(el('p', 'det-who', `人物设定：${d.persona}`));

  box.appendChild(scoreCard(r, d.rank, {}));
  box.appendChild(scoreKv(r));

  if (d.review) { const w = el('div', 'review'); renderReview(w, d.review); box.appendChild(w); }
  else {
    /* 自己的局、还没写过收梢——补写一篇 */
    const w = el('div', 'review'); box.appendChild(w);
    const b = el('button', 'ghost-btn', '写一篇回顾');
    b.addEventListener('click', () => { b.remove(); fetchReview(id, false, w); });
    box.appendChild(b);
  }

  /* 后传：接着走下去的那一段，另算一笔账 */
  if (d.extraStatus === 'done' && d.extraResult) {
    box.appendChild(el('h3', 'mh', '两年之后的成绩'));
    box.appendChild(el('p', 'hint', '这是满两年后接着走的成绩，在「两年之后」榜单独排名。'));
    box.appendChild(scoreCard(d.extraResult, d.extraRank, { extra: true }));
    box.appendChild(scoreKv(d.extraResult));
    if (d.extraReview) { const w = el('div', 'review'); renderReview(w, d.extraReview); box.appendChild(w); }
  } else if (d.extraStatus === 'playing') {
    box.appendChild(el('p', 'note', `这两年过完后，又接着走了 ${Math.max(0, d.months.length - d.mainMonths)} 个月，还没收官。`));
    const b = el('button', 'primary', '接着过下去');
    b.addEventListener('click', () => resume(id));
    box.appendChild(b);
  } else if (!d.extraStatus) {
    /* 结过账、还没接后传：在这儿也能接下去 */
    const w = el('div', 'more-box'); box.appendChild(w);
    renderExtendBox(r, { into: w, id, extraRoom: d.extraRoom });
  }

  if (d.months && d.months.length) {
    box.appendChild(el('h3', 'mh', '逐月回顾'));
    monthCards(box, d.months, { mainMonths: d.mainMonths });
  }
}
$('#detail-back').addEventListener('click', () => go(detailBack));

/* ── 榜上点进来的面板 ────────────────────
   谁都看得到：成绩单 + 记事人写的收梢。没有清单、没有正文、没有他记着的人和事——
   那些只在自己的局里看得到（sway 2026-09-03）。
   收梢还没写的局，服务端在后台写，这边先把成绩摆出来，每隔几秒问一次。 */
let peekFor = null;
const peekUrl = id => `/api/peek?id=${encodeURIComponent(id)}${token ? '&token=' + encodeURIComponent(token) : ''}`;
async function openPeek(id) {
  const box = $('#detail-body');
  box.innerHTML = '<p class="wait">正在打开记录…</p>';
  detailBack = 'board'; peekFor = id;
  go('detail');
  try {
    const d = await api(peekUrl(id));
    if (peekFor !== id) return;
    renderPeek(d, id);
    if (d.writing || d.extraWriting) setTimeout(() => peekPoll(id, 1), 4000);
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(el('p', 'empty', '记录没能打开：' + e.message));
  }
}

/* 收梢写好了没——只往那两个框里填，不整页重画，免得人正读着成绩单页面跳一下 */
async function peekPoll(id, tries) {
  if (peekFor !== id || document.body.dataset.screen !== 'detail') return;
  try {
    const d = await api(peekUrl(id));
    if (peekFor !== id) return;
    if (d.review && $('#peek-rev')) renderReview($('#peek-rev'), d.review);
    if (d.extraReview && $('#peek-rev-x')) renderReview($('#peek-rev-x'), d.extraReview);
    if ((d.writing || d.extraWriting) && tries < 30) setTimeout(() => peekPoll(id, tries + 1), 4000);
    else if (d.writing || d.extraWriting) {
      for (const k of ['#peek-rev', '#peek-rev-x']) if ($(k) && $(k).querySelector('.rev-wait')) {
        $(k).innerHTML = ''; $(k).appendChild(el('p', 'note', '回顾还在写，稍后再来翻翻看。'));
      }
    }
  } catch (e) {}
}

function renderPeek(d, id) {
  const box = $('#detail-body'); box.innerHTML = '';
  const r = d.result;
  box.appendChild(el('h2', 'det-h', `${d.nick} 的 ${r.year} 年`));
  box.appendChild(el('p', 'det-who', '这里展示成绩单和回顾总结。每个月写下的打算与经历只有本人能看。'));

  box.appendChild(scoreCard(r, d.rank, {}));
  box.appendChild(scoreKv(r));

  const w = el('div', 'review'); w.id = 'peek-rev'; box.appendChild(w);
  if (d.review) renderReview(w, d.review);
  else w.appendChild(el('div', 'rev-wait', '正在写这两年的回顾…'));

  if (d.extraStatus === 'done' && d.extraResult) {
    box.appendChild(el('h3', 'mh', '两年之后的成绩'));
    box.appendChild(el('p', 'hint', '这是满两年后接着走的成绩，在「两年之后」榜单独排名。'));
    box.appendChild(scoreCard(d.extraResult, d.extraRank, { extra: true }));
    box.appendChild(scoreKv(d.extraResult));
    const wx = el('div', 'review'); wx.id = 'peek-rev-x'; box.appendChild(wx);
    if (d.extraReview) renderReview(wx, d.extraReview);
    else wx.appendChild(el('div', 'rev-wait', '正在写后续几年的回顾…'));
  } else if (d.extraStatus === 'playing') {
    box.appendChild(el('p', 'note', '这一局满两年后还在接着往下过，尚未结算。'));
  }

  if (d.mine) {
    const act = el('div', 'peek-mine');
    act.appendChild(el('p', 'hint', '这一局是你自己玩的。'));
    const b = el('button', 'ghost-btn', '查看我每个月的经历');
    b.addEventListener('click', () => openDetail(id, 'board'));
    act.appendChild(b); box.appendChild(act);
  }
}

const fmtUsdCN = n => {
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e8) return `${s}${(a / 1e8).toFixed(2)} 亿美元`;
  if (a >= 1e4) return `${s}${(a / 1e4).toFixed(1)} 万美元`;
  if (a >= 100) return `${s}${Math.round(a).toLocaleString('en-US')} 美元`;
  return `${s}${a.toFixed(2)} 美元`;
};

/* ── 排行榜 ──────────────────────────────
   两层：总榜按「折成今天的美元」排，年榜只跟同一年的人比。 */
let boardYear = null, boardScope = 'world';
async function loadBoard() {
  const qs = boardScope === 'extra' ? '&scope=extra' : (boardYear ? '&year=' + boardYear : '');
  const d = await api('/api/board?limit=50' + qs);

  $('#board-note').innerHTML = boardScope === 'extra'
    ? `满两年后选择接着往下过的对局，在这里单独排名，不与总榜混比。`
    : boardYear
    ? `同样从 ${boardYear} 年出发的对局，直接按当年流通货币的净赚金额排名。`
    : `不同年代用的钱不一样：先按<b>当年汇率</b>折成美元，` +
      `再按<b>全球经济规模的增长倍数</b>折算到今天。` +
      `比如 1930 年的全球经济规模只有今天的二十一分之一，` +
      `那时候赚一千美元，份量相当于今天的两万多美元。点下面的年份可以单看同一年。`;

  const tabs = $('#board-tabs'); tabs.innerHTML = '';
  const mk = (label, y, scope) => {
    const on = (scope || 'world') === boardScope && (scope === 'extra' || y === boardYear);
    const b = el('button', on ? 'on' : '', label);
    b.addEventListener('click', () => { boardScope = scope || 'world'; boardYear = y; loadBoard(); });
    return b;
  };
  tabs.appendChild(mk('总榜', null));
  tabs.appendChild(mk('两年之后', null, 'extra'));
  for (const r of (d.yearsWithRuns || [])) tabs.appendChild(mk(`${r.year} 年（${r.n}）`, r.year));

  const box = $('#board-body'); box.innerHTML = '';
  if (!d.rows.length) {
    box.appendChild(el('p', 'empty', boardScope === 'extra'
      ? '还没有人走完两年之后的续篇。打满两年后，可以在结算页选择接着往下过。'
      : boardYear ? `还没有人走完从 ${boardYear} 年开始的对局。` : '榜上还没有记录，去挑个年份开一局吧。'));
    const act = el('div', 'empty-act'); const btn = el('button', 'ghost-btn', '去挑个年份');
    btn.addEventListener('click', () => go('pick')); act.appendChild(btn); box.appendChild(act);
    return;
  }
  const t = el('table', 'board');
  t.innerHTML = boardScope === 'extra'
    ? '<thead><tr><th></th><th>穿越者</th><th>降临年月</th><th class="c">城市</th><th class="c">总时长</th><th style="text-align:right">折合今天美元</th></tr></thead>'
    : boardYear
    ? '<thead><tr><th></th><th>穿越者</th><th>月</th><th class="c">城市</th><th style="text-align:right">净赚</th></tr></thead>'
    : '<thead><tr><th></th><th>穿越者</th><th>降临年月</th><th class="c">城市</th><th style="text-align:right">折合今天美元</th></tr></thead>';
  const tb = el('tbody');
  for (const r of d.rows) {
    const tr = el('tr');
    /* 名号后面那个小字是给手机的——没有鼠标悬停，不标出来没人知道这一行点得动 */
    const who = `${esc(r.nick)}<span class="go-in">查看</span>`;
    tr.innerHTML = boardScope === 'extra'
      ? `<td class="r">${r.rank}</td><td>${who}</td>
         <td class="y">${r.year}.${String(r.month).padStart(2, '0')}</td>
         <td class="c">${esc(r.city || '')}</td>
         <td class="c y">${Math.round((r.months || 0) / 12 * 10) / 10} 年</td>
         <td class="s">${esc(r.worldUsdText || '')}</td>`
      : boardYear
      ? `<td class="r">${r.rank}</td><td>${who}</td>
         <td class="y">${r.month} 月</td><td class="c">${esc(r.city || '')}</td>
         <td class="s">${esc(r.yearEarnedText || '')}</td>`
      : `<td class="r">${r.rank}</td><td>${who}</td>
         <td class="y">${r.year}.${String(r.month).padStart(2, '0')}</td>
         <td class="c">${esc(r.city || '')}</td>
         <td class="s">${esc(r.worldUsdText || '')}</td>`;
    /* 每一行点得进去，看的是成绩和收梢（/api/peek）；他每个月写了什么不在里面 */
    if (r.id) { tr.classList.add('peek'); tr.addEventListener('click', () => openPeek(r.id)); }
    if (tr.classList.contains('peek') || tr.classList.contains('mine-go')) {
      tr.tabIndex = 0; tr.setAttribute('role', 'button');
      tr.setAttribute('aria-label', '查看 ' + r.nick + ' 的记录');
      tr.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tr.click(); }
      });
    }
    tb.appendChild(tr);
  }
  t.appendChild(tb); box.appendChild(t);
  box.appendChild(el('p', 'hint', (boardScope === 'extra'
    ? '总时长包含最开始的那两年。'
    : boardYear
    ? '同一年开局的对局，按当年货币净赚金额排名。'
    : '不同年代的成绩统一折算成今天的美元来比。') +
    '点任意一行可看成绩单与回顾；每月的具体打算只有本人可见。'));
}

/* ── 我的局 ────────────────────────────── */
async function loadMine() {
  const box = $('#mine-body'); box.innerHTML = '';
  const empty = () => {
    box.appendChild(el('p', 'empty', '还没有玩过的记录，去挑个年份开一局吧。'));
    const act = el('div', 'empty-act'); const btn = el('button', 'ghost-btn', '去挑个年份');
    btn.addEventListener('click', () => go('pick')); act.appendChild(btn); box.appendChild(act);
  };
  if (!token) return empty();
  const d = await api('/api/mine?token=' + encodeURIComponent(token));
  if (!d.rows.length) return empty();
  const t = el('table', 'board');
  t.innerHTML = '<thead><tr><th>降临年月</th><th>穿越者</th><th>状态</th><th style="text-align:right">抵几年收入</th></tr></thead>';
  const tb = el('tbody');
  for (const r of d.rows) {
    const tr = el('tr');
    /* 按天走三十天的老局接不上新规矩了，标一下，也别让人点进去 */
    const old = r.mode && r.mode !== 'months24';
    const done = r.status === 'done';
    /* 三种下场：还在过前两年、结完账了、结完账又接着走后传 */
    const where = old ? '旧版记录，无法继续'
      : r.extra_status === 'playing' ? '两年后继续中'
      : r.extra_status === 'done' ? '续走已结算'
      : done ? '已结算' : '进行中';
    const sc = r.extra_status === 'done' && r.extra_score != null ? r.extra_score : r.score;
    tr.innerHTML = `<td class="y">${r.year}.${String(r.month).padStart(2, '0')}</td><td>${esc(r.nick)}</td>
      <td>${where}${done && !old ? '<span class="go-in">查看</span>' : ''}</td>
      <td class="s">${sc == null ? '—' : (Math.abs(sc) < 10 ? sc.toFixed(2) : sc.toFixed(1)) + ' 年'}</td>`;
    if (!old && r.extra_status === 'playing') { tr.classList.add('mine-go'); tr.addEventListener('click', () => resume(r.id)); }
    else if (!old && done) { tr.classList.add('mine-go'); tr.addEventListener('click', () => openDetail(r.id)); }
    else if (!old) { tr.classList.add('mine-go'); tr.addEventListener('click', () => resume(r.id)); }
    if (tr.classList.contains('peek') || tr.classList.contains('mine-go')) {
      tr.tabIndex = 0; tr.setAttribute('role', 'button');
      tr.setAttribute('aria-label', '查看 ' + r.nick + ' 的记录');
      tr.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tr.click(); }
      });
    }
    tb.appendChild(tr);
  }
  t.appendChild(tb); box.appendChild(t);
  box.appendChild(el('p', 'hint', '点「进行中」的记录接着过，点「已结算」的回看整局经历。'));
}

function lastOf(state) {
  const last = state.recent && state.recent.length ? state.recent[state.recent.length - 1] : null;
  return last
    ? { list: last.list, story: last.story, image: last.image || null, tally: last.tally, refused: last.refused, entries: last.entries,
        moved: last.moved, worldTrace: last.worldTrace,
        at: { n: last.n, year: last.year, month: last.month } }
    : { story: '已接上你上次的进度。', first: true };
}

async function resume(id) {
  try {
    const d = await api(`/api/load?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
    run = { id, state: d.state };
    refFor = null; $('#ref').open = false; $('#ref-body').innerHTML = '';
    localStorage.setItem(RUN_KEY, id);
    renderPlay(lastOf(d.state));
    go('play');
  } catch (e) { toast(e.message); }
}

/* ── 起 ────────────────────────────────── */
(async () => {
  try { await loadYears(); } catch (e) { $('#grid').innerHTML = `<p class="wait">年份加载失败：${esc(e.message)}</p>`; }
  const rid = localStorage.getItem(RUN_KEY);
  if (rid && token) {
    try {
      const d = await api(`/api/load?id=${encodeURIComponent(rid)}&token=${encodeURIComponent(token)}`);
      if (d.status === 'playing') {
        run = { id: rid, state: d.state };
        renderPlay(lastOf(d.state));
        go('play');
        toast('已接上上次的进度');
      } else localStorage.removeItem(RUN_KEY);
    } catch (e) { localStorage.removeItem(RUN_KEY); }
  }
})();
