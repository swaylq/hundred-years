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
  const r = await fetch(path, opts);
  let j = null;
  try { j = await r.json(); } catch (e) { /* 下面按状态码报 */ }
  if (!r.ok) throw Object.assign(new Error((j && j.error) || `出错了（${r.status}）`), { body: j });
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
      b.appendChild(el('span', '', String(y)));
      if (info.switch) b.appendChild(el('i', 'sw'));
      const say = !info.ready ? `${y} 年还没写好，先挑别的年份。`
        : !canStart ? `从 ${y} 年起走不满二十四个月——最晚只能从 2024 年 1 月开局。`
        : `${y} · ${info.city}${info.era ? ' —— ' + info.era : ''}` + (info.switch ? `（${info.switch.month} 月换钱）` : '');
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
  head.innerHTML = `<div class="big">${y}</div><div class="era">正在翻到这一年…</div>`;
  $('#year-body').innerHTML = ''; $('#months').innerHTML = ''; $('#start-box').hidden = true;
  $('#mo-detail').textContent = '点一个月。带红点的月份，那个月出过事。';
  let d;
  try { d = await api('/api/year?y=' + y); }
  catch (e) { head.innerHTML = `<div class="big">${y}</div><div class="era">${esc(e.message)}</div>`; return; }
  picked = y; pickedMonth = null;
  const c = d.card;

  head.innerHTML =
    `<div class="big">${y}</div>
     <div class="era">${esc(c.era)}</div>
     <div class="mood">${esc(c.economy.mood)}（${esc(c.economy.number)}）</div>
     <div class="chips">
       <span class="chip">落在${esc(d.city)}</span>
       <span class="chip chip-top">一个月的顶：约 ${d.ceiling} 年的收入</span>
       ${d.switch ? `<span class="chip chip-sw">${d.switch.month} 月换钱</span>` : ''}
     </div>`;

  const body = $('#year-body'); body.innerHTML = '';
  body.appendChild(el('div', 'flavor', c.flavor));
  if (d.switch) body.appendChild(el('div', 'warn', `这一年 ${d.switch.month} 月 ${d.switch.day} 日换钱：${d.switch.say}`));

  body.appendChild(blockList('这一年在发生什么', (c.events || []).map(e => [`${e.month} 月`, e.text])));
  body.appendChild(blockPrices('东西什么价', c.prices || []));
  body.appendChild(blockList('挣钱的路子', (c.money || []).map(m => [m.way, `${m.who}，做到头一个月约 ${m.ceiling}`])));
  body.appendChild(blockList('这一年干不了的事', (c.forbidden || []).map(f => [f.what, f.why])));
  body.appendChild(blockTags('手边有的', (c.tech['日常'] || []).concat(c.tech['稀罕'] || []), false));
  body.appendChild(blockTags('这一年还没有', c.tech['没有'] || [], true));
  body.appendChild(blockList('说来就来的祸事', (c.risks || []).map(r => [r.what, r.hit])));

  const mo = $('#months'); mo.innerHTML = '';
  const info = (years || []).find(x => x.year === y) || {};
  const ok = new Set(info.startMonths || d.months.map(m => m.month));
  for (const m of d.months) {
    const b = el('button', 'mo');
    b.innerHTML = `<span class="n">${m.month}</span><i class="dot${m.events.length ? '' : ' off'}"></i>`;
    b.disabled = !ok.has(m.month);
    b.title = b.disabled ? '从这个月起走不满二十四个月' : (m.events.join('；') || '这个月没什么大事');
    b.addEventListener('click', () => pickMonth(m, b));
    mo.appendChild(b);
  }
  $('#start').textContent = `动身去 ${y} 年`;
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
    b.appendChild(el('p', 'hint', '价钱底下的小字，是这个数从哪儿来的、是不是估的。'));
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
  $$('.mo').forEach(x => x.classList.remove('on'));
  btn.classList.add('on');
  const ev = m.events.length ? `这个月的事：${m.events.join('；')}。` : '这个月没什么大事。';
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
    if (k >= a0 && k <= t) sw.push(`${y.year} 年 ${y.switch.month} 月${y.switch.day > 1 ? `（${y.switch.day} 日，那个月底折）` : ''}换钱`);
  }
  $('#mo-detail').innerHTML =
    `<b>${picked} 年 ${m.month} 月</b>起，一直走到 <b>${to}</b>，一共二十四个月。手里的钱是${esc(m.currency)}。<br>` +
    `你揣着 ${esc(m.startCash)} 落地——那时候一个普通人一年挣 ${esc(m.incomeText)}。<br>${esc(ev)}` +
    (sw.length ? `<br><b>这两年里会换钱：${esc(sw.join('；'))}</b>——攥着现钞的那天会被收走大半，换成东西的躲得过。` : '');
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
  if (!pickedMonth) return toast('先挑一个月');
  const btn = $('#start'); const was = btn.textContent;
  btn.disabled = true; btn.textContent = '正在落地…';
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
  box.appendChild(el('p', 'hint', '正在翻…'));
  try {
    const d = await api('/api/year?y=' + year);
    const c = d.card;
    box.innerHTML = '';
    box.appendChild(blockPrices('东西什么价', c.prices || []));
    box.appendChild(blockList('挣钱的路子', (c.money || []).map(m => [m.way, `${m.who}，做到头约 ${m.ceiling}`])));
    box.appendChild(blockList('干不了的事', (c.forbidden || []).map(f => [f.what, f.why])));
    box.appendChild(blockTags('这一年还没有', c.tech['没有'] || [], true));
    refFor = year;
  } catch (e) { box.innerHTML = ''; box.appendChild(el('p', 'hint', '翻不开：' + e.message)); }
}
$('#ref').addEventListener('toggle', () => { if ($('#ref').open && run) loadRef(run.state.year); });

/* ── 玩 ────────────────────────────────── */
/* 跟 engine.js 的 unitOf() / moneyIn() 一个写法，只在读档时给没带 text 的分录用。
   一组数共用一个单位，同一张账单上不许一行写「万」下一行写光数目。 */
const UNITS = [{ min: 1e12, div: 1e12, name: '万亿' }, { min: 1e8, div: 1e8, name: '亿' }, { min: 1e4, div: 1e4, name: '万' }, { min: 0, div: 1, name: '' }];
const unitOf = nums => { const big = Math.max(0, ...[].concat(nums).map(n => Math.abs(Number(n)) || 0)); const u = UNITS.find(x => big >= x.min); return { ...u, dp: u.div > 1 || big < 100 ? 2 : 0 }; };
const moneyIn = (n, unit, cur) => `${(n / unit.div).toFixed(unit.dp)} ${unit.name}${cur || '元'}`;
const fmtMoney = (n, cur) => moneyIn(n, unitOf(n), cur);

function renderPlay(last, opts = {}) {
  const s = run.state;
  const now = Math.min(s.n, s.months);
  const done = !!s.finished || s.n > s.months;
  const st = s.standing || {};
  const traits = ((s.memo || {}).traits || []).filter(t => !t.lost);

  /* 左边那一栏：日历页、二十四道刻度、家底、四条杠 */
  const meter = (k, cls) => `<div class="meter ${cls}"><span>${k}</span><i><b style="width:${Number(st[k]) || 0}%"></b></i><em>${Number(st[k]) || 0}</em></div>`;
  const ticks = Array.from({ length: s.months }, (_, i) =>
    `<i class="${i < s.n - 1 || done ? 'on' : (i === s.n - 1 ? 'now' : '')}"></i>`).join('');
  const subs = [`现金 <b>${esc(s.cashText)}</b>`];
  if (s.assets && s.assets.length) subs.push(`家当 <b>${s.assets.map(a => esc(a.name) + ' ' + esc(a.worthText)).join('，')}</b>`);
  if (s.debts && s.debts.length) subs.push(`欠着 <b>${s.debts.map(d => esc(d.who) + ' ' + esc(d.amountText)).join('，')}</b>`);
  $('#play-bar').innerHTML =
    `<div class="cal">
       <div class="cal-top">${s.year} 年</div>
       <div class="cal-num${opts.flip ? ' flip' : ''}">${MONTHS[s.month - 1]}</div>
       <div class="cal-foot"><span class="of">第 ${now} / ${s.months} 个月</span> · ${esc(s.city)}</div>
     </div>
     <div class="ticks" style="grid-template-columns:repeat(${Math.min(s.months, 30)},1fr)">${ticks}</div>
     <div class="money"><span class="lab">家底</span><b class="cash">${esc(s.netWorthText)}</b><div class="sub">${subs.join('<br>')}</div></div>
     <div class="meters">${meter('体力', 'm-body')}${meter('名声', 'm-name')}${meter('关系', 'm-ties')}${st.麻烦 > 0 ? meter('麻烦', 'm-trouble') : ''}</div>` +
    /* 他这两年练出来、挣下来的——这一栏是自由度看得见的地方，比四条杠更该占位置 */
    (traits.length ? `<div class="traits"><span class="lab">这两年练出来的</span>${
      traits.map(t => `<i title="${esc((t.notes || []).map(x => x.note).join('；'))}">${esc(t.what)}</i>`).join('')}</div>` : '') +
    (s.persona ? `<div class="who-line">${esc(s.persona)}</div>` : '');

  /* 正文 */
  const box = $('#play-story'); box.innerHTML = '';
  box.classList.toggle('fresh', !!opts.flip);
  const at = last.at || prevMonthOf(s);
  box.appendChild(el('div', 'day-head', last.head || (last.first
    ? `你落在了 ${s.year} 年 ${s.month} 月的${s.city}`
    : `第 ${at.n} 个月 · ${at.year} 年 ${at.month} 月`)));
  box.appendChild(el('p', '', last.story || ''));
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
      w.appendChild(el('b', '', '这个月换钱了'));
      const ul = el('ul'); ul.appendChild(el('li', '', `${sw.say} 你手里的 ${sw.before} 换成了 ${sw.after}。`));
      w.appendChild(ul); box.appendChild(w);
    }
  }
  if (last.moved && last.moved.to) {
    box.appendChild(el('div', 'note', `这个月你从${last.moved.from}到了${last.moved.to}，往后的日子在那儿过。`));
  }
  if (last.refused && last.refused.length) {
    const w = el('div', 'refused');
    w.appendChild(el('b', '', '这几件事没办成'));
    const ul = el('ul');
    for (const r of last.refused) ul.appendChild(el('li', '', `${r.what} — ${r.why}`));
    w.appendChild(ul); box.appendChild(w);
  }
  if (last.capped) box.appendChild(el('div', 'note', '这个月挣得超过了那一年一个月能挣到的顶，多出来的没算进去。'));
  if (last.overspent) box.appendChild(el('div', 'note', `兜里的钱不够，有 ${last.overspent} 的开销没花成。`));
  if (last.local) box.appendChild(el('div', 'note', '这个月没经过大模型，是照固定的规矩粗算的' + (last.why ? `（${last.why}）` : '') + '。'));

  /* 写清单 */
  $('#list').disabled = done;
  $('#write-label').textContent = done
    ? `${s.months} 个月过完了。`
    : `第 ${s.n} 个月 · ${s.year} 年 ${s.month} 月。这个月打算做什么？`;
  const send = $('#send'); send.classList.remove('busy');
  if (done) { send.disabled = false; send.textContent = s.phase === 'extra' ? '这些年走完了，去算总账' : '两年到了，去算账'; send.onclick = settle; }
  else { send.disabled = countHan($('#list').value) === 0; send.textContent = '就这么过这一个月'; send.onclick = sendMonth; }

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
  const 在身上 = (m.traits || []).filter(t => !t.lost).length;
  $('#memo-sum').textContent = `这一局记着的事 · ${(m.trail || []).length} 个月 · ${(m.people || []).length} 个人`
    + (在身上 ? ` · ${在身上} 样本事` : '') + (open.length ? ` · ${open.length} 件没了结` : '');

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
    body.appendChild(el('h4', 'memo-h', '这两年练出来、挣下来的'));
    for (const t of tr) {
      body.appendChild(el('div', 'memo-who' + (t.lost ? ' lost' : ''),
        t.what + (t.lost ? `（第 ${t.first}–${t.lost} 个月有过，后来没了）` : '')));
      for (const x of (t.notes || [])) {
        const r = el('div', 'row');
        r.appendChild(el('span', 'd', `第 ${x.n} 个月`));
        r.appendChild(el('span', 't', x.note));
        body.appendChild(r);
      }
    }
  }
  block('还没了结的', open.map(t => [`第 ${t.opened} 个月起`, t.what + (t.note ? ` —— ${t.note}` : '')]));
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
  if (closed.length) block('了结过的', closed.map(t => [`第 ${t.done} 个月`, t.what]));
  if ((m.folded || []).length) block('更早还有', [['', m.folded.join('、')]]);
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
  btn.disabled = true; btn.textContent = '换…';
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

/* 正文边写边往屏幕上落。一个月的正文三五百字，一次性等它写完要十几秒，
   流式的话第一句话两秒就到，人不会以为卡住了。 */
function beginStream(at) {
  const box = $('#play-story'); box.innerHTML = '';
  box.classList.remove('fresh');
  box.appendChild(el('div', 'day-head', `第 ${at.n} 个月 · ${at.year} 年 ${at.month} 月`));
  const p = el('p', 'live', '');
  box.appendChild(p);
  return p;
}

async function sendMonth() {
  const list = $('#list').value;
  const n = countHan(list);
  const lim = run.state.listLimit || 500;
  if (n === 0) return toast('先写下这个月要做的事');
  if (n > lim) return toast(`超了 ${n - lim} 个字`);
  const send = $('#send');
  send.disabled = true; send.textContent = '这个月正在过'; send.classList.add('busy');
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
      let say = 'HTTP ' + r.status;
      try { say = (await r.json()).error || say; } catch (e) {}
      throw new Error(say);
    }
    let d = null;
    if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
      const p = beginStream(at);
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
          if (em[1] === 'story') { story += data.t; p.textContent = story; }
          else if (em[1] === 'redo') { story = ''; p.textContent = ''; }   // 半路断了，等兜底那份
          else if (em[1] === 'error') throw new Error(data.error || '这个月算不出来');
          else if (em[1] === 'done') d = data;
        }
      }
      if (!d) throw new Error('这个月算到一半断了，再点一次');
    } else {
      d = await r.json();
    }
    run.state = d.state;
    $('#list').value = ''; $('#count').textContent = `0 / ${d.state.listLimit} 字`; $('#count').classList.remove('over');
    renderPlay(d, { flip: true });
    goTop();
    if (d.done) toast(d.state.phase === 'extra' ? '这些年走完了，去算总账' : '两年到了，去算账');
  } catch (e) {
    toast(e.message);
    /* 出错了别把半截正文留在屏幕上——把上个月那一屏重画回来 */
    renderPlay(lastOf(run.state));
    send.disabled = false; send.textContent = '就这么过这一个月'; send.classList.remove('busy');
  }
}

/* ── 结算 ──────────────────────────────── */
async function settle() {
  const send = $('#send');
  send.disabled = true; send.textContent = '算账中'; send.classList.add('busy');
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
    send.textContent = run.state.phase === 'extra' ? '这些年走完了，去算总账' : '两年到了，去算账';
    send.classList.remove('busy');
  }
}

/* 成绩单那张卡。结算页和详情页共用一张。 */
function scoreCard(r, ranks, opts = {}) {
  const yrs = (r.score < 0 ? '−' : '') + Math.abs(r.score).toFixed(2);
  const card = el('div', 'score-card' + (opts.extra ? ' extra' : ''));
  card.appendChild(el('div', 'who', `${r.nick} · ${r.year} 年 ${r.month} 月 → ${r.endYear} 年 ${r.endMonth} 月 · ${r.city}`));
  card.appendChild(el('div', 'num' + (r.yearEarned < 0 ? ' neg' : ''), r.yearEarnedText));
  card.appendChild(el('div', 'unit', `${opts.extra ? `这 ${(r.months / 12).toFixed(0)} 年` : '两年'}净赚，用 ${r.year} 年那时候的钱算`));
  const yearsEl = el('div', 'years');
  yearsEl.innerHTML = `抵得上那时候一个普通人 <b>${yrs}</b> 年的收入`;
  card.appendChild(yearsEl);
  const rank = el('div', 'rank');
  if (opts.extra) {
    rank.innerHTML = `后传榜第 <b>${ranks?.rankExtra ?? '—'}</b> 名（共 ${ranks?.ofExtra ?? '—'} 局）<br><span class="rk-note">接着走下去的局单独排一张榜，不进总榜</span>`;
  } else {
    rank.innerHTML = `${r.year} 年榜第 <b>${ranks?.rankYear ?? '—'}</b> 名（共 ${ranks?.ofYear ?? '—'} 局）<br>总榜第 <b>${ranks?.rankWorld ?? '—'}</b> 名（共 ${ranks?.ofWorld ?? '—'} 局）`;
  }
  card.appendChild(rank);
  const stamp = el('div', 'stamp', opts.extra ? '后传' : '账已结'); stamp.setAttribute('aria-hidden', 'true');
  card.appendChild(stamp);
  return card;
}

/* 成绩单下面那张明细表 */
function scoreKv(r) {
  const yrs = (r.score < 0 ? '−' : '') + Math.abs(r.score).toFixed(2);
  const kv = el('div', 'kv');
  const rows = [
    ['开局本钱', r.startCashText || fmtMoney(r.startCash, r.currencyName)],
    ['收工家底', r.endWorthText || fmtMoney(r.endWorth, r.currencyName)],
    ['一个普通人一年挣', r.incomeText || fmtMoney(r.income, r.currencyName)],
    ['相当于几年的收入', yrs + ' 年'],
    ['换成当年的美元', r.usdThen != null ? fmtUsdCN(r.usdThen) : '—'],
    ['按世界经济折到今天', r.worldUsdText || '—'],
    ['这一局的上限', (Math.round(r.ceiling * 10) / 10) + ' 年的收入'],
    ['走完的月数', (r.months || 0) + ' 个月'],
  ];
  for (const [k, v] of rows) { const d = el('div'); d.appendChild(el('span', '', k)); d.appendChild(el('b', '', v)); kv.appendChild(d); }
  return kv;
}

function renderDone(r, ranks, months, opts = {}) {
  const extra = opts.phase === 'extra';
  const b = $('#done-body'); b.innerHTML = '';
  b.appendChild(scoreCard(r, ranks, { extra }));
  b.appendChild(scoreKv(r));
  if (r.capHits > 0) b.appendChild(el('p', 'note', `有 ${r.capHits} 个月挣得超过了那一年一个月能挣到的顶，多出来的没算。`));
  if (r.cappedTotal) b.appendChild(el('p', 'note', `这一局撞到了整局的上限（${Math.round(r.ceiling * 10) / 10} 年的收入），超出的部分没算进去。`));

  const rev = $('#done-review'); rev.innerHTML = '';
  if (opts.review) renderReview(rev, opts.review);

  renderExtendBox(r, opts);

  /* 回头看走过的日子。一个文字游戏打完不给人读一遍，等于没写过。
     放在「再来一局」下面——二十几条列表压在按钮上头的话，按钮就跑到屏幕外去了。 */
  const dbox = $('#done-days'); dbox.innerHTML = '';
  if (months && months.length) {
    dbox.appendChild(el('h3', 'mh', extra ? '这些年' : '这两年'));
    dbox.appendChild(el('p', 'hint', '点开哪个月，看那个月写了什么、发生了什么。'));
    monthCards(dbox, months, { mainMonths: 24 });
  }
}

/* 一个月一张折叠卡。结算页和详情页共用。 */
function monthCards(box, months, opts = {}) {
  const cut = opts.mainMonths || 24;
  months.forEach((d, i) => {
    if (d.n === cut + 1) {
      const line = el('div', 'extra-cut');
      line.appendChild(el('b', '', '往下这些是后传'));
      line.appendChild(el('span', '', '两年的账在上面那一刻就结了，后面走多久都不改它。'));
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
    dbx.appendChild(el('div', 'mylist', '你写的：' + (d.list || '')));
    dbx.appendChild(el('p', '', d.story || ''));
    if (d.say && d.tally) dbx.appendChild(el('div', 'note', d.tally));
    if (d.moved && d.moved.to) dbx.appendChild(el('div', 'note', `这个月你从${d.moved.from}到了${d.moved.to}。`));
    if (d.refused && d.refused.length) {
      const w = el('div', 'refused');
      w.appendChild(el('b', '', '没办成'));
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
  box.appendChild(el('div', 'rev-cap', '收梢'));
  box.appendChild(el('h3', 'rev-title', rv.title || '这些日子'));
  if (rv.became) box.appendChild(el('p', 'rev-became', rv.became));
  const v = el('div', 'rev-text');
  for (const seg of String(rv.verdict || '').split('\n')) if (seg.trim()) v.appendChild(el('p', '', seg.trim()));
  box.appendChild(v);
  if (rv.turns && rv.turns.length) {
    const t = el('div', 'rev-turns');
    t.appendChild(el('b', '', '拐弯的那几个月'));
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
    m.appendChild(el('b', '', '那一年你没走的一条路'));
    m.appendChild(el('p', '', rv.missed));
    box.appendChild(m);
  }
  if (rv.local) box.appendChild(el('p', 'note', '这一篇没经过大模型，是照账上的数拼的。'));
}

async function fetchReview(id, extra, into) {
  const box = into || $('#done-review');
  box.innerHTML = '';
  box.appendChild(el('div', 'rev-wait', extra ? '正在给这些年写一篇收梢…' : '正在给这两年写一篇收梢…'));
  try {
    const d = await post('/api/review', { id, token, extra: !!extra });
    renderReview(box, d.review);
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(el('p', 'note', '收梢没写出来：' + e.message));
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
    box.appendChild(el('h3', 'mh', '两年那一刻的成绩'));
    box.appendChild(el('p', 'hint', m
      ? `${m.yearEarnedText}，抵得上一个普通人 ${m.score.toFixed(2)} 年的收入。那一份封在两年结账的那一刻，总榜和年榜上的名次没有跟着后面这几年动过。`
      : '两年那一刻的成绩封在结账的那一刻，总榜和年榜上的名次没有跟着后面这几年动过。'));
    return;
  }
  const id = opts.id || (run && run.id);
  if (!id) { box.hidden = true; return; }
  const room = Number(opts.extraRoom || 0);
  box.appendChild(el('h3', 'mh', '还想接着走下去？'));
  if (!room) {
    box.appendChild(el('p', 'hint', '年卡只写到 2025 年 12 月，这一局已经走到那儿了，接不下去。'));
    return;
  }
  box.appendChild(el('p', 'hint', `两年的账已经结了，${r.year} 年榜和总榜上的名次就定在这儿，往后再走多少年都不会变。` +
    `你可以接着往下走 ${roomText(room)}，走完另算一笔总账，上后传榜。`));
  const btn = el('button', 'primary', `接着走下去（还能走 ${roomText(room)}）`);
  btn.addEventListener('click', () => extendRun(btn, room, id));
  box.appendChild(btn);
}

async function extendRun(btn, room, id) {
  btn.disabled = true; btn.classList.add('busy'); btn.textContent = '接上…';
  try {
    const d = await post('/api/extend', { id, token });
    run = { id, state: d.state };
    localStorage.setItem(RUN_KEY, id);
    renderPlay({
      head: '接着走下去',
      story: `两年的账结过了，那一笔谁也改不了。你没走，接着在${d.state.city}过下去——往后还有 ${roomText(d.room)}。`,
      switched: d.switched, options: d.state.options,
    }, { flip: true });
    go('play');
  } catch (e) {
    toast(e.message);
    btn.disabled = false; btn.classList.remove('busy'); btn.textContent = `接着走下去（还能走 ${roomText(room)}）`;
  }
}

/* ── 一局的详情 ────────────────────────── */
let detailBack = 'mine', detailMine = false;
async function openDetail(id, back, mine) {
  detailBack = back || 'mine';
  detailMine = !!mine;
  const box = $('#detail-body');
  box.innerHTML = '<p class="wait">正在翻这一局…</p>';
  go('detail');
  try {
    renderDetail(await api('/api/detail?id=' + encodeURIComponent(id)), id);
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(el('p', 'empty', '看不了这一局：' + e.message));
  }
}

function renderDetail(d, id) {
  const box = $('#detail-body'); box.innerHTML = '';
  const r = d.result;
  box.appendChild(el('h2', 'det-h', `${d.nick} 的 ${r.year} 年`));
  if (d.persona) box.appendChild(el('p', 'det-who', `他是这么个人：${d.persona}`));

  box.appendChild(scoreCard(r, d.rank, {}));
  box.appendChild(scoreKv(r));

  if (d.review) { const w = el('div', 'review'); renderReview(w, d.review); box.appendChild(w); }
  else if (detailMine) {
    /* 自己的局、还没写过收梢——补写一篇 */
    const w = el('div', 'review'); box.appendChild(w);
    const b = el('button', 'ghost-btn', '写一篇收梢');
    b.addEventListener('click', () => { b.remove(); fetchReview(id, false, w); });
    box.appendChild(b);
  }

  /* 后传：接着走下去的那一段，另算一笔账 */
  if (d.extraStatus === 'done' && d.extraResult) {
    box.appendChild(el('h3', 'mh', '后传'));
    box.appendChild(el('p', 'hint', '两年结完账之后接着走的那些年。上面那份成绩是封住的，这一份单独上后传榜。'));
    box.appendChild(scoreCard(d.extraResult, d.extraRank, { extra: true }));
    box.appendChild(scoreKv(d.extraResult));
    if (d.extraReview) { const w = el('div', 'review'); renderReview(w, d.extraReview); box.appendChild(w); }
  } else if (d.extraStatus === 'playing') {
    box.appendChild(el('p', 'note', `这一局还在走后传——两年之后又接着走了 ${Math.max(0, d.months.length - d.mainMonths)} 个月，还没收工。`));
    if (detailMine) {
      const b = el('button', 'primary', '接着往下走');
      b.addEventListener('click', () => resume(id));
      box.appendChild(b);
    }
  } else if (detailMine && !d.extraStatus) {
    /* 结过账、还没接后传，而且是自己的局：在这儿也能接下去 */
    const w = el('div', 'more-box'); box.appendChild(w);
    renderExtendBox(r, { into: w, id, extraRoom: d.extraRoom });
  }

  if (d.months && d.months.length) {
    box.appendChild(el('h3', 'mh', d.months.length > d.mainMonths ? '一个月一个月走过来' : '这两年'));
    monthCards(box, d.months, { mainMonths: d.mainMonths });
  }
}
$('#detail-back').addEventListener('click', () => go(detailBack));

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
    ? `后传榜。两年的账结完之后又接着往下走的那些局，最多再走五年，走完另算一笔总账。` +
      `<b>他们不在总榜里</b>——多走几年的人跟只走两年的人比不到一块儿去。` +
      `每个人两年那一刻的成绩仍旧封在总榜上，没有跟着后面这几年变。`
    : boardYear
    ? `${boardYear} 年的榜。只跟这一年的人比。` +
      `排序按<b>当年那种钱净赚多少</b>——一年之内用的是同一种钱，比得干净。`
    : `总榜。先按<b>当年的汇率</b>把钱换成当年的美元。` +
      `再按<b>世界经济长了多少</b>折到今天。` +
      `1930 年赚一千美元是什么概念？那时候整个世界只有今天的二十一分之一。` +
      `折过来就是两万多。想跟同一年的人比，点下面的年份。`;

  const tabs = $('#board-tabs'); tabs.innerHTML = '';
  const mk = (label, y, scope) => {
    const on = (scope || 'world') === boardScope && (scope === 'extra' || y === boardYear);
    const b = el('button', on ? 'on' : '', label);
    b.addEventListener('click', () => { boardScope = scope || 'world'; boardYear = y; loadBoard(); });
    return b;
  };
  tabs.appendChild(mk('总榜', null));
  tabs.appendChild(mk('后传榜', null, 'extra'));
  for (const r of (d.yearsWithRuns || [])) tabs.appendChild(mk(`${r.year} 年（${r.n}）`, r.year));

  const box = $('#board-body'); box.innerHTML = '';
  if (!d.rows.length) {
    box.appendChild(el('p', 'empty', boardScope === 'extra'
      ? '还没有人走完过后传。打完两年之后，在结算页点「接着走下去」。'
      : boardYear ? `${boardYear} 年还没人打完过。` : '还没有人打完过一局。你来当第一个。'));
    const act = el('div', 'empty-act'); const btn = el('button', 'ghost-btn', '去挑一年');
    btn.addEventListener('click', () => go('pick')); act.appendChild(btn); box.appendChild(act);
    return;
  }
  const t = el('table', 'board');
  t.innerHTML = boardScope === 'extra'
    ? '<thead><tr><th></th><th>名号</th><th>开局年月</th><th class="c">落点</th><th class="c">走了多久</th><th style="text-align:right">折成今天</th></tr></thead>'
    : boardYear
    ? '<thead><tr><th></th><th>名号</th><th>月</th><th class="c">落点</th><th style="text-align:right">净赚</th></tr></thead>'
    : '<thead><tr><th></th><th>名号</th><th>开局年月</th><th class="c">落点</th><th class="c">这一局的顶</th><th style="text-align:right">折成今天</th></tr></thead>';
  const tb = el('tbody');
  for (const r of d.rows) {
    const tr = el('tr');
    const mark = r.capped ? '<span class="cap" title="撞到了这一年的上限">顶</span>' : '';
    tr.innerHTML = boardScope === 'extra'
      ? `<td class="r">${r.rank}</td><td>${esc(r.nick)}${mark}</td>
         <td class="y">${r.year}.${String(r.month).padStart(2, '0')}</td>
         <td class="c">${esc(r.city || '')}</td>
         <td class="c y">${Math.round((r.months || 0) / 12 * 10) / 10} 年</td>
         <td class="s">${esc(r.worldUsdText || '')}</td>`
      : boardYear
      ? `<td class="r">${r.rank}</td><td>${esc(r.nick)}${mark}</td>
         <td class="y">${r.month} 月</td><td class="c">${esc(r.city || '')}</td>
         <td class="s">${esc(r.yearEarnedText || '')}</td>`
      : `<td class="r">${r.rank}</td><td>${esc(r.nick)}${mark}</td>
         <td class="y">${r.year}.${String(r.month).padStart(2, '0')}</td>
         <td class="c">${esc(r.city || '')}</td>
         <td class="c y">${r.ceiling != null ? r.ceiling + ' 年' : ''}</td>
         <td class="s">${esc(r.worldUsdText || '')}</td>`;
    /* 每一行点得进去，读别人那两年是怎么过的 */
    if (r.id) { tr.classList.add('mine-go'); tr.addEventListener('click', () => openDetail(r.id, 'board')); }
    tb.appendChild(tr);
  }
  t.appendChild(tb); box.appendChild(t);
  box.appendChild(el('p', 'hint', (boardScope === 'extra'
    ? '「走了多久」算上前面那两年。'
    : boardYear
    ? '「顶」是撞到了这一年现实上限的那些局——那一年最多就能赚这么多。'
    : '「那一年的顶」是白手起家的人在那一年最多能赚到几年的收入。年份不同，这个数差得很远。') +
    '点哪一行，看那一局是怎么过的。'));
}

/* ── 我的局 ────────────────────────────── */
async function loadMine() {
  const box = $('#mine-body'); box.innerHTML = '';
  const empty = () => {
    box.appendChild(el('p', 'empty', '还没开过局。'));
    const act = el('div', 'empty-act'); const btn = el('button', 'ghost-btn', '去挑一年');
    btn.addEventListener('click', () => go('pick')); act.appendChild(btn); box.appendChild(act);
  };
  if (!token) return empty();
  const d = await api('/api/mine?token=' + encodeURIComponent(token));
  if (!d.rows.length) return empty();
  const t = el('table', 'board');
  t.innerHTML = '<thead><tr><th>年月</th><th>名号</th><th>走到哪了</th><th style="text-align:right">几年的收入</th></tr></thead>';
  const tb = el('tbody');
  for (const r of d.rows) {
    const tr = el('tr');
    /* 按天走三十天的老局接不上新规矩了，标一下，也别让人点进去 */
    const old = r.mode && r.mode !== 'months24';
    const done = r.status === 'done';
    /* 三种下场：还在过前两年、结完账了、结完账又接着走后传 */
    const where = old ? '按天走的老局'
      : r.extra_status === 'playing' ? '在走后传'
      : r.extra_status === 'done' ? '后传也走完了'
      : done ? '算过账了' : '还在过';
    const sc = r.extra_status === 'done' && r.extra_score != null ? r.extra_score : r.score;
    tr.innerHTML = `<td class="y">${r.year}.${String(r.month).padStart(2, '0')}</td><td>${esc(r.nick)}</td>
      <td>${where}${done && !old ? '<span class="go-in">看详情 ›</span>' : ''}</td>
      <td class="s">${sc == null ? '—' : (Math.abs(sc) < 10 ? sc.toFixed(2) : sc.toFixed(1))}</td>`;
    if (!old && r.extra_status === 'playing') { tr.classList.add('mine-go'); tr.addEventListener('click', () => resume(r.id)); }
    else if (!old && done) { tr.classList.add('mine-go'); tr.addEventListener('click', () => openDetail(r.id, 'mine', true)); }
    else if (!old) { tr.classList.add('mine-go'); tr.addEventListener('click', () => resume(r.id)); }
    tb.appendChild(tr);
  }
  t.appendChild(tb); box.appendChild(t);
  box.appendChild(el('p', 'hint', '还在过的那一局，点一下接着走；结过账的点进去看详情，也能在那儿接着往下走。'));
}

function lastOf(state) {
  const last = state.recent && state.recent.length ? state.recent[state.recent.length - 1] : null;
  return last
    ? { story: last.story, tally: last.tally, refused: last.refused, entries: last.entries,
        at: { n: last.n, year: last.year, month: last.month } }
    : { story: '接着上次走。', first: true };
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
  try { await loadYears(); } catch (e) { $('#grid').innerHTML = `<p class="wait">读不到年份：${esc(e.message)}</p>`; }
  const rid = localStorage.getItem(RUN_KEY);
  if (rid && token) {
    try {
      const d = await api(`/api/load?id=${encodeURIComponent(rid)}&token=${encodeURIComponent(token)}`);
      if (d.status === 'playing') {
        run = { id: rid, state: d.state };
        renderPlay(lastOf(d.state));
        go('play');
        toast('接着上次那一局走');
      } else localStorage.removeItem(RUN_KEY);
    } catch (e) { localStorage.removeItem(RUN_KEY); }
  }
})();
