'use strict';
/* 《这一百年》的前端。没有打包器，一个文件。 */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

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
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (name === 'board') loadBoard();
  if (name === 'mine') loadMine();
}
$$('[data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));

/* ── 一百年的格子 ──────────────────────── */
async function loadYears() {
  const d = await api('/api/years');
  years = d.years;
  const g = $('#grid'); g.innerHTML = '';
  let decade = null;
  for (const y of years) {
    const dec = Math.floor(y.year / 10) * 10;
    if (dec !== decade) { decade = dec; g.appendChild(el('div', 'decade', `${dec} 年代`)); }
    const b = el('button', 'yr d' + heat(y.ceiling));
    b.disabled = !y.ready;
    b.appendChild(el('span', '', String(y.year)));
    b.appendChild(el('i', 'heat'));
    if (y.switch) b.appendChild(el('i', 'sw'));
    b.title = y.ready
      ? `${y.city} · ${y.era || ''}\n三十天里最多赚到约 ${y.ceiling} 年的收入` + (y.switch ? `\n${y.switch.month} 月换钱` : '')
      : '这一年的背景还没写好';
    b.addEventListener('click', () => openYear(y.year));
    g.appendChild(b);
  }
}
/* 红杠的深浅按现在的上限分档。上限重定之后最高才 20 年，
   老档位（60/20/4）里最深那一档永远用不到，8 年的 1926 和 18 年的 2015 一模一样深。 */
const heat = c => c >= 14 ? 3 : c >= 7 ? 2 : c >= 2 ? 1 : 0;

/* ── 一年的详情 ────────────────────────── */
async function openYear(y) {
  go('year');
  $('#year-head').innerHTML = `<div class="big">${y}</div><div class="era">读取中…</div>`;
  $('#year-body').innerHTML = ''; $('#months').innerHTML = ''; $('#start-box').hidden = true;
  let d;
  try { d = await api('/api/year?y=' + y); } catch (e) { $('#year-head').innerHTML = `<div class="big">${y}</div><div class="era">${esc(e.message)}</div>`; return; }
  picked = y; pickedMonth = null;
  const c = d.card;

  $('#year-head').innerHTML =
    `<div class="big">${y}</div>
     <div class="era">${esc(c.era)}</div>
     <div class="meta">落在${esc(d.city)} · ${esc(c.economy.mood)}（${esc(c.economy.number)}） · 三十天里最多赚到约 ${d.ceiling} 年的收入</div>`;

  const body = $('#year-body'); body.innerHTML = '';
  body.appendChild(el('div', 'flavor', c.flavor));

  if (d.switch) {
    body.appendChild(el('div', 'warn', `这一年 ${d.switch.month} 月 ${d.switch.day} 日换钱：${d.switch.say}`));
    body.appendChild(el('div', 'block'));
  }

  body.appendChild(blockList('这一年在发生什么', (c.events || []).map(e => [`${e.month} 月`, e.text])));
  body.appendChild(blockPrices('东西什么价', c.prices || []));
  body.appendChild(blockList('挣钱的路子', (c.money || []).map(m => [m.way, `${m.who}，做到头约 ${m.ceiling}`])));
  body.appendChild(blockList('这一年干不了的事', (c.forbidden || []).map(f => [f.what, f.why])));
  body.appendChild(blockTags('手边有的', (c.tech['日常'] || []).concat(c.tech['稀罕'] || []), false));
  body.appendChild(blockTags('这一年还没有', c.tech['没有'] || [], true));
  body.appendChild(blockList('说来就来的祸事', (c.risks || []).map(r => [r.what, r.hit])));

  const mo = $('#months'); mo.innerHTML = '';
  for (const m of d.months) {
    const b = el('button', 'mo');
    b.innerHTML = `<span class="n">${m.month}</span><i class="dot${m.events.length ? '' : ' off'}"></i>`;
    b.title = m.events.join('；') || '这个月没什么大事';
    b.addEventListener('click', () => pickMonth(m, b, d));
    mo.appendChild(b);
  }
  if (!$('#mo-detail')) { const p = el('div', 'mo-detail'); p.id = 'mo-detail'; mo.after(p); }
  $('#mo-detail').textContent = '选一个月。有小点的月份，那个月出了事。';
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
  for (const p of rows) { const d = el('div'); d.appendChild(el('span', '', p.item)); d.appendChild(el('b', '', p.price)); g.appendChild(d); }
  b.appendChild(g); return b;
}
function blockTags(title, items, no) {
  const b = el('div', 'block'); b.appendChild(el('h4', '', title));
  const r = el('div', 'tagrow');
  for (const t of items) r.appendChild(el('span', 'tag' + (no ? ' no' : ''), t));
  b.appendChild(r); return b;
}

function pickMonth(m, btn, d) {
  pickedMonth = m.month;
  $$('.mo').forEach(x => x.classList.remove('on'));
  btn.classList.add('on');
  const ev = m.events.length ? m.events.join('；') : '这个月没什么大事。';
  $('#mo-detail').textContent = `${picked} 年 ${m.month} 月 · 手里是${m.currency} · 开局本钱 ${m.startCash}（一个普通人一年挣 ${m.incomeText}）。${ev}`;
  $('#start-box').hidden = false;
}

$('#start').addEventListener('click', async () => {
  if (!pickedMonth) return toast('先选个月份');
  $('#start').disabled = true;
  try {
    const nick = $('#nick').value.trim();
    const d = await post('/api/run', { year: picked, month: pickedMonth, nick });
    token = d.token; localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(RUN_KEY, d.id);
    run = { id: d.id, state: d.state };
    refFor = null; $('#ref').open = false; $('#ref-body').innerHTML = '';
    renderPlay({ story: d.flavor, tally: '', refused: [], first: true });
    go('play');
  } catch (e) { toast(e.message); }
  $('#start').disabled = false;
});

/* 玩的时候也要翻得到这一年的物价和禁忌——
   人在写今天做什么，总得知道一斤米多少钱、什么事碰不得。 */
let refFor = null;
async function loadRef(year) {
  if (refFor === year) return;
  const box = $('#ref-body'); box.innerHTML = '';
  box.appendChild(el('p', 'hint', '读取中…'));
  try {
    const d = await api('/api/year?y=' + year);
    const c = d.card;
    box.innerHTML = '';
    box.appendChild(blockPrices('东西什么价', c.prices || []));
    box.appendChild(blockList('挣钱的路子', (c.money || []).map(m => [m.way, `${m.who}，做到头约 ${m.ceiling}`])));
    box.appendChild(blockList('干不了的事', (c.forbidden || []).map(f => [f.what, f.why])));
    box.appendChild(blockTags('这一年还没有', c.tech['没有'] || [], true));
    refFor = year;
  } catch (e) { box.innerHTML = ''; box.appendChild(el('p', 'hint', '读不到：' + esc(e.message))); }
}
$('#ref').addEventListener('toggle', () => { if ($('#ref').open && run) loadRef(run.state.year); });

/* ── 玩 ────────────────────────────────── */
function renderPlay(last) {
  const s = run.state;
  $('#play-bar').innerHTML =
    `<span class="date">${s.year} 年 ${s.month} 月 ${Math.min(s.day, s.days)} 日</span>
     <span class="of">第 ${Math.min(s.day, s.days)} / ${s.days} 天</span>
     <span class="cash">家底 <b>${esc(s.netWorthText)}</b></span>
     <span class="prog"><i style="width:${Math.min(100, (s.day - 1) / s.days * 100)}%"></i></span>
     <span class="st">体力 ${s.standing.体力} · 名声 ${s.standing.名声} · 关系 ${s.standing.关系}${s.standing.麻烦 > 0 ? ` · 麻烦 ${s.standing.麻烦}` : ''}</span>`;

  const st = $('#play-story'); st.innerHTML = '';
  st.appendChild(el('div', 'day-num', last.first ? `${s.year} 年 ${s.month} 月，${esc(s.city)}` : `第 ${s.day - 1} 天`));
  st.appendChild(el('p', '', last.story || ''));
  if (last.entries && last.entries.length) {
    const t = el('div', 'tally');
    for (const e of last.entries) {
      const r = el('div', 'e' + (e.amount < 0 ? ' out' : ''));
      r.appendChild(el('span', '', e.what));
      r.appendChild(el('b', '', (e.amount >= 0 ? '+' : '−') + e.text.replace('-', '')));
      t.appendChild(r);
    }
    st.appendChild(t);
  } else if (last.tally) st.appendChild(el('div', 'tally', last.tally));

  if (last.switched && last.switched.length) {
    for (const sw of last.switched) {
      const w = el('div', 'refused');
      w.appendChild(el('b', '', '换钱了'));
      const ul = el('ul'); ul.appendChild(el('li', '', `${sw.say} 你手里的 ${sw.before} 换成了 ${sw.after}。`));
      w.appendChild(ul); st.appendChild(w);
    }
  }
  if (last.refused && last.refused.length) {
    const w = el('div', 'refused');
    w.appendChild(el('b', '', '这几件事没办成'));
    const ul = el('ul');
    for (const r of last.refused) ul.appendChild(el('li', '', `${r.what} — ${r.why}`));
    w.appendChild(ul); st.appendChild(w);
  }
  if (last.capped) st.appendChild(el('div', 'note', '今天赚得超过了这一年一天能赚到的顶，多出来的没算进去。'));
  if (last.overspent) st.appendChild(el('div', 'note', `兜里的钱不够，有 ${last.overspent} 的开销没花成。`));
  if (last.local) st.appendChild(el('div', 'note', '这一天是本地算的，没走模型' + (last.why ? `（${last.why}）` : '') + '。'));

  const done = !!s.finished || s.day > s.days;
  $('#list').disabled = done;
  $('#send').disabled = done ? false : countHan($('#list').value) === 0;
  $('#write-label').textContent = done ? '三十天走完了' : `第 ${s.day} 天，今天打算做什么`;
  $('#send').textContent = done ? '去结算' : '过完这一天';
  if (done) { $('#send').disabled = false; $('#send').onclick = settle; }
  else $('#send').onclick = sendDay;

  const lb = $('#ledger-body'); lb.innerHTML = '';
  for (const d of (s.recent || []).slice().reverse()) {
    const r = el('div', 'row');
    r.appendChild(el('span', 'd', `第${d.day}天`));
    r.appendChild(el('span', 't', d.tally || (d.story || '').slice(0, 40)));
    lb.appendChild(r);
  }
  $('#ledger').hidden = !(s.recent && s.recent.length);
}

const countHan = s => (String(s).match(/[一-鿿]/g) || []).length;
$('#list').addEventListener('input', () => {
  const n = countHan($('#list').value);
  const lim = (run && run.state.listLimit) || 500;
  const c = $('#count');
  c.textContent = `${n} / ${lim}`;
  c.classList.toggle('over', n > lim);
  $('#send').disabled = n === 0 || n > lim;
});

async function sendDay() {
  const list = $('#list').value;
  const n = countHan(list);
  if (n === 0) return toast('写点什么再走');
  if (n > (run.state.listLimit || 500)) return toast(`超了 ${n - run.state.listLimit} 个字`);
  $('#send').disabled = true; $('#send').textContent = '算这一天…';
  try {
    const d = await post('/api/day', { id: run.id, token, list });
    run.state = d.state;
    $('#list').value = ''; $('#count').textContent = `0 / ${d.state.listLimit}`; $('#count').classList.remove('over');
    renderPlay(d);
    /* 滚到今天这一段的开头。不滚的话，页面还停在昨天写清单的位置，
       新出来的正文有一半藏在顶栏后面，读者一睁眼是半句话。 */
    const bar = $('#play-bar').getBoundingClientRect().height + 66;
    const y = $('#play-story').getBoundingClientRect().top + window.scrollY - bar;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    if (d.done) toast('三十天走完了，去结算');
  } catch (e) {
    toast(e.message);
    $('#send').disabled = false; $('#send').textContent = '过完这一天';
  }
}

/* ── 结算 ──────────────────────────────── */
async function settle() {
  $('#send').disabled = true; $('#send').textContent = '结算中…';
  try {
    const d = await post('/api/settle', { id: run.id, token });
    renderDone(d.result, d, d.days);
    localStorage.removeItem(RUN_KEY);
    go('done');
  } catch (e) { toast(e.message); $('#send').disabled = false; $('#send').textContent = '去结算'; }
}

function renderDone(r, ranks, days) {
  const b = $('#done-body'); b.innerHTML = '';
  const card = el('div', 'score-card');
  card.innerHTML =
    `<div class="who">${esc(r.nick)} · ${r.year} 年 ${r.month} 月 · ${esc(r.city)}</div>
     <div class="num${r.yearEarned < 0 ? ' neg' : ''}">${esc(r.yearEarnedText)}</div>
     <div class="unit">三十天净赚 —— 用 ${r.year} 年那时候的钱算</div>
     <div class="rank">
       ${r.year} 年榜第 <b>${ranks.rankYear}</b> 名（${ranks.ofYear} 局）
       &nbsp;·&nbsp; 总榜第 <b>${ranks.rankWorld}</b> 名（${ranks.ofWorld} 局）
     </div>`;
  b.appendChild(card);

  const kv = el('div', 'kv');
  const rows = [
    ['开局本钱', r.startCashText || fmtMoney(r.startCash, r.currencyName)],
    ['收工家底', r.endWorthText || fmtMoney(r.endWorth, r.currencyName)],
    ['那一年一个人一年挣', r.incomeText || fmtMoney(r.income, r.currencyName)],
    ['相当于几年的收入', (r.score < 0 ? '−' : '') + Math.abs(r.score).toFixed(2) + ' 年'],
    ['换成当年的美元', r.usdThen != null ? fmtUsdCN(r.usdThen) : '—'],
    ['按世界经济折到今天', r.worldUsdText || '—'],
    ['这一年的现实上限', r.ceiling + ' 年的收入'],
    ['走完的天数', r.days + ' 天'],
  ];
  for (const [k, v] of rows) { const d = el('div'); d.appendChild(el('span', '', k)); d.appendChild(el('b', '', v)); kv.appendChild(d); }
  b.appendChild(kv);
  if (r.capHits > 0) b.appendChild(el('p', 'note', `有 ${r.capHits} 天赚得超过了这一年一天能赚到的顶，多出来的没算。`));
  if (r.cappedTotal) b.appendChild(el('p', 'note', `这一局撞到了 ${r.year} 年的现实上限（${r.ceiling} 年的收入），超出的部分没算进去。`));

  /* 回头看这三十天。一个文字游戏打完不给人读一遍，等于没写过。
     放在「再来一局」下面——三十条列表压在按钮上头的话，按钮就跑到屏幕外去了。 */
  const dbox = $('#done-days'); dbox.innerHTML = '';
  if (days && days.length) {
    dbox.appendChild(el('h3', 'mh', '这三十天'));
    dbox.appendChild(el('p', 'hint', '点开哪一天，看那天写了什么、发生了什么。'));
    for (const d of days) {
      const det = el('details', 'day');
      const sum = el('summary');
      sum.appendChild(el('b', 'dn', `第 ${d.day} 天`));
      sum.appendChild(el('span', 'dt', d.tally || ''));
      det.appendChild(sum);
      const box = el('div', 'daybox');
      box.appendChild(el('div', 'mylist', '你写的：' + (d.list || '')));
      box.appendChild(el('p', '', d.story || ''));
      if (d.refused && d.refused.length) {
        const w = el('div', 'refused');
        w.appendChild(el('b', '', '没办成'));
        const ul = el('ul');
        for (const x of d.refused) ul.appendChild(el('li', '', `${x.what} — ${x.why}`));
        w.appendChild(ul); box.appendChild(w);
      }
      det.appendChild(box);
      dbox.appendChild(det);
    }
  }
}
const fmtUsdCN = n => {
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e8) return `${s}${(a / 1e8).toFixed(2)} 亿美元`;
  if (a >= 1e4) return `${s}${(a / 1e4).toFixed(1)} 万美元`;
  if (a >= 100) return `${s}${Math.round(a).toLocaleString('en-US')} 美元`;
  return `${s}${a.toFixed(2)} 美元`;
};
const fmtMoney = (n, unit) => (Math.abs(n) >= 1e8 ? (n / 1e8).toFixed(2) + ' 亿' : Math.abs(n) >= 1e4 ? (n / 1e4).toFixed(2) + ' 万' : Math.abs(n) >= 100 ? Math.round(n) : n.toFixed(2)) + ' ' + (unit || '元');

/* ── 排行榜 ──────────────────────────────
   两层：总榜按「折成今天的美元」排，年榜只跟同一年的人比。 */
let boardYear = null;
async function loadBoard() {
  const d = await api('/api/board?limit=50' + (boardYear ? '&year=' + boardYear : ''));

  $('#board-note').innerHTML = boardYear
    ? `${boardYear} 年的榜。只跟这一年的人比。` +
      `排序按<b>当年那种钱净赚多少</b>——一年之内用的是同一种钱，比得干净。`
    : `总榜。先按<b>当年的汇率</b>把钱换成当年的美元。` +
      `再按<b>世界经济长了多少</b>折到今天。` +
      `1930 年赚一千美元是什么概念？那时候整个世界只有今天的二十一分之一。` +
      `折过来就是两万多。想跟同一年的人比，点下面的年份。`;

  const tabs = $('#board-tabs'); tabs.innerHTML = '';
  const mk = (label, y) => {
    const b = el('button', y === boardYear ? 'on' : '', label);
    b.addEventListener('click', () => { boardYear = y; loadBoard(); });
    return b;
  };
  tabs.appendChild(mk('总榜', null));
  for (const r of (d.yearsWithRuns || [])) tabs.appendChild(mk(`${r.year} 年（${r.n}）`, r.year));

  const box = $('#board-body'); box.innerHTML = '';
  if (!d.rows.length) {
    box.appendChild(el('p', 'empty', boardYear ? `${boardYear} 年还没人打完过。` : '还没有人打完过一局。'));
    return;
  }
  const t = el('table', 'board');
  t.innerHTML = boardYear
    ? '<thead><tr><th></th><th>名号</th><th>月</th><th class="c">落点</th><th style="text-align:right">净赚</th></tr></thead>'
    : '<thead><tr><th></th><th>名号</th><th>年月</th><th class="c">落点</th><th class="c">那一年的顶</th><th style="text-align:right">折成今天</th></tr></thead>';
  const tb = el('tbody');
  for (const r of d.rows) {
    const tr = el('tr');
    const mark = r.capped ? '<span class="cap" title="撞到了这一年的上限">顶</span>' : '';
    tr.innerHTML = boardYear
      ? `<td class="r">${r.rank}</td><td>${esc(r.nick)}${mark}</td>
         <td class="y">${r.month} 月</td><td class="c">${esc(r.city || '')}</td>
         <td class="s">${esc(r.yearEarnedText || '')}</td>`
      : `<td class="r">${r.rank}</td><td>${esc(r.nick)}${mark}</td>
         <td class="y">${r.year}.${String(r.month).padStart(2, '0')}</td>
         <td class="c">${esc(r.city || '')}</td>
         <td class="c y">${r.ceiling != null ? r.ceiling + ' 年' : ''}</td>
         <td class="s">${esc(r.worldUsdText || '')}</td>`;
    tb.appendChild(tr);
  }
  t.appendChild(tb); box.appendChild(t);
  box.appendChild(el('p', 'hint', boardYear
    ? '「顶」是撞到了这一年现实上限的那些局——那一年最多就能赚这么多。'
    : '「那一年的顶」是白手起家的人在那一年最多能赚到几年的收入。年份不同，这个数差得很远。'));
}

/* ── 我的局 ────────────────────────────── */
async function loadMine() {
  const box = $('#mine-body'); box.innerHTML = '';
  if (!token) { box.appendChild(el('p', 'empty', '还没开过局。')); return; }
  const d = await api('/api/mine?token=' + encodeURIComponent(token));
  if (!d.rows.length) { box.appendChild(el('p', 'empty', '还没开过局。')); return; }
  const t = el('table', 'board');
  t.innerHTML = '<thead><tr><th>年月</th><th>名号</th><th>状态</th><th style="text-align:right">分数</th></tr></thead>';
  const tb = el('tbody');
  for (const r of d.rows) {
    const tr = el('tr');
    tr.innerHTML = `<td class="y">${r.year}.${String(r.month).padStart(2, '0')}</td><td>${esc(r.nick)}</td>
      <td>${r.status === 'done' ? '已结算' : '还在走'}</td>
      <td class="s">${r.score == null ? '—' : (Math.abs(r.score) < 10 ? r.score.toFixed(2) : r.score.toFixed(1))}</td>`;
    if (r.status !== 'done') { tr.style.cursor = 'pointer'; tr.addEventListener('click', () => resume(r.id)); }
    tb.appendChild(tr);
  }
  t.appendChild(tb); box.appendChild(t);
  box.appendChild(el('p', 'hint', '点没走完的那一局可以接着走。'));
}

async function resume(id) {
  try {
    const d = await api(`/api/load?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
    run = { id, state: d.state };
    refFor = null; $('#ref').open = false; $('#ref-body').innerHTML = '';
    localStorage.setItem(RUN_KEY, id);
    const last = d.state.recent && d.state.recent.length ? d.state.recent[d.state.recent.length - 1] : null;
    renderPlay(last ? { story: last.story, tally: last.tally, refused: last.refused } : { story: '接着走。', first: true });
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
        const last = d.state.recent && d.state.recent.length ? d.state.recent[d.state.recent.length - 1] : null;
        renderPlay(last ? { story: last.story, tally: last.tally, refused: last.refused } : { story: '接着走。', first: true });
        go('play');
        toast('接着上次那一局走');
      } else localStorage.removeItem(RUN_KEY);
    } catch (e) { localStorage.removeItem(RUN_KEY); }
  }
})();
