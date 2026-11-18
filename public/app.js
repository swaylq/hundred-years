'use strict';
/* 《这一百年》的前端 — 掌上画报与旧年历账册。无打包器，单文件直出。 */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TOKEN_KEY = 'hy.token';
const TOKENS_KEY = 'hy.tokens';
const RUN_KEY = 'hy.run';
const THEME_KEY = 'hy.theme';

function readTokens() {
  const set = new Set();
  const main = localStorage.getItem(TOKEN_KEY) || '';
  if (main) set.add(main);
  try {
    const arr = JSON.parse(localStorage.getItem(TOKENS_KEY) || '[]');
    if (Array.isArray(arr)) for (const x of arr) if (typeof x === 'string' && x) set.add(x);
  } catch (e) {}
  return [...set];
}
function addToken(t, setPrimary = false) {
  for (const one of String(t || '').split(',')) {
    const clean = one.trim();
    if (!clean) continue;
    const list = readTokens();
    if (!list.includes(clean)) list.unshift(clean);
    localStorage.setItem(TOKENS_KEY, JSON.stringify(list.slice(0, 20)));
    if (setPrimary || !localStorage.getItem(TOKEN_KEY)) localStorage.setItem(TOKEN_KEY, clean);
  }
  token = readTokens().join(',');
}
const primaryToken = () => localStorage.getItem(TOKEN_KEY) || readTokens()[0] || '';
let token = readTokens().join(',');

let years = [];
let selectedYear = null;
let currentEra = 'all';
let picked = null;
let pickedMonth = null;
let yearCardCache = new Map();
let run = null;
let boardMode = 'world';
let boardScope = 'world';
let boardYear = null;
let lastPosterCtx = null;
let voice = null;

/* ── 主题切换（浅暖纸 / 深墨纸） ─────────────────────────── */
const YEAR_ART_V = '1';
const yearArtUrl = y => (Number(y) >= 1926 && Number(y) <= 2025) ? `/assets/years/${Number(y)}.webp?v=${YEAR_ART_V}` : null;
const yearThumbUrl = y => (Number(y) >= 1926 && Number(y) <= 2025) ? `/assets/years/thumb/${Number(y)}.webp?v=${YEAR_ART_V}` : null;

const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function animatePanel(node, cls = 'panel-in-up') {
  if (!node || reducedMotion()) return;
  node.classList.remove('panel-in-l', 'panel-in-r', 'panel-in-up');
  void node.offsetWidth;
  node.classList.add(cls);
  node.addEventListener('animationend', () => node.classList.remove(cls), { once: true });
}

const MODAL_IDS = new Set(['sheet-bg', 'poster-modal', 'comic-modal']);
function syncModalScrollLock() {
  const locked = ['#sheet-bg', '#poster-modal', '#comic-modal'].some(sel => {
    const n = $(sel);
    return n && !n.hidden && n.dataset.state !== 'closing';
  });
  document.body.classList.toggle('modal-open', locked);
}

const overlayTimers = new WeakMap();
function showOverlay(node) {
  if (!node) return;
  const prev = overlayTimers.get(node);
  if (prev) { clearTimeout(prev); overlayTimers.delete(node); }
  node.hidden = false;
  if (reducedMotion()) {
    node.dataset.state = 'open';
    if (MODAL_IDS.has(node.id)) syncModalScrollLock();
    return;
  }
  delete node.dataset.state;
  void node.offsetWidth;
  node.dataset.state = 'open';
  if (MODAL_IDS.has(node.id)) syncModalScrollLock();
}
function hideOverlay(node, ms = 180) {
  if (!node || node.hidden) return;
  const prev = overlayTimers.get(node);
  if (prev) { clearTimeout(prev); overlayTimers.delete(node); }
  if (reducedMotion()) {
    delete node.dataset.state;
    node.hidden = true;
    if (MODAL_IDS.has(node.id)) syncModalScrollLock();
    return;
  }
  node.dataset.state = 'closing';
  if (MODAL_IDS.has(node.id)) syncModalScrollLock();
  const t = setTimeout(() => {
    overlayTimers.delete(node);
    if (node.dataset.state === 'closing') {
      delete node.dataset.state;
      node.hidden = true;
      if (MODAL_IDS.has(node.id)) syncModalScrollLock();
    }
  }, ms);
  overlayTimers.set(node, t);
}

let themeSwitchT = null;
function applyTheme(theme, animate = false) {
  const t = theme === 'dark' ? 'dark' : 'light';
  if (animate && !reducedMotion()) {
    document.documentElement.classList.add('theme-switching');
    clearTimeout(themeSwitchT);
    themeSwitchT = setTimeout(() => document.documentElement.classList.remove('theme-switching'), 260);
  }
  document.body.dataset.theme = t;
  localStorage.setItem(THEME_KEY, t);
  const btn = $('#btn-theme');
  if (btn) {
    const label = t === 'dark' ? '切回浅色暖纸' : '切到深色墨纸';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#272522' : '#f3eee4');
}
applyTheme(localStorage.getItem(THEME_KEY) || 'light', false);
$('#btn-theme').addEventListener('click', () => {
  applyTheme(document.body.dataset.theme === 'dark' ? 'light' : 'dark', true);
});

/* ── 网络与轻提示 ───────────────────────────────────────── */
async function api(path, opts) {
  let r;
  try { r = await fetch(path, opts); }
  catch (e) { throw new Error('连接失败，请检查网络后重试。'); }
  let j = null;
  try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw Object.assign(new Error((j && j.error) || `请求失败，请稍后重试（${r.status}）`), { body: j });
  return j;
}
const post = (p, b) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

let toastT = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  showOverlay(t);
  clearTimeout(toastT);
  toastT = setTimeout(() => hideOverlay(t, 160), 3400);
}

/* ── 换屏（方向感知双相过渡 + 滚动位还原） ─────────────────── */
const NAV_ORDER = { pick: 0, year: 0, play: 1, done: 1, board: 2, mine: 3, detail: 2.5 };
const TR_ALL = [
  'is-leaving',
  'tr-in-push', 'tr-out-push',
  'tr-in-pop', 'tr-out-pop',
  'tr-in-tab-r', 'tr-out-tab-r',
  'tr-in-tab-l', 'tr-out-tab-l',
  'tr-in-fade', 'tr-out-fade',
];
const screenScroll = new Map();
let screenLeaveT = null;
let screenEnterT = null;

function resolveTransition(from, to) {
  if (!from || from === to) return 'fade';
  if (
    (from === 'pick' && to === 'year') ||
    (from === 'year' && to === 'play') ||
    (from === 'play' && to === 'done') ||
    (from === 'done' && to === 'play') ||
    ((from === 'board' || from === 'mine') && to === 'detail')
  ) return 'push';
  if (
    (from === 'year' && to === 'pick') ||
    (from === 'detail' && (to === 'board' || to === 'mine')) ||
    (from === 'done' && to === 'pick')
  ) return 'pop';
  const a = NAV_ORDER[from], b = NAV_ORDER[to];
  if (a != null && b != null && a !== b) return b > a ? 'tab-r' : 'tab-l';
  return 'fade';
}

function flashNavProgress() {
  const bar = $('#nav-progress');
  if (!bar || reducedMotion()) return;
  bar.classList.remove('run');
  void bar.offsetWidth;
  bar.classList.add('run');
}

function syncNavPlay() {
  const navPlay = $('#nav-play');
  if (navPlay) navPlay.hidden = !run;
}

function go(name, opts = {}) {
  if (name !== 'play' && voice && voice.isActive()) voice.cancel();
  const prevName = document.body.dataset.screen || 'pick';
  const prevScreenId = prevName === 'mine' ? 'board' : prevName;
  const targetScreen = name === 'mine' ? 'board' : name;
  const dir = opts.dir || resolveTransition(prevName, name);

  screenScroll.set(prevName, window.scrollY);
  const targetY = (dir === 'pop' && !opts.top && screenScroll.has(name))
    ? (screenScroll.get(name) || 0)
    : 0;

  const oldEl = $('#s-' + prevScreenId);
  const newEl = $('#s-' + targetScreen);

  if (prevScreenId !== targetScreen && newEl) {
    const oldY = window.scrollY;
    const mainEl = $('.app-main');
    const padTop = mainEl ? (parseFloat(getComputedStyle(mainEl).paddingTop) || 16) : 16;

    clearTimeout(screenLeaveT);
    clearTimeout(screenEnterT);
    $$('.screen').forEach(s => {
      s.classList.remove(...TR_ALL);
      s.style.top = '';
      s.style.maxHeight = '';
      s.style.overflow = '';
      if (s !== newEl) s.classList.remove('on');
    });
    newEl.classList.add('on');
    window.scrollTo({ top: targetY, behavior: 'instant' });
    const newY = window.scrollY;

    if (!opts.instant && !reducedMotion() && oldEl && oldEl !== newEl) {
      oldEl.style.top = `${padTop + newY - oldY}px`;
      oldEl.style.maxHeight = `${Math.max(240, oldY + window.innerHeight - padTop)}px`;
      oldEl.style.overflow = 'hidden';
      oldEl.classList.add('is-leaving', `tr-out-${dir}`);
      newEl.classList.add(`tr-in-${dir}`);
      flashNavProgress();
      screenLeaveT = setTimeout(() => {
        oldEl.classList.remove(...TR_ALL);
        oldEl.style.top = '';
        oldEl.style.maxHeight = '';
        oldEl.style.overflow = '';
      }, 230);
      screenEnterT = setTimeout(() => {
        newEl.classList.remove(...TR_ALL);
      }, 320);
    }
  } else {
    $$('.screen').forEach(s => s.classList.toggle('on', s.id === 's-' + targetScreen));
    if (prevName !== name) flashNavProgress();
    window.scrollTo({ top: targetY, behavior: 'instant' });
  }

  $$('#top .nav-links button[data-go]').forEach(b => {
    const k = b.dataset.go;
    const active = k === name || (name === 'year' && k === 'pick') || (name === 'detail' && k === detailBack);
    b.classList.toggle('on', active);
  });
  document.body.dataset.screen = name;
  if (name === 'board') { setBoardMode('world', { animate: prevScreenId === 'board' && prevName !== 'board' }); loadBoard(); }
  if (name === 'mine') { setBoardMode('mine', { animate: prevScreenId === 'board' && prevName !== 'mine' }); loadMine(); }
}

$$('[data-go]').forEach(b => b.addEventListener('click', () => {
  const fromNav = !!b.closest('#top');
  go(b.dataset.go, fromNav ? { top: true } : {});
}));

/* ── 1. 选择年份（焦点年份舞台 + 百年画卷墙） ─────────────── */
const ERA_RANGES = {
  all: [1926, 2025],
  1926: [1926, 1949],
  1950: [1950, 1977],
  1978: [1978, 2008],
  2009: [2009, 2025],
};
const ERA_LABELS = [
  [1926, 1949, '民国风云'],
  [1950, 1977, '建国岁月'],
  [1978, 2008, '改开浪潮'],
  [2009, 2025, '近年流光'],
];
const eraNameOf = y => {
  const hit = ERA_LABELS.find(([a, b]) => y >= a && y <= b);
  return hit ? hit[2] : '百年';
};
const heat = c => c >= 14 ? 3 : c >= 7 ? 2 : c >= 2 ? 1 : 0;
const isStartableYear = info => !!(info && info.ready && (info.startMonths || []).length > 0);

function renderSpotlight(info) {
  const box = $('#pick-spotlight');
  if (!info || !box) { if (box) box.hidden = true; return; }
  selectedYear = info.year;
  box.hidden = false;
  $$('#grid .y-card.sel').forEach(x => x.classList.remove('sel'));
  const hitCard = $(`#grid .y-card[data-year="${info.year}"]`);
  if (hitCard) hitCard.classList.add('sel');

  const media = box.querySelector('.spot-media');
  const img = $('#sp-img');
  const art = yearArtUrl(info.year);
  if (art && img.getAttribute('src') !== art) {
    media.classList.add('fade');
    img.onload = () => media.classList.remove('fade');
    img.onerror = () => media.classList.remove('fade');
    img.src = art;
    img.alt = `${info.year} 年 ${info.city}`;
    if (img.complete && img.naturalWidth > 0) media.classList.remove('fade');
  }

  const badges = [`<span class="spot-badge">${esc(eraNameOf(info.year))}</span>`];
  if (heat(info.ceiling) >= 2) badges.push('<span class="spot-badge seal">机缘高</span>');
  if (info.switch) badges.push(`<span class="spot-badge">${info.switch.month} 月换币</span>`);
  $('#sp-badges').innerHTML = badges.join('');

  $('#sp-year').textContent = `${info.year} 年`;
  $('#sp-city').textContent = info.city || '';
  $('#sp-era').textContent = info.era || '点击进入挑选开局月份。';
  $('#sp-enter').textContent = `进入 ${info.year} 年 →`;
}

function renderYearGrid(era = 'all') {
  currentEra = era;
  const [a, b] = ERA_RANGES[era] || [1926, 2025];
  const g = $('#grid');
  g.innerHTML = '';
  const list = years.filter(y => y.year >= a && y.year <= b);
  const startableList = list.filter(isStartableYear);

  let spotlightInfo = startableList.find(x => x.year === selectedYear)
    || startableList.find(x => x.year === 1946 || x.year === 1984 || x.year === 1958 || x.year === 2016)
    || startableList[0]
    || null;

  const frag = document.createDocumentFragment();
  list.forEach((info, idx) => {
    const canStart = isStartableYear(info);
    const h = heat(info.ceiling);
    const btn = el('button', 'y-card' + (spotlightInfo && spotlightInfo.year === info.year ? ' sel' : ''));
    btn.type = 'button';
    btn.dataset.year = String(info.year);
    btn.disabled = !canStart;
    btn.setAttribute('aria-label', `${info.year} 年 ${info.city}${info.era ? '，' + info.era : ''}`);
    if (info.era) btn.title = `${info.year} 年 · ${info.city}：${info.era}`;

    const im = el('img');
    im.src = yearThumbUrl(info.year);
    im.alt = '';
    im.decoding = 'async';
    im.loading = idx < 10 ? 'eager' : 'lazy';
    btn.appendChild(im);

    const marks = el('span', 'y-card-marks');
    if (!canStart) {
      marks.appendChild(el('span', 'y-lock', '仅续走'));
    } else {
      if (h >= 2) marks.appendChild(el('i', 'y-dot hot'));
      if (info.switch) marks.appendChild(el('i', 'y-dot sw'));
    }
    if (marks.children.length) btn.appendChild(marks);

    const foot = el('span', 'y-card-foot');
    foot.appendChild(el('strong', 'y-card-year num', String(info.year)));
    foot.appendChild(el('span', 'y-card-city', info.city || ''));
    btn.appendChild(foot);

    if (canStart) {
      btn.addEventListener('click', () => {
        selectedYear = info.year;
        openYear(info.year);
      });
    }
    frag.appendChild(btn);
  });
  g.appendChild(frag);
  renderSpotlight(spotlightInfo);
}

$$('#era-bar button').forEach(b => b.addEventListener('click', () => {
  const was = currentEra;
  $$('#era-bar button').forEach(x => x.classList.remove('on'));
  b.classList.add('on');
  renderYearGrid(b.dataset.era);
  if (was !== b.dataset.era) animatePanel($('#grid'), 'panel-in-up');
}));
$('#sp-enter').addEventListener('click', () => {
  if (selectedYear) openYear(selectedYear);
});
$('#sp-rand').addEventListener('click', () => {
  const [a, b] = ERA_RANGES[currentEra] || [1926, 2025];
  const pool = years.filter(y => y.year >= a && y.year <= b && isStartableYear(y));
  if (!pool.length) return;
  const others = pool.length > 1 ? pool.filter(x => x.year !== selectedYear) : pool;
  const pick = others[Math.floor(Math.random() * others.length)];
  if (pick) renderSpotlight(pick);
});

async function loadYears() {
  const d = await api('/api/years');
  years = d.years || [];
  renderYearGrid(currentEra);
}

/* ── 2. 选月开局（年份封面英雄卡 + 零滚动直达启程） ─────────── */
async function fetchYearData(y) {
  if (yearCardCache.has(y)) return yearCardCache.get(y);
  const d = await api('/api/year?y=' + y);
  yearCardCache.set(y, d);
  return d;
}

function updateYearStepButtons(y) {
  const startable = (years || []).filter(isStartableYear);
  const idx = startable.findIndex(x => x.year === y);
  const prevBtn = $('#btn-prev-year');
  const nextBtn = $('#btn-next-year');
  const prev = idx > 0 ? startable[idx - 1] : null;
  const next = idx >= 0 && idx < startable.length - 1 ? startable[idx + 1] : null;
  if (prevBtn) {
    prevBtn.hidden = !prev;
    if (prev) {
      prevBtn.textContent = `‹ ${prev.year}`;
      prevBtn.onclick = () => openYear(prev.year, { flip: 'prev' });
    }
  }
  if (nextBtn) {
    nextBtn.hidden = !next;
    if (next) {
      nextBtn.textContent = `${next.year} ›`;
      nextBtn.onclick = () => openYear(next.year, { flip: 'next' });
    }
  }
}

async function openYear(y, opts = {}) {
  selectedYear = y;
  const infoRow = (years || []).find(x => x.year === y);
  if (infoRow) renderSpotlight(infoRow);
  updateYearStepButtons(y);
  if (document.body.dataset.screen !== 'year') go('year');
  const hero = $('#year-hero');
  if (opts.flip) animatePanel(hero, opts.flip === 'prev' ? 'panel-in-l' : 'panel-in-r');
  const art = yearArtUrl(y);
  hero.innerHTML =
    `${art ? `<div class="year-hero-media"><img src="${art}" alt="${y} 年风貌"></div>` : ''}
     <div class="year-hero-body">
       <div class="year-hero-top"><span class="year-big num">${y}</span></div>
       <p class="year-line">正在翻开这一年…</p>
     </div>`;
  $('#months').innerHTML = '';
  $('#mo-metrics').hidden = true;
  $('#mo-warn').hidden = true;
  $('#start-box').hidden = true;

  let d;
  try { d = await fetchYearData(y); }
  catch (e) {
    hero.innerHTML =
      `${art ? `<div class="year-hero-media"><img src="${art}" alt="${y} 年风貌"></div>` : ''}
       <div class="year-hero-body">
         <div class="year-hero-top"><span class="year-big num">${y}</span></div>
         <p class="year-line">${esc(e.message)}</p>
       </div>`;
    return;
  }

  picked = y;
  pickedMonth = null;
  const c = d.card;

  const pills = [`<span class="pill">${esc(d.city)}</span>`];
  if (d.switch) pills.push(`<span class="pill pill-seal">${d.switch.month} 月换币</span>`);
  if (d.echoes && d.echoes.length) pills.push(`<span class="pill pill-indigo">同年留痕 ${d.echoes.length}</span>`);

  hero.innerHTML =
    `${art ? `<div class="year-hero-media"><img src="${art}" alt="${y} 年 ${esc(d.city)}"></div>` : ''}
     <div class="year-hero-body">
       <div class="year-hero-top">
         <span class="year-big num">${y}</span>
         <div class="year-pills">${pills.join('')}</div>
       </div>
       <p class="year-line">${esc(c.era || '')}</p>
       ${c.economy && c.economy.mood ? `<p class="year-mood">${esc(c.economy.mood)}</p>` : ''}
       <button class="year-ref-link" id="btn-year-ref" type="button">查阅 ${y} 年物价与世道 ›</button>
     </div>`;
  $('#btn-year-ref').addEventListener('click', () => openSheet('ref', { year: y }));

  const mo = $('#months');
  mo.innerHTML = '';
  const info = (years || []).find(x => x.year === y) || {};
  const ok = new Set(info.startMonths || d.months.map(m => m.month));
  let firstPick = null;
  for (const m of d.months) {
    const b = el('button', 'mo-cell num');
    b.type = 'button';
    b.disabled = !ok.has(m.month);
    b.innerHTML = `${m.month}月${m.events.length ? '<i class="ev-dot"></i>' : ''}`;
    b.setAttribute('aria-pressed', 'false');
    b.title = b.disabled ? '从这个月起走不满 24 个月' : (m.events.join('；') || '城里平稳');
    b.addEventListener('click', () => pickMonth(m, b));
    mo.appendChild(b);
    if (!firstPick && !b.disabled) firstPick = [m, b];
  }
  if (firstPick) pickMonth(firstPick[0], firstPick[1]);
}

function pickMonth(m, btn) {
  pickedMonth = m.month;
  $$('#months .mo-cell').forEach(x => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
  btn.classList.add('on');
  btn.setAttribute('aria-pressed', 'true');

  const a0 = picked * 12 + m.month - 1;
  const t = a0 + 23;
  const sy2 = String(picked).slice(-2);
  const ey2 = String(Math.floor(t / 12)).slice(-2);
  const span = `${sy2}.${String(m.month).padStart(2, '0')} → ${ey2}.${String(t % 12 + 1).padStart(2, '0')}`;
  const evText = m.events.length ? m.events[0] : '城里平稳';

  const met = $('#mo-metrics');
  met.hidden = false;
  met.innerHTML =
    `<div class="mo-m"><span>跨度</span><b class="num">${esc(span)}</b></div>
     <div class="mo-m"><span>开局本钱</span><b class="num">${esc(m.startCash)}</b></div>
     <div class="mo-m" title="${esc(m.events.join('；') || '城里平稳')}"><span>当月大事</span><b>${esc(evText)}</b></div>`;

  const sw = [];
  for (const y of (years || [])) {
    if (!y.switch) continue;
    const k = y.year * 12 + y.switch.month - 1;
    if (k >= a0 && k <= t) sw.push(`${y.year} 年 ${y.switch.month} 月`);
  }
  const warn = $('#mo-warn');
  if (sw.length) {
    warn.hidden = false;
    warn.innerHTML = `<b>这 24 个月内会赶上换币（${esc(sw.join('、'))}）</b>：现金按官方比率折算，囤下的实物家当按市价保值。`;
  } else {
    warn.hidden = true;
  }

  $('#start-box').hidden = false;
  $('#start').textContent = `穿去 ${picked} 年 ${m.month} 月 →`;
}

const HAN = /[\u4e00-\u9fff\u3400-\u4dbf]/gu;
const countHan = s => (String(s || '').match(HAN) || []).length;

$('#persona').addEventListener('input', () => {
  const n = countHan($('#persona').value);
  const el2 = $('#persona-count');
  el2.textContent = `${n} / 50`;
  el2.classList.toggle('over', n > 50);
});

$('#start').addEventListener('click', async () => {
  if (!pickedMonth) return toast('请先挑一个开始的月份');
  const btn = $('#start');
  const was = btn.textContent;
  btn.disabled = true;
  btn.classList.add('busy');
  btn.textContent = '正在开局…';
  try {
    const nick = $('#nick').value.trim();
    const persona = $('#persona').value.trim();
    const d = await post('/api/run', { year: picked, month: pickedMonth, nick, persona, token: primaryToken() });
    addToken(d.token);
    localStorage.setItem(RUN_KEY, d.id);
    run = { id: d.id, state: d.state };
    syncNavPlay();
    renderPlay({
      headline: `${d.state.year} 年 ${d.state.month} 月 · 初到${d.state.city}`,
      summary: d.flavor || `你落脚在 ${d.state.year} 年的${d.state.city}。`,
      story: d.flavor || '',
      tally: '',
      refused: [],
      first: true,
    });
    go('play');
    post('/api/options', { id: d.id, token }).then(r => {
      if (run && run.id === d.id && r.options && r.options.length) {
        run.state.options = r.options;
        renderPicks(r.options);
      }
    }).catch(() => {});
  } catch (e) {
    toast(e.message);
  }
  btn.disabled = false;
  btn.classList.remove('busy');
  btn.textContent = was;
});

/* ── 3. 游玩主屏 ───────────────────────────────────────── */
const UNITS = [{ min: 1e12, div: 1e12, name: '万亿' }, { min: 1e8, div: 1e8, name: '亿' }, { min: 1e4, div: 1e4, name: '万' }, { min: 0, div: 1, name: '' }];
const unitOf = nums => {
  const big = Math.max(0, ...[].concat(nums).map(n => Math.abs(Number(n)) || 0));
  const u = UNITS.find(x => big >= x.min);
  return { ...u, dp: u.div > 1 || big < 100 ? 2 : 0 };
};
const moneyIn = (n, unit, cur) => `${(n / unit.div).toFixed(unit.dp)} ${unit.name}${cur || '元'}`;
const fmtMoney = (n, cur) => moneyIn(n, unitOf(n), cur);
const fmtUsdCN = n => {
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e8) return `${s}${(a / 1e8).toFixed(2)} 亿美元`;
  if (a >= 1e4) return `${s}${(a / 1e4).toFixed(1)} 万美元`;
  if (a >= 100) return `${s}${Math.round(a).toLocaleString('en-US')} 美元`;
  return `${s}${a.toFixed(2)} 美元`;
};

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
  return [...out].filter(w => w.length >= 2).sort((a, b) => b.length - a.length).slice(0, 10);
}

function highlightKeysInHtml(html, keys) {
  if (!keys.length) return html;
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(' + keys.map(escRe).join('|') + ')', 'g');
  return html.replace(re, m => `<b class="story-key">${m}</b>`);
}

function formatStoryInline(rawText, list) {
  const raw = String(rawText || '').trim();
  if (!raw) return '';
  const keys = planKeywords(list);
  let safe = esc(raw);
  if (safe.includes('**')) {
    safe = safe.replace(/\*\*([^*\n]+)\*\*/g, (_, inner) => `<span class="story-hl">${highlightKeysInHtml(inner, keys)}</span>`);
    safe = safe.replace(/\*\*([^*\n]+)$/g, (_, inner) => `<span class="story-hl">${highlightKeysInHtml(inner, keys)}</span>`);
    return safe;
  }
  if (!keys.length) return safe;
  const sents = safe.match(/[^。！？；\n]+[。！？；]?|\n+/g) || [safe];
  const scored = sents.map(s => ({ s, score: keys.filter(k => s.includes(k)).length }));
  const maxScore = Math.max(0, ...scored.map(x => x.score));
  if (maxScore === 0) return safe;
  const threshold = maxScore >= 2 ? 2 : 1;
  return scored.map(({ s, score }) => score >= threshold ? `<span class="story-hl">${highlightKeysInHtml(s, keys)}</span>` : s).join('');
}

function formatParagraphsHtml(rawText, list) {
  const segs = String(rawText || '').split(/\n+/).map(x => x.trim()).filter(Boolean);
  if (!segs.length) return '';
  return segs.map(seg => `<p>${formatStoryInline(seg, list)}</p>`).join('');
}

function clientSummaryOf(d) {
  const sum = String((d && d.summary) || '').trim();
  if (sum) return sum;
  const clean = String((d && d.story) || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const sents = clean.match(/[^。！？\n]+[。！？]?/g) || [clean];
  let out = '';
  for (const s of sents) {
    const t = s.trim();
    if (!t) continue;
    if (out && (out.length + t.length > 96 || (out.length >= 42 && sents.length > 2))) break;
    out += t;
    if (out.length >= 52) break;
  }
  return out || clean.slice(0, 90);
}

function clientHeadlineOf(d, fallback) {
  const h = String((d && d.headline) || '').replace(/\*\*/g, '').trim();
  if (h) return h;
  const src = String((d && (d.summary || d.say || d.story)) || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (!src) return fallback || '';
  const first = src.split(/[。！？；\n]/)[0].trim();
  return first.length <= 24 ? first : first.slice(0, 22);
}

function parseNetInfo(tally, entries, curName) {
  if (entries && entries.length) {
    const sum = entries.reduce((t, e) => t + (Number(e.amount) || 0), 0);
    const unit = unitOf([...entries.map(e => e.amount), sum]);
    const txt = moneyIn(Math.abs(sum), unit, curName);
    return {
      neg: sum < 0,
      chip: sum >= 0 ? `净进 +${txt}` : `净出 −${txt}`,
      short: sum >= 0 ? `+${txt}` : `−${txt}`,
    };
  }
  const m = String(tally || '').match(/(净[进出])\s*([^；]+)$/);
  if (m) {
    const neg = m[1] === '净出';
    const val = m[2].trim();
    return {
      neg,
      chip: `${m[1]} ${neg ? '−' : '+'}${val}`,
      short: `${neg ? '−' : '+'}${val}`,
    };
  }
  return null;
}

function prevMonthOf(s) {
  const last = (s.recent || [])[(s.recent || []).length - 1];
  return last ? { n: last.n, year: last.year, month: last.month } : { n: Math.max(1, s.n - 1), year: s.year, month: s.month };
}

function renderHud(s, netInfo) {
  const now = Math.min(s.n, s.months);
  const done = !!s.finished || s.n > s.months;
  const left = Math.max(0, s.months - (done ? s.months : now - 1));
  const pct = done ? 100 : Math.min(100, Math.round(((now - 1) / Math.max(1, s.months)) * 100));
  const assetCount = (s.assets || []).length + (s.cash > 0 ? 1 : 0);
  const memo = s.memo || {};
  const activeTraits = (memo.traits || []).filter(t => !t.lost).length;
  const openThreads = (memo.threads || []).filter(t => !t.done).length;
  const peopleCount = (memo.people || []).length;
  const memoCount = activeTraits + peopleCount + openThreads;

  const deltaHtml = netInfo
    ? `<small class="num${netInfo.neg ? ' neg' : ''}">上月 ${esc(netInfo.short)}</small>`
    : `<small class="num muted">年入约 ${esc(s.incomeText)}</small>`;
  const ym = `${s.year}.${String(s.month).padStart(2, '0')}`;
  const stepText = s.phase === 'extra' ? `续走第 ${now} / ${s.months} 月` : `第 ${now} / ${s.months} 个月`;
  const rightMeta = done
    ? (s.phase === 'extra' ? '续走期满可算账' : '满两年可算账')
    : `还剩 ${left} 月收官`;

  const bar = $('#play-bar');
  bar.innerHTML =
    `<div class="hud-top">
       <div class="hud-date">
         <strong class="num">${ym}</strong>
         <span>${esc(s.city)}</span>
       </div>
       <div class="hud-worth">
         <strong class="num">${esc(s.netWorthText)}</strong>
         ${deltaHtml}
       </div>
     </div>
     <div class="progress-wrap">
       <div class="progress-meta">
         <span class="num">${stepText}</span>
         <span>${rightMeta}</span>
       </div>
       <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
     </div>
     <div class="hud-tools">
       <button class="hud-tool" type="button" data-sheet="assets">家当 <em class="num">${assetCount}</em></button>
       <button class="hud-tool" type="button" data-sheet="memo">人脉 <em class="num">${memoCount}</em></button>
       <button class="hud-tool" type="button" data-sheet="ref">世道</button>
     </div>`;
  bar.querySelectorAll('[data-sheet]').forEach(btn => {
    btn.addEventListener('click', () => openSheet(btn.dataset.sheet));
  });
}

function renderPlay(last) {
  const s = run.state;
  const done = !!s.finished || s.n > s.months;
  const at = last.at || prevMonthOf(s);
  const recentLast = (s.recent && s.recent.length && !last.first) ? s.recent[s.recent.length - 1] : null;
  const myList = last.list || (recentLast ? recentLast.list : '');
  const entries = last.entries || (recentLast ? recentLast.entries : null);
  const netInfo = last.first ? null : parseNetInfo(last.tally || (recentLast && recentLast.tally), entries, s.currencyName);

  renderHud(s, netInfo);

  const card = $('#play-story');
  card.innerHTML = '';

  const badgeTxt = last.first
    ? `${s.year}.${String(s.month).padStart(2, '0')} · ${s.city}`
    : `第 ${at.n} 月 · ${at.year}.${String(at.month).padStart(2, '0')}`;
  const headline = last.head || clientHeadlineOf(last, badgeTxt);
  const imgUrl = last.image || (recentLast ? recentLast.image : null);
  const fallbackYear = last.first ? s.year : (at && at.year) || s.year;
  const fallbackArt = yearArtUrl(fallbackYear);
  const shouldFetchImg = !imgUrl && !last.first && at && at.n && run && run.id && (last.story || '').length > 10 && last.imagePending !== false;

  if (imgUrl || shouldFetchImg || fallbackArt) {
    const wrap = el('div', 'hero-art-wrap' + (shouldFetchImg ? ' pending' : ''));
    wrap.id = 'month-art-box';
    const showSrc = imgUrl || (shouldFetchImg ? null : fallbackArt);
    if (showSrc) {
      const im = el('img');
      im.src = showSrc;
      im.alt = last.first ? `${s.year} 年 ${s.city}` : `第 ${at.n} 月插画`;
      wrap.appendChild(im);
    } else {
      wrap.appendChild(el('span', 'hero-art-status', '绘图中…'));
    }
    wrap.appendChild(el('span', 'hero-art-badge num', badgeTxt));
    const cap = el('div', 'hero-art-caption');
    cap.appendChild(el('h2', '', headline));
    wrap.appendChild(cap);
    card.appendChild(wrap);
    if (shouldFetchImg) requestMonthImage(run.id, at.n, badgeTxt, headline, fallbackYear);
  } else {
    const th = el('div', 'hero-text-head');
    th.appendChild(el('span', 'hero-text-badge num', badgeTxt));
    th.appendChild(el('h2', '', headline));
    card.appendChild(th);
  }

  /* 3 秒战报胶囊条 + 点击盈亏展开的逐笔账单 */
  const hasEntries = Array.isArray(entries) && entries.length > 0;
  const assetsAdded = last.assetsAdded || (recentLast && recentLast.assetsAdded) || [];
  const pills = [];
  if (last.worldTrace && last.worldTrace.summary) {
    const label = last.worldTrace.kind === 'bond'
      ? `结缘 · ${last.worldTrace.partner || '同行穿越者'}`
      : '时空留痕';
    pills.push(el('span', 'pill pill-indigo', label));
  }
  for (const name of assetsAdded.slice(0, 2)) {
    pills.push(el('span', 'pill', `+ ${name}`));
  }
  if (last.moved && last.moved.to) {
    pills.push(el('span', 'pill', `搬至 · ${last.moved.to}`));
  }
  if (last.switched && last.switched.length) {
    pills.push(el('span', 'pill pill-seal', '本月换币'));
  }

  if (netInfo || pills.length) {
    const strip = el('div', 'result-strip');
    let ledgerBox = null;
    if (netInfo) {
      const chip = el('button', 'chip-btn num' + (netInfo.neg ? ' neg' : ''), netInfo.chip + (hasEntries ? ' ▾' : ''));
      chip.type = 'button';
      if (hasEntries) {
        chip.setAttribute('aria-expanded', 'false');
        chip.addEventListener('click', () => {
          if (!ledgerBox) return;
          const hidden = (ledgerBox.hidden = !ledgerBox.hidden);
          chip.setAttribute('aria-expanded', String(!hidden));
          chip.textContent = netInfo.chip + (hidden ? ' ▾' : ' ▴');
        });
      }
      strip.appendChild(chip);
    }
    for (const p of pills) strip.appendChild(p);
    card.appendChild(strip);

    if (hasEntries) {
      ledgerBox = el('div', 'mini-ledger');
      ledgerBox.hidden = true;
      const unit = unitOf(entries.map(e => e.amount));
      for (const e of entries) {
        const row = el('div', 'ledger-row' + (e.amount < 0 ? ' out' : ''));
        row.appendChild(el('span', '', e.what));
        const text = e.text || moneyIn(e.amount, unit, s.currencyName);
        row.appendChild(el('b', 'num', (e.amount >= 0 ? '+' : '−') + text.replace('-', '')));
        ledgerBox.appendChild(row);
      }
      if (last.overspent) {
        ledgerBox.appendChild(el('div', 'ledger-note', `手头现金不够，有 ${last.overspent} 未能支出。`));
      }
      card.appendChild(ledgerBox);
    }
  }

  /* 精简概要（默认 2–3 句）+ 按需展开完整详情 */
  const storyCard = el('div', 'story-card');
  if (myList && !last.first) {
    const pe = el('div', 'plan-echo');
    pe.innerHTML = `本月打算：<b>${esc(myList)}</b>`;
    storyCard.appendChild(pe);
  }

  const fullStory = String(last.story || '').trim();
  const summaryText = last.first ? fullStory : clientSummaryOf(last);
  const fullHan = countHan(fullStory.replace(/\*\*/g, ''));
  const sumHan = countHan(summaryText.replace(/\*\*/g, ''));
  const canExpand = !last.first && fullStory && fullHan > sumHan + 16;

  const body = el('div', 'story-body');
  body.innerHTML = formatParagraphsHtml(summaryText || fullStory, myList);
  storyCard.appendChild(body);

  if (canExpand) {
    let expanded = false;
    const toggle = el('button', 'story-toggle', `展开本月详情（约 ${fullHan} 字）▾`);
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      expanded = !expanded;
      body.innerHTML = formatParagraphsHtml(expanded ? fullStory : summaryText, myList);
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.textContent = expanded ? '收起详情 ▴' : `展开本月详情（约 ${fullHan} 字）▾`;
    });
    storyCard.appendChild(toggle);
  }

  /* 关键提醒（换币 / 留痕 / 跨时代拦截 / 固定规则兜底） */
  const notices = [];
  if (last.switched && last.switched.length) {
    for (const sw of last.switched) {
      notices.push({ warn: true, html: `<b>本月换币</b>：${esc(sw.say)} 手里的 ${esc(sw.before)} 折成了 ${esc(sw.after)}。` });
    }
  }
  if (last.worldTrace && last.worldTrace.summary) {
    const label = last.worldTrace.kind === 'bond' ? '穿越者结缘' : '时空留痕';
    notices.push({ warn: false, html: `<b>${label}</b>：${esc(last.worldTrace.summary)}` });
  }
  if (last.refused && last.refused.length) {
    const items = last.refused.map(r => `${esc(r.what)}（${esc(r.why)}）`).join('；');
    notices.push({ warn: true, html: `<b>当年尚无</b>：${items}` });
  }
  if (last.local) {
    notices.push({ warn: false, html: `本月暂按固定规则推演${last.why ? `（${esc(last.why)}）` : ''}。` });
  }
  if (notices.length) {
    const nb = el('div', 'story-notices');
    for (const n of notices) {
      const d = el('div', 'story-notice' + (n.warn ? ' warn' : ''));
      d.innerHTML = n.html;
      nb.appendChild(d);
    }
    storyCard.appendChild(nb);
  }

  card.appendChild(storyCard);

  /* 行动区 */
  const ta = $('#list');
  ta.disabled = done;
  $('#write-label').textContent = done
    ? (s.phase === 'extra' ? '续走期满' : '满两年了')
    : `第 ${s.n} 个月 · 打算做什么`;
  const send = $('#send');
  send.classList.remove('busy');
  if (done) {
    send.disabled = false;
    send.textContent = s.phase === 'extra' ? '去算总账 →' : '去算这两年的账 →';
    send.onclick = settle;
  } else {
    const n = countHan(ta.value);
    send.disabled = n === 0 || n > (s.listLimit || 500);
    send.textContent = '过这个月 →';
    send.onclick = sendMonth;
  }
  updateDepthBar(countHan(ta.value));
  renderPicks(done ? [] : (last.options || s.options || []));
  if (voice) voice.sync();
}

/* ── 单行参考路子药丸 ────────────────────────────────────── */
function renderPicks(list) {
  const wrap = $('#picks');
  wrap.innerHTML = '';
  const has = Array.isArray(list) && list.length > 0;
  wrap.hidden = !has;
  if (!has) return;
  for (const o of list) {
    const b = el('button', 'q-pill', o.what || '');
    b.type = 'button';
    if (o.why) b.title = o.why;
    b.addEventListener('click', () => {
      writeIn(o.what || '');
      b.classList.add('used');
    });
    wrap.appendChild(b);
  }
  const sw = el('button', 'q-swap', '↻');
  sw.type = 'button';
  sw.title = '换一批参考';
  sw.setAttribute('aria-label', '换一批参考');
  sw.addEventListener('click', async () => {
    if (!run) return;
    sw.disabled = true;
    try {
      const d = await post('/api/options', { id: run.id, token });
      if (d.options && d.options.length) {
        run.state.options = d.options;
        renderPicks(d.options);
      }
    } catch (e) { toast(e.message); }
    sw.disabled = false;
  });
  wrap.appendChild(sw);
}

function writeIn(text) {
  const t = $('#list');
  if (t.disabled) return;
  const had = t.value.replace(/\s+$/, '');
  t.value = had ? had + '\n' + text : text;
  t.dispatchEvent(new Event('input'));
  t.focus();
  t.setSelectionRange(t.value.length, t.value.length);
}

function updateDepthBar(n) {
  const db = $('#depth-bar');
  if (!db) return;
  db.dataset.lv = n >= 45 ? '3' : n >= 15 ? '2' : n >= 1 ? '1' : '0';
}

function autoResizeTa(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(180, Math.max(68, ta.scrollHeight)) + 'px';
}

$('#list').addEventListener('input', () => {
  const ta = $('#list');
  autoResizeTa(ta);
  const n = countHan(ta.value);
  const lim = (run && run.state.listLimit) || 500;
  const c = $('#count');
  c.textContent = `${n} / ${lim}`;
  c.classList.toggle('over', n > lim);
  updateDepthBar(n);
  if (!ta.disabled) $('#send').disabled = n === 0 || n > lim;
});

let imgReqKey = '';
function fallbackMonthArtBox(box, badgeTxt, headline, fallbackYear) {
  if (!box) return;
  const art = yearArtUrl(fallbackYear);
  if (art) {
    box.classList.remove('pending');
    const st = box.querySelector('.hero-art-status');
    if (st) st.remove();
    if (!box.querySelector('img')) {
      const im = el('img');
      im.src = art;
      im.alt = `${fallbackYear} 年风貌`;
      box.insertBefore(im, box.firstChild);
    }
    return;
  }
  const th = el('div', 'hero-text-head');
  th.appendChild(el('span', 'hero-text-badge num', badgeTxt));
  th.appendChild(el('h2', '', headline));
  box.replaceWith(th);
}

async function requestMonthImage(runId, n, badgeTxt, headline, fallbackYear) {
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
        const st = box.querySelector('.hero-art-status');
        if (st) st.remove();
        const im = el('img');
        im.src = d.image;
        im.alt = `第 ${n} 月插画`;
        box.insertBefore(im, box.firstChild);
      }
    } else if (box) {
      fallbackMonthArtBox(box, badgeTxt, headline, fallbackYear);
    }
  } catch (e) {
    if (imgReqKey === key && $('#month-art-box')) {
      fallbackMonthArtBox($('#month-art-box'), badgeTxt, headline, fallbackYear);
    }
  }
}

/* ── 流式提交一个月（边写边吐精简概要与标题） ─────────────── */
function beginStream(at, list) {
  const card = $('#play-story');
  card.innerHTML = '';
  const badge = `第 ${at.n} 月 · ${at.year}.${String(at.month).padStart(2, '0')}`;
  const art = yearArtUrl(at.year);
  let h2;
  if (art) {
    const wrap = el('div', 'hero-art-wrap streaming');
    const im = el('img');
    im.src = art;
    im.alt = '';
    wrap.appendChild(im);
    wrap.appendChild(el('span', 'hero-art-badge num', badge));
    wrap.appendChild(el('span', 'hero-art-status', '推演中…'));
    const cap = el('div', 'hero-art-caption');
    h2 = el('h2', '', '正在推演这个月…');
    cap.appendChild(h2);
    wrap.appendChild(cap);
    card.appendChild(wrap);
  } else {
    const th = el('div', 'hero-text-head');
    th.appendChild(el('span', 'hero-text-badge num', badge));
    h2 = el('h2', '', '正在推演这个月…');
    th.appendChild(h2);
    card.appendChild(th);
  }

  const sc = el('div', 'story-card');
  if (list) {
    const pe = el('div', 'plan-echo');
    pe.innerHTML = `本月打算：<b>${esc(list)}</b>`;
    sc.appendChild(pe);
  }
  const body = el('div', 'story-body live', '');
  sc.appendChild(body);
  card.appendChild(sc);
  return { h2, body };
}

async function sendMonth() {
  if (voice && voice.isActive()) await voice.stop(false);
  const list = $('#list').value;
  const n = countHan(list);
  const lim = run.state.listLimit || 500;
  if (n === 0) return toast('先写下这个月打算做什么');
  if (n > lim) return toast(`超了 ${n - lim} 个汉字，删减一点再交吧`);

  const send = $('#send');
  send.disabled = true;
  send.textContent = '正在过这个月…';
  send.classList.add('busy');
  if (voice) voice.sync();

  const at = { n: run.state.n, year: run.state.year, month: run.state.month };
  const goTop = () => {
    const topH = $('#top').getBoundingClientRect().height + 12;
    const y = $('#play-story').getBoundingClientRect().top + window.scrollY - topH;
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  };

  try {
    const r = await fetch('/api/month', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: run.id, token, list, stream: true }),
    });
    if (!r.ok) {
      let say = `提交失败，请重试（${r.status}）`;
      try { say = (await r.json()).error || say; } catch (e) {}
      throw new Error(say);
    }

    let d = null;
    if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
      const ui = beginStream(at, list);
      goTop();
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '', headline = '', summary = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const em = /^event: (.+)$/m.exec(block);
          const dm = /^data: (.*)$/m.exec(block);
          if (!em || !dm) continue;
          let data;
          try { data = JSON.parse(dm[1]); } catch (e) { continue; }
          if (em[1] === 'headline') {
            headline += data.t;
            ui.h2.textContent = headline.replace(/\*\*/g, '');
          } else if (em[1] === 'summary' || em[1] === 'story') {
            summary += data.t;
            ui.body.innerHTML = formatParagraphsHtml(summary, list);
          } else if (em[1] === 'redo') {
            headline = ''; summary = '';
            ui.h2.textContent = '正在重算这个月…';
            ui.body.textContent = '';
          } else if (em[1] === 'error') {
            throw new Error(data.error || '这个月没能推演出来，请再试一次');
          } else if (em[1] === 'done') {
            d = data;
          }
        }
      }
      if (!d) throw new Error('连接断了，你写的打算还留着，再点一次即可');
    } else {
      d = await r.json();
    }

    run.state = d.state;
    const ta = $('#list');
    ta.value = '';
    autoResizeTa(ta);
    $('#count').textContent = `0 / ${d.state.listLimit}`;
    $('#count').classList.remove('over');
    updateDepthBar(0);
    renderPlay(d);
    animatePanel($('#play-story'), 'panel-in-up');
    goTop();
    if (d.done) toast(d.state.phase === 'extra' ? '这几年过完了，可以去算总账了' : '满两年了，可以去算这两年的账了');
  } catch (e) {
    toast(e instanceof TypeError ? '网络连接断了，你写的打算还留着，请再试一次。' : e.message);
    renderPlay(lastOf(run.state));
    send.disabled = false;
    send.textContent = '过这个月 →';
    send.classList.remove('busy');
    if (voice) voice.sync();
  }
}

/* ── 底部抽屉：家当 / 人脉 / 世道 ────────────────────────── */
let sheetPrevFocus = null;
function closeSheet() {
  hideOverlay($('#sheet-bg'), 180);
  if (sheetPrevFocus && typeof sheetPrevFocus.focus === 'function') sheetPrevFocus.focus();
  sheetPrevFocus = null;
}
function closePosterModal() {
  hideOverlay($('#poster-modal'), 170);
}
$('#sheet-close').addEventListener('click', closeSheet);
$('#sheet-bg').addEventListener('click', e => { if (e.target.id === 'sheet-bg') closeSheet(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!$('#comic-modal').hidden) closeComicLightbox();
    else if (!$('#sheet-bg').hidden) closeSheet();
    else if (!$('#poster-modal').hidden) closePosterModal();
  } else if (!$('#comic-modal').hidden) {
    if (e.key === 'ArrowLeft') stepComicLightbox(-1);
    else if (e.key === 'ArrowRight') stepComicLightbox(1);
  }
});

function sheetSection(title, items) {
  const sec = el('div', 'sheet-sec');
  sec.appendChild(el('h4', '', title));
  for (const it of items) sec.appendChild(it);
  return sec;
}
function sheetItem(title, val, sub, opts = {}) {
  const valStr = val != null ? String(val) : '';
  const stack = valStr.length > 15;
  const row = el('div', 'sheet-item' + (stack ? ' is-stack' : ''));
  const left = el('div');
  left.appendChild(el('strong', opts.lost ? 'lost' : '', title));
  if (stack && valStr) left.appendChild(el('b', 'sheet-val-block num' + (opts.neg ? ' neg' : ''), valStr));
  if (sub) left.appendChild(el('small', '', sub));
  row.appendChild(left);
  if (!stack && valStr) row.appendChild(el('b', 'num' + (opts.neg ? ' neg' : ''), valStr));
  return row;
}

async function openSheet(kind, opts = {}) {
  sheetPrevFocus = document.activeElement;
  const bg = $('#sheet-bg');
  const titleEl = $('#sheet-title');
  const body = $('#sheet-body');
  body.innerHTML = '';
  body.scrollTop = 0;
  showOverlay(bg);

  if (kind === 'assets' && run) {
    const s = run.state;
    titleEl.textContent = `家当与现金（总计 ${s.netWorthText}）`;
    const list = [sheetItem('手头现金', s.cashText, '随时可调动')];
    const assets = [...(s.assets || [])].sort((a, b) => (b.worth || 0) - (a.worth || 0));
    for (const a of assets) {
      list.push(sheetItem(a.name, a.worthText, `${a.kind || '实物'}${a.note ? ' · ' + a.note : ''}`));
    }
    body.appendChild(sheetSection('手里家当', list));

    if (s.debts && s.debts.length) {
      body.appendChild(sheetSection('所欠债务', s.debts.map(d => sheetItem(`欠 ${d.who}`, `−${d.amountText}`, d.note || '', { neg: true }))));
    }
    const rec = (s.recent || []).slice().reverse();
    if (rec.length) {
      body.appendChild(sheetSection('近期账本', rec.map(d => sheetItem(`${d.year} 年 ${d.month} 月`, '', d.tally || d.summary || ''))));
    }
    return;
  }

  if (kind === 'memo' && run) {
    const s = run.state;
    const m = s.memo || {};
    titleEl.textContent = '人脉与本事';
    if (s.persona) {
      body.appendChild(sheetSection('人物底子', [sheetItem(s.persona, '', '')]));
    }
    const traits = m.traits || [];
    if (traits.length) {
      body.appendChild(sheetSection('本事与家业', traits.map(t => {
        const latest = (t.notes || []).slice(-2).map(x => `第${x.n}月：${x.note}`).join('；');
        return sheetItem(t.what, t.lost ? `第${t.lost}月散` : '', latest || '已攒下', { lost: !!t.lost });
      })));
    }
    const open = (m.threads || []).filter(t => !t.done);
    if (open.length) {
      body.appendChild(sheetSection('还没了结的事', open.map(t => sheetItem(t.what, `第${t.opened}月起`, t.note || ''))));
    }
    if ((m.people || []).length) {
      body.appendChild(sheetSection('认识的人', m.people.map(p => {
        const latest = (p.notes || []).slice(-2).map(x => `第${x.n}月：${x.note}`).join('；');
        return sheetItem(p.who, '', latest || '打过照面');
      })));
    }
    const closed = (m.threads || []).filter(t => t.done);
    if (closed.length) {
      body.appendChild(sheetSection('已经了结的事', closed.map(t => sheetItem(t.what, `第${t.done}月了`, ''))));
    }
    if (!body.children.length) {
      body.appendChild(el('p', 'empty', '刚落脚不久，还没有攒下人脉与家业。'));
    }
    return;
  }

  if (kind === 'ref') {
    const y = opts.year || (run && run.state.year) || picked;
    if (!y) return closeSheet();
    titleEl.textContent = `${y} 年物价与世道`;
    body.innerHTML = '<p class="wait">正在翻阅资料…</p>';
    try {
      const d = await fetchYearData(y);
      const c = d.card;
      body.innerHTML = '';
      if (d.echoes && d.echoes.length) {
        body.appendChild(sheetSection('同年穿越者留痕', d.echoes.map(tr => sheetItem(tr.summary, '', ''))));
      }
      if ((c.prices || []).length) {
        body.appendChild(sheetSection('物价参考', c.prices.map(p => {
          const s2 = String(p.price == null ? '' : p.price);
          const m = s2.match(/^([^（(]*)([（(][\s\S]*)?$/);
          const main = (m ? m[1] : s2).trim();
          const note = [m && m[2] ? m[2].trim() : '', p.note || ''].filter(Boolean).join(' ');
          return sheetItem(p.item, main, note);
        })));
      }
      if ((c.money || []).length) {
        body.appendChild(sheetSection('谋生门路', c.money.map(m => sheetItem(m.way, '', m.who || ''))));
      }
      if ((c.forbidden || []).length) {
        body.appendChild(sheetSection('严查买卖', c.forbidden.map(f => sheetItem(f.what, '', f.why || ''))));
      }
      if ((c.tech && c.tech['没有'] && c.tech['没有'].length)) {
        const sec = el('div', 'sheet-sec');
        sec.appendChild(el('h4', '', '当时还没有'));
        const row = el('div', 'sheet-tags');
        for (const t of c.tech['没有']) row.appendChild(el('span', 'sheet-tag no', t));
        sec.appendChild(row);
        body.appendChild(sec);
      }
      if ((c.events || []).length) {
        body.appendChild(sheetSection('当年大事', c.events.map(e => sheetItem(`${e.month} 月`, '', e.text))));
      }
    } catch (e) {
      body.innerHTML = `<p class="empty">资料没能读出来：${esc(e.message)}</p>`;
    }
  }
}

/* ── 4 & 5. 结算画报与详情（封面英雄卡 + 3 段 Tab） ──────── */
const roomText = n => n >= 12
  ? `${Math.floor(n / 12)} 年${n % 12 ? `零 ${n % 12} 个月` : ''}`
  : `${n} 个月`;

async function settle() {
  const send = $('#send');
  send.disabled = true;
  send.textContent = '正在算账…';
  send.classList.add('busy');
  try {
    const d = await post('/api/settle', { id: run.id, token });
    const phase = d.phase || d.result.phase || 'main';
    const rid = run.id;
    renderMagazineView($('#done-body'), {
      id: rid,
      result: d.result,
      ranks: d,
      review: d.review || null,
      finaleImage: d.finaleImage || null,
      months: d.months || [],
      mainMonths: d.mainMonths || 24,
      extraRoom: d.extraRoom || 0,
      phase,
      main: d.main || null,
      mode: 'done',
    });
    localStorage.removeItem(RUN_KEY);
    run = null;
    syncNavPlay();
    go('done');
    if (!d.review) fetchReview(rid, phase === 'extra', $('#done-body'));
  } catch (e) {
    toast(e.message);
    send.disabled = false;
    send.textContent = run && run.state.phase === 'extra' ? '去算总账 →' : '去算这两年的账 →';
    send.classList.remove('busy');
  }
}

function attachFinaleCover(cover, id, url, extra, stampText, fallbackYear, container) {
  cover.innerHTML = '';
  const syncComicFinale = imgSrc => {
    const scope = container || document;
    const target = scope.querySelector('[data-comic-finale-img]');
    if (target && imgSrc) target.src = imgSrc;
  };
  const showFallback = () => {
    cover.classList.remove('pending');
    cover.innerHTML = '';
    const art = yearArtUrl(fallbackYear);
    if (art) {
      const im = el('img');
      im.src = art;
      im.alt = `${fallbackYear} 年风貌`;
      im.crossOrigin = 'anonymous';
      cover.appendChild(im);
      syncComicFinale(art);
    }
    cover.appendChild(el('span', 'done-stamp', stampText));
  };
  if (url) {
    cover.classList.remove('pending');
    const im = el('img');
    im.src = url;
    im.alt = '收官画卷';
    im.crossOrigin = 'anonymous';
    cover.appendChild(im);
  } else {
    cover.classList.add('pending');
    cover.appendChild(el('span', '', '正在绘制收官画卷…'));
    if (id) {
      post('/api/finale-image', { id, extra: !!extra }).then(d => {
        if (d && d.ok && d.image) {
          if (lastPosterCtx && lastPosterCtx.id === id) lastPosterCtx.finaleImage = d.image;
          cover.classList.remove('pending');
          cover.innerHTML = '';
          const im = el('img');
          im.src = d.image;
          im.alt = '收官画卷';
          im.crossOrigin = 'anonymous';
          cover.appendChild(im);
          cover.appendChild(el('span', 'done-stamp', stampText));
          syncComicFinale(d.image);
        } else {
          showFallback();
        }
      }).catch(showFallback);
    } else {
      return showFallback();
    }
  }
  cover.appendChild(el('span', 'done-stamp', stampText));
}

function fillVerdictBox(box, rv, opts = {}) {
  box.innerHTML = '';
  if (!rv) {
    box.appendChild(el('p', 'wait', opts.waiting ? '正在写这段日子的回顾…' : '暂未生成回顾总结。'));
    if (opts.onWrite) {
      const b = el('button', 'btn-ghost', '写一篇回顾');
      b.type = 'button';
      b.addEventListener('click', opts.onWrite);
      box.appendChild(b);
    }
    return;
  }
  if (rv.became) box.appendChild(el('div', 'verdict-became', rv.became));
  for (const seg of String(rv.verdict || '').split('\n')) {
    if (seg.trim()) box.appendChild(el('p', '', seg.trim()));
  }
  if (rv.local) box.appendChild(el('div', 'verdict-note', '总结暂时没生成出来，先按账本梳理了一遍。'));
}

function fillTimelineBox(tlBox, rv) {
  tlBox.innerHTML = '';
  const turns = (rv && rv.turns) || [];
  const missed = rv && rv.missed;
  if (!turns.length && !missed) {
    tlBox.hidden = true;
    return;
  }
  tlBox.hidden = false;
  if (turns.length) {
    tlBox.appendChild(el('div', 'tl-head', '关键转折'));
    for (const x of turns) {
      const row = el('div', 'tl-item');
      row.appendChild(el('span', 'num', x.when || ''));
      row.appendChild(el('div', '', x.what || ''));
      tlBox.appendChild(row);
    }
  }
  if (missed) {
    const ms = el('div', 'tl-missed');
    ms.appendChild(el('b', '', '当时没走的另一条路'));
    ms.appendChild(document.createTextNode(missed));
    tlBox.appendChild(ms);
  }
}

/* ── 连环画翻页看图器（小人书单帧沉浸） ──────────────────── */
let comicLbState = { items: [], idx: 0, runId: null, canPaint: false, hasOwnerDetail: false, onPainted: null };

function renderComicLightbox() {
  const { items, idx, runId, canPaint, hasOwnerDetail, onPainted } = comicLbState;
  const item = items[idx];
  if (!item) return;
  const ym = `${item.year} 年 ${item.month} 月`;
  $('#lb-pos').textContent = `第 ${String(idx + 1).padStart(2, '0')} / ${String(items.length).padStart(2, '0')} 帧 · ${ym}`;
  const im = $('#lb-img');
  im.src = item.image || yearArtUrl(item.year) || '';
  im.alt = item.headline || ym;
  const net = parseNetInfo(item.tally, null, '');
  const netEl = $('#lb-net');
  if (net) {
    netEl.hidden = false;
    netEl.textContent = net.short;
    netEl.className = 'comic-net num' + (net.neg ? ' neg' : '');
  } else {
    netEl.hidden = true;
  }

  const pBtn = $('#lb-paint');
  if (pBtn) {
    const showPaint = !!(canPaint && runId && !item.image);
    pBtn.hidden = !showPaint;
    pBtn.disabled = false;
    pBtn.textContent = '补绘此帧';
    pBtn.onclick = showPaint ? async () => {
      pBtn.disabled = true;
      pBtn.textContent = '绘图中…';
      try {
        const res = await post('/api/month-image', { id: runId, token, n: item.n });
        if (res && res.ok && res.image) {
          item.image = res.image;
          if (comicLbState.items[comicLbState.idx] === item) {
            im.src = res.image;
            pBtn.hidden = true;
          }
          if (onPainted) onPainted(idx, res.image);
          toast(`第 ${item.n} 帧专属插画已补绘`);
        } else {
          pBtn.disabled = false;
          pBtn.textContent = '补绘此帧';
          toast('暂时没能画出这一帧，请稍后再试');
        }
      } catch (err) {
        pBtn.disabled = false;
        pBtn.textContent = '补绘此帧';
        toast(err.message);
      }
    } : null;
  }

  $('#lb-head').textContent = item.headline || clientHeadlineOf(item, ym);
  $('#lb-text').textContent = String(item.summary || item.say || clientSummaryOf(item) || '').replace(/\*\*/g, '');
  const metaParts = [];
  if (item.worth) metaParts.push(`家底 ${item.worth}`);
  if (item.moved && item.moved.to) metaParts.push(`搬至${item.moved.to}`);
  if (item.worldTrace && item.worldTrace.summary) metaParts.push(item.worldTrace.summary);
  $('#lb-meta').textContent = metaParts.join(' · ');

  const extraBox = $('#lb-extra');
  if (extraBox) {
    extraBox.innerHTML = '';
    if (hasOwnerDetail && (item.list || item.story)) {
      extraBox.hidden = false;
      const more = el('details', 'comic-more');
      const sumEl = el('summary', '', '展开本月打算与全文 ▾');
      more.addEventListener('toggle', () => {
        sumEl.textContent = more.open ? '收起本月打算与全文 ▴' : '展开本月打算与全文 ▾';
      });
      more.appendChild(sumEl);
      const mb = el('div', 'comic-more-body');
      if (item.list) {
        const pe = el('div', 'plan-echo');
        pe.innerHTML = `当月打算：<b>${esc(item.list)}</b>`;
        mb.appendChild(pe);
      }
      if (item.story) {
        const sb = el('div', 'story-body');
        sb.innerHTML = formatParagraphsHtml(item.story, item.list || '');
        mb.appendChild(sb);
      }
      if (item.tally) mb.appendChild(el('div', 'story-notice', item.tally));
      if (item.refused && item.refused.length) {
        mb.appendChild(el('div', 'story-notice warn', '当年尚无：' + item.refused.map(x => `${x.what}（${x.why}）`).join('；')));
      }
      more.appendChild(mb);
      extraBox.appendChild(more);
    } else {
      extraBox.hidden = true;
    }
  }

  $('#lb-prev').disabled = idx <= 0;
  $('#lb-next').disabled = idx >= items.length - 1;
  const capEl = $('.comic-lb-cap');
  if (capEl) capEl.scrollTop = 0;
}

function openComicLightbox(items, idx, opts = {}) {
  if (!Array.isArray(items) || !items.length) return;
  comicLbState = {
    items,
    idx: Math.max(0, Math.min(items.length - 1, idx)),
    runId: opts.runId || null,
    canPaint: !!opts.canPaint,
    hasOwnerDetail: !!opts.hasOwnerDetail,
    onPainted: opts.onPainted || null,
  };
  renderComicLightbox();
  showOverlay($('#comic-modal'));
}

function closeComicLightbox() {
  hideOverlay($('#comic-modal'), 170);
}

function stepComicLightbox(delta) {
  const next = comicLbState.idx + delta;
  if (next < 0 || next >= comicLbState.items.length) return;
  comicLbState.idx = next;
  renderComicLightbox();
  const cls = delta > 0 ? 'panel-in-r' : 'panel-in-l';
  animatePanel($('.comic-lb-stage'), cls);
  animatePanel($('.comic-lb-cap'), cls);
}

$('#lb-close').addEventListener('click', closeComicLightbox);
$('#comic-modal').addEventListener('click', e => { if (e.target.id === 'comic-modal') closeComicLightbox(); });
$('#lb-prev').addEventListener('click', () => stepComicLightbox(-1));
$('#lb-next').addEventListener('click', () => stepComicLightbox(1));

/* ── 连环画分镜渲染（所有月份连成完整分镜格） ──────────────── */
function comicCaptionOf(d) {
  return String(d.summary || d.say || clientSummaryOf(d) || '').replace(/\*\*/g, '').trim();
}
function comicHeadlineOf(d) {
  return String(d.headline || clientHeadlineOf(d, `${d.year} 年 ${d.month} 月`) || '').replace(/\*\*/g, '').trim();
}

function renderComicStrip(host, cfg) {
  host.innerHTML = '';
  const months = cfg.months || [];
  const mainMonths = cfg.mainMonths || 24;
  const r = cfg.result;
  const rv = cfg.review || {};
  const canPaint = !!(cfg.id && token && (cfg.mode === 'done' || cfg.mode === 'detail'));
  const hasOwnerDetail = cfg.mode === 'done' || cfg.mode === 'detail';
  const paintedCount = months.filter(m => !!m.image).length;

  const wrap = el('div', 'comic-wrap');

  /* 顶栏：卷名 + 帧数 + 导出连环画长图 */
  const bar = el('div', 'comic-bar');
  const bt = el('div', 'comic-bar-title');
  const tEl = el('strong', '', rv.title ? `《${rv.title}》连环画` : `${r.nick} 的百年连环画`);
  tEl.dataset.comicTitle = '1';
  bt.appendChild(tEl);
  const subParts = [`共 ${months.length} 帧 · ${r.year}.${String(r.month).padStart(2, '0')} — ${r.endYear}.${String(r.endMonth).padStart(2, '0')}`];
  if (paintedCount > 0 && paintedCount < months.length) subParts.push(`含 ${paintedCount} 帧专属月画`);
  bt.appendChild(el('span', 'num', subParts.join(' · ')));
  bar.appendChild(bt);

  const tools = el('div', 'comic-bar-tools');
  const expBtn = el('button', 'btn-ghost comic-export-btn', '导出长图');
  expBtn.type = 'button';
  expBtn.addEventListener('click', () => openComicExport(lastPosterCtx));
  tools.appendChild(expBtn);
  bar.appendChild(tools);
  wrap.appendChild(bar);

  /* 分镜画册 */
  const book = el('div', 'comic-book');
  const imgNodes = [];

  let prevYear = null;
  months.forEach((d, idx) => {
    const isPhaseCut = d.n === mainMonths + 1;
    const isYearCut = prevYear !== null && d.year !== prevYear && !isPhaseCut;
    prevYear = d.year;

    if (isPhaseCut) {
      book.appendChild(el('div', 'comic-phase-cut', '两年之后 · 续走篇'));
    } else if (isYearCut) {
      book.appendChild(el('div', 'comic-year-cut num', `${d.year} 年`));
    }

    const ym = `${d.year}.${String(d.month).padStart(2, '0')}`;
    const isFallback = !d.image;
    const imgSrc = d.image || yearArtUrl(d.year);
    const net = parseNetInfo(d.tally, null, '');

    const panel = el('article', 'comic-panel');
    panel.setAttribute('role', 'button');
    panel.setAttribute('tabindex', '0');
    panel.setAttribute('aria-label', `查看第 ${idx + 1} 帧 ${ym} ${comicHeadlineOf(d)}`);

    const art = el('div', 'comic-art');
    const im = el('img', isFallback ? `is-fallback pos-${idx % 3}` : '');
    if (imgSrc) im.src = imgSrc;
    im.alt = `${d.year} 年 ${d.month} 月`;
    im.loading = idx < 6 ? 'eager' : 'lazy';
    im.decoding = 'async';
    art.appendChild(im);
    imgNodes[idx] = im;

    art.appendChild(el('span', 'comic-no num', `第 ${String(idx + 1).padStart(2, '0')} 帧 · ${ym}`));
    if (net) {
      art.appendChild(el('span', 'comic-net num' + (net.neg ? ' neg' : ''), net.short));
    }
    panel.appendChild(art);

    const cap = el('div', 'comic-caption');
    const head = el('div', 'comic-cap-head');
    head.appendChild(el('h4', '', comicHeadlineOf(d)));
    cap.appendChild(head);

    const capTxt = comicCaptionOf(d);
    if (capTxt) cap.appendChild(el('p', 'comic-cap-text', capTxt));
    panel.appendChild(cap);

    const openLb = () => openComicLightbox(months, idx, {
      runId: cfg.id,
      canPaint,
      hasOwnerDetail,
      onPainted: (i, url) => {
        if (imgNodes[i]) { imgNodes[i].className = ''; imgNodes[i].src = url; }
      },
    });
    panel.addEventListener('click', openLb);
    panel.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openLb(); }
    });
    book.appendChild(panel);
  });

  /* 终章收官帧：跨整行首尾呼应 */
  if (months.length) {
    const fin = el('article', 'comic-finale');
    const fa = el('div', 'comic-finale-art');
    const fim = el('img');
    fim.dataset.comicFinaleImg = '1';
    fim.src = cfg.finaleImage || yearArtUrl(r.endYear || r.year) || '';
    fim.alt = '终章收官画卷';
    fim.loading = 'lazy';
    fa.appendChild(fim);
    fa.appendChild(el('span', 'done-stamp', cfg.phase === 'extra' ? '终章 · 续走收官' : '终章 · 两年收官'));
    fin.appendChild(fa);

    const fb = el('div', 'comic-finale-body');
    const ftop = el('div', 'comic-finale-top');
    const ft = el('strong', '', rv.title ? `《${rv.title}》` : `${r.nick} 的这段日子`);
    ft.dataset.comicFinaleTitle = '1';
    ftop.appendChild(ft);
    const yrs = (r.score < 0 ? '−' : '') + Math.abs(r.score).toFixed(2);
    ftop.appendChild(el('span', 'num', `抵普通人 ${yrs} 年收入`));
    fb.appendChild(ftop);

    const bec = el('p', 'comic-finale-became', rv.became || `${r.year}.${String(r.month).padStart(2, '0')} 至 ${r.endYear}.${String(r.endMonth).padStart(2, '0')}，落脚${r.city}，净赚 ${r.yearEarnedText}。`);
    bec.dataset.comicBecame = '1';
    fb.appendChild(bec);

    const ffoot = el('div', 'comic-finale-foot');
    ffoot.appendChild(el('span', 'comic-finale-score num', `净赚 ${r.yearEarnedText}`));
    const saveBtn = el('button', 'btn-primary comic-export-btn', '保存整卷连环画长图');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', () => openComicExport(lastPosterCtx));
    ffoot.appendChild(saveBtn);
    fb.appendChild(ffoot);
    fin.appendChild(fb);
    book.appendChild(fin);
  }

  wrap.appendChild(book);
  host.appendChild(wrap);
}

function renderMagazineView(container, cfg) {
  container.innerHTML = '';
  const r = cfg.result;
  const ranks = cfg.ranks || {};
  const extra = cfg.phase === 'extra';
  const yrs = (r.score < 0 ? '−' : '') + Math.abs(r.score).toFixed(2);
  const stampText = extra
    ? `续走结算 · 续走榜第 ${ranks.rankExtra ?? '—'}`
    : `两年结算 · 总榜第 ${ranks.rankWorld ?? '—'}`;
  const months = Array.isArray(cfg.months) ? cfg.months : [];
  const hasMonths = months.length > 0;

  lastPosterCtx = {
    id: cfg.id,
    result: r,
    ranks,
    review: cfg.review || null,
    finaleImage: cfg.finaleImage || null,
    months,
    mainMonths: cfg.mainMonths || 24,
    extra,
  };

  /* 1. 封面英雄卡 */
  const hero = el('div', 'done-hero');
  const cover = el('div', 'done-cover');
  attachFinaleCover(cover, cfg.id, cfg.finaleImage, extra, stampText, r.year, container);
  hero.appendChild(cover);

  const sm = el('div', 'done-summary');
  sm.appendChild(el('div', 'done-meta num', `${r.nick} · ${r.year}.${String(r.month).padStart(2, '0')} → ${r.endYear}.${String(r.endMonth).padStart(2, '0')} · ${r.city}`));
  if (cfg.persona) sm.appendChild(el('div', 'done-persona', cfg.persona));
  sm.appendChild(el('div', 'done-amount num' + (r.yearEarned < 0 ? ' neg' : ''), r.yearEarnedText));

  const titleRow = el('div', 'done-title-row');
  const titleEl = el('b', '', cfg.review && cfg.review.title ? `《${cfg.review.title}》` : (extra ? '续走档案' : '两年档案'));
  titleEl.dataset.magTitle = '1';
  titleRow.appendChild(titleEl);
  titleRow.appendChild(el('span', 'num', `抵普通人 ${yrs} 年收入`));
  sm.appendChild(titleRow);

  const acts = el('div', 'done-actions');
  if (hasMonths) {
    const comicBtn = el('button', 'btn-primary', '保存连环画长图');
    comicBtn.type = 'button';
    comicBtn.addEventListener('click', () => openComicExport(lastPosterCtx));
    acts.appendChild(comicBtn);
  }
  const shareBtn = el('button', hasMonths ? 'btn-ghost' : 'btn-primary', '生成分享海报');
  shareBtn.type = 'button';
  shareBtn.addEventListener('click', () => openSharePoster(lastPosterCtx));
  acts.appendChild(shareBtn);

  if (cfg.mode === 'peek' && cfg.mine) {
    const detBtn = el('button', 'btn-ghost', '查看逐月详情');
    detBtn.type = 'button';
    detBtn.addEventListener('click', () => openDetail(cfg.id, 'board'));
    acts.appendChild(detBtn);
  } else if (cfg.extraStatus === 'playing') {
    const contBtn = el('button', 'btn-ghost', '继续续走');
    contBtn.type = 'button';
    contBtn.addEventListener('click', () => resume(cfg.id));
    acts.appendChild(contBtn);
  } else if (!extra && !cfg.extraStatus && Number(cfg.extraRoom || 0) > 0 && cfg.mode !== 'peek') {
    const extBtn = el('button', 'btn-ghost', '接着过下去');
    extBtn.type = 'button';
    extBtn.title = `还可再走 ${roomText(cfg.extraRoom)}，前两年成绩已定格`;
    extBtn.addEventListener('click', () => extendRun(extBtn, cfg.extraRoom, cfg.id));
    acts.appendChild(extBtn);
  }

  const againBtn = el('button', 'btn-ghost', '再开一局');
  againBtn.type = 'button';
  againBtn.addEventListener('click', () => go('pick'));
  acts.appendChild(againBtn);
  sm.appendChild(acts);
  hero.appendChild(sm);
  container.appendChild(hero);

  /* 2. 分段 Tab（连环画默认展示 / 总览与转折 / 记事人判词） */
  const defaultTab = hasMonths ? 'comic' : 'overview';
  const tabs = el('div', 'seg-tabs' + (hasMonths ? '' : ' two'));
  const panes = {};
  const tabDefs = [
    ...(hasMonths ? [['comic', `连环画 · ${months.length} 帧`]] : []),
    ['overview', '总览与转折'],
    ['verdict', '记事人判词'],
  ];

  let activeTabIdx = 0;
  tabDefs.forEach(([key, label], idx) => {
    const b = el('button', key === defaultTab ? 'on' : '', label);
    b.type = 'button';
    b.dataset.tab = key;
    b.addEventListener('click', () => {
      if (idx === activeTabIdx) return;
      const cls = idx > activeTabIdx ? 'panel-in-r' : 'panel-in-l';
      activeTabIdx = idx;
      tabs.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      Object.entries(panes).forEach(([k, p]) => { p.hidden = k !== key; });
      animatePanel(panes[key], cls);
    });
    tabs.appendChild(b);
  });
  container.appendChild(tabs);

  /* Tab 1: 连环画（所有月份首尾相连） */
  if (hasMonths) {
    const pComic = el('div');
    pComic.hidden = defaultTab !== 'comic';
    panes.comic = pComic;
    renderComicStrip(pComic, { ...cfg, months });
    container.appendChild(pComic);
  }

  /* Tab 2: 总览与转折 */
  const pOver = el('div');
  pOver.hidden = defaultTab !== 'overview';
  panes.overview = pOver;
  const sg = el('div', 'stat-grid');
  const rankLabel = extra
    ? `第 ${ranks.rankExtra ?? '—'} / ${ranks.ofExtra ?? '—'}`
    : `${r.year}年榜 #${ranks.rankYear ?? '—'} · 总榜 #${ranks.rankWorld ?? '—'}`;
  const statRows = [
    ['开局本钱', r.startCashText || fmtMoney(r.startCash, r.currencyName)],
    ['收官家底', r.endWorthText || fmtMoney(r.endWorth, r.currencyName)],
    ['折合当年美元', r.usdThen != null ? fmtUsdCN(r.usdThen) : '—'],
    ['折合今天美元', r.worldUsdText || '—'],
    ['收官年收入基准', r.incomeText || fmtMoney(r.income, r.currencyName)],
    ['榜单名次', rankLabel],
  ];
  for (const [k, v] of statRows) {
    const sb = el('div', 'stat-box');
    sb.appendChild(el('span', '', k));
    sb.appendChild(el('b', 'num', v));
    sg.appendChild(sb);
  }
  pOver.appendChild(sg);

  const tlBox = el('div', 'timeline');
  tlBox.dataset.magTimeline = '1';
  fillTimelineBox(tlBox, cfg.review);
  pOver.appendChild(tlBox);

  if (cfg.main && extra) {
    const mb = el('div', 'phase-banner');
    mb.appendChild(el('b', '', '前两年定格成绩'));
    mb.appendChild(el('span', 'num', `净赚 ${cfg.main.yearEarnedText}（抵 ${cfg.main.score.toFixed(2)} 年收入）`));
    pOver.appendChild(mb);
  }
  if (cfg.extraStatus === 'done' && cfg.extraResult) {
    const ex = cfg.extraResult;
    const eb = el('div', 'phase-banner');
    eb.appendChild(el('b', '', `两年之后续走（共 ${ex.months} 个月）`));
    eb.appendChild(el('span', 'num', `净赚 ${ex.yearEarnedText} · 折合今天 ${ex.worldUsdText} · 续走榜 #${cfg.extraRank?.rankExtra ?? '—'}`));
    pOver.appendChild(eb);
  } else if (cfg.extraStatus === 'playing' && cfg.mode === 'peek') {
    const eb = el('div', 'phase-banner');
    eb.appendChild(el('b', '', '两年之后'));
    eb.appendChild(el('span', '', '这一局满两年后还在接着往下过，尚未结算。'));
    pOver.appendChild(eb);
  }
  container.appendChild(pOver);

  /* Tab 3: 记事人判词 */
  const pVer = el('div');
  pVer.hidden = true;
  panes.verdict = pVer;
  const vb = el('div', 'verdict-box');
  vb.dataset.magVerdict = '1';
  fillVerdictBox(vb, cfg.review, {
    waiting: cfg.waiting || (!cfg.review && cfg.mode === 'done'),
    onWrite: (!cfg.review && cfg.mode === 'detail') ? () => fetchReview(cfg.id, false, container) : null,
  });
  pVer.appendChild(vb);

  if (cfg.extraStatus === 'done' && (cfg.extraReview || cfg.extraWriting)) {
    const exHead = el('div', 'phase-banner');
    exHead.appendChild(el('b', '', '两年之后判词'));
    pVer.appendChild(exHead);
    const vbx = el('div', 'verdict-box');
    vbx.dataset.magVerdictExtra = '1';
    fillVerdictBox(vbx, cfg.extraReview, { waiting: cfg.extraWriting });
    pVer.appendChild(vbx);
  }
  container.appendChild(pVer);
}

function patchMagazineReview(container, rv, extra = false) {
  if (!container || !rv) return;
  if (!extra) {
    const t = container.querySelector('[data-mag-title]');
    if (t && rv.title) t.textContent = `《${rv.title}》`;
    const ct = container.querySelector('[data-comic-title]');
    if (ct && rv.title) ct.textContent = `《${rv.title}》连环画`;
    const cft = container.querySelector('[data-comic-finale-title]');
    if (cft && rv.title) cft.textContent = `《${rv.title}》`;
    const cb = container.querySelector('[data-comic-became]');
    if (cb && rv.became) cb.textContent = rv.became;
    const tl = container.querySelector('[data-mag-timeline]');
    if (tl) fillTimelineBox(tl, rv);
    const vb = container.querySelector('[data-mag-verdict]');
    if (vb) fillVerdictBox(vb, rv);
  } else {
    const vbx = container.querySelector('[data-mag-verdict-extra]');
    if (vbx) fillVerdictBox(vbx, rv);
  }
}

async function fetchReview(id, extra, container) {
  const vb = container && container.querySelector(extra ? '[data-mag-verdict-extra]' : '[data-mag-verdict]');
  if (vb) vb.innerHTML = `<p class="wait">${extra ? '正在写这几年的回顾…' : '正在写这两年的回顾…'}</p>`;
  try {
    const d = await post('/api/review', { id, token, extra: !!extra });
    if (lastPosterCtx && lastPosterCtx.id === id && !extra) lastPosterCtx.review = d.review;
    patchMagazineReview(container, d.review, extra);
  } catch (e) {
    if (vb) {
      vb.innerHTML = `<p class="empty">回顾没写出来：${esc(e.message)}</p>`;
      const again = el('button', 'btn-ghost', '再试一次');
      again.type = 'button';
      again.addEventListener('click', () => fetchReview(id, extra, container));
      vb.appendChild(again);
    }
  }
}

async function extendRun(btn, room, id) {
  btn.disabled = true;
  btn.textContent = '正在接上…';
  try {
    const d = await post('/api/extend', { id, token });
    run = { id, state: d.state };
    syncNavPlay();
    localStorage.setItem(RUN_KEY, id);
    renderPlay({
      head: '接着往下过',
      summary: `前两年的账已经定格。你留在${d.state.city}继续过日子，往前最多还有 ${roomText(d.room)}。`,
      story: `前两年的账已经定格。你留在${d.state.city}继续过日子，往前最多还有 ${roomText(d.room)}。`,
      switched: d.switched,
      options: d.state.options,
      first: true,
    });
    go('play');
  } catch (e) {
    toast(e.message);
    btn.disabled = false;
    btn.textContent = '接着过下去';
  }
}

/* ── 详情与榜上查看 ──────────────────────────────────────── */
let detailBack = 'mine';
let peekFor = null;
const peekUrl = id => `/api/peek?id=${encodeURIComponent(id)}${token ? '&token=' + encodeURIComponent(token) : ''}`;

async function openDetail(id, back = 'mine') {
  const box = $('#detail-body');
  const alreadyDetail = document.body.dataset.screen === 'detail';
  box.innerHTML = '<p class="wait">正在打开记录…</p>';
  detailBack = back;
  peekFor = null;
  if (!alreadyDetail) go('detail');
  else animatePanel(box, 'panel-in-r');
  try {
    const d = await api(`/api/detail?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
    renderMagazineView(box, {
      id,
      result: d.result,
      ranks: d.rank,
      review: d.review || null,
      finaleImage: d.finaleImage || null,
      months: d.months || [],
      mainMonths: d.mainMonths || 24,
      persona: d.persona || '',
      extraStatus: d.extraStatus,
      extraRoom: d.extraRoom,
      extraResult: d.extraResult,
      extraReview: d.extraReview,
      extraRank: d.extraRank,
      mode: 'detail',
    });
  } catch (e) {
    box.innerHTML = `<p class="empty">记录没能打开：${esc(e.message)}</p>`;
  }
}

async function openPeek(id) {
  const box = $('#detail-body');
  box.innerHTML = '<p class="wait">正在打开记录…</p>';
  detailBack = 'board';
  peekFor = id;
  go('detail');
  try {
    const d = await api(peekUrl(id));
    if (peekFor !== id) return;
    renderMagazineView(box, {
      id,
      result: d.result,
      ranks: d.rank,
      review: d.review || null,
      waiting: !!d.writing,
      finaleImage: d.finaleImage || null,
      months: d.comic || [],
      mainMonths: d.mainMonths || 24,
      mine: !!d.mine,
      extraStatus: d.extraStatus,
      extraResult: d.extraResult,
      extraReview: d.extraReview,
      extraWriting: !!d.extraWriting,
      extraRank: d.extraRank,
      mode: 'peek',
    });
    if (d.writing || d.extraWriting) setTimeout(() => peekPoll(id, 1), 4000);
  } catch (e) {
    box.innerHTML = `<p class="empty">记录没能打开：${esc(e.message)}</p>`;
  }
}

async function peekPoll(id, tries) {
  if (peekFor !== id || document.body.dataset.screen !== 'detail') return;
  try {
    const d = await api(peekUrl(id));
    if (peekFor !== id) return;
    const box = $('#detail-body');
    if (d.review) {
      if (lastPosterCtx && lastPosterCtx.id === id) lastPosterCtx.review = d.review;
      patchMagazineReview(box, d.review, false);
    }
    if (d.extraReview) patchMagazineReview(box, d.extraReview, true);
    if ((d.writing || d.extraWriting) && tries < 30) {
      setTimeout(() => peekPoll(id, tries + 1), 4000);
    }
  } catch (e) {}
}

$('#detail-back').addEventListener('click', () => go(detailBack));

/* ── 分享海报（Canvas 900px 宣纸竖版长图） ────────────────── */
function wrapCanvasLines(ctx, text, maxWidth) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    const p = para.trim();
    if (!p) continue;
    let line = '';
    for (const ch of p) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line.length > 0) {
        out.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

function loadImgForCanvas(url) {
  if (!url) return Promise.resolve(null);
  return new Promise(resolve => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = url;
  });
}

function drawCoverImage(ctx, img, x, y, w, h, focalX = 0.5) {
  if (!img || !img.naturalWidth || !img.naturalHeight) {
    ctx.fillStyle = '#e7e1d4';
    ctx.fillRect(x, y, w, h);
    return;
  }
  const ir = img.naturalWidth / img.naturalHeight;
  const br = w / h;
  let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
  if (ir > br) {
    sw = Math.round(sh * br);
    sx = Math.round((img.naturalWidth - sw) * focalX);
  } else {
    sh = Math.round(sw / br);
    sy = Math.round((img.naturalHeight - sh) * 0.5);
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function drawRoundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function bindPosterOutput(cvs, fileName, shareTitle, imgAlt, dlLabel = '保存图片') {
  const imgEl = $('#poster-img');
  const wrapEl = imgEl && imgEl.parentElement;
  const dlEl = $('#poster-dl');
  const shareEl = $('#poster-share');
  const statusEl = $('#poster-status');
  if (statusEl) statusEl.hidden = true;
  if (wrapEl) { wrapEl.hidden = false; wrapEl.scrollTop = 0; }
  const dataUrl = cvs.toDataURL('image/jpeg', 0.89);
  imgEl.hidden = false;
  imgEl.src = dataUrl;
  imgEl.alt = imgAlt;
  dlEl.href = dataUrl;
  dlEl.download = fileName;
  dlEl.textContent = dlLabel;

  if (navigator.canShare && window.File) {
    cvs.toBlob(blob => {
      if (!blob) return;
      const file = new File([blob], fileName, { type: 'image/jpeg' });
      if (navigator.canShare({ files: [file] })) {
        shareEl.hidden = false;
        shareEl.onclick = () => navigator.share({ title: shareTitle, files: [file] }).catch(() => {});
      }
    }, 'image/jpeg', 0.89);
  } else {
    shareEl.hidden = true;
  }
}

async function openComicExport(pctx) {
  if (!pctx || !pctx.result || !Array.isArray(pctx.months) || !pctx.months.length) {
    return toast('暂无可拼接的月份连环画');
  }
  const modal = $('#poster-modal');
  const imgEl = $('#poster-img');
  const wrapEl = imgEl && imgEl.parentElement;
  const shareEl = $('#poster-share');
  const statusEl = $('#poster-status');
  showOverlay(modal);
  imgEl.hidden = true;
  imgEl.removeAttribute('src');
  imgEl.alt = '';
  if (wrapEl) wrapEl.hidden = true;
  shareEl.hidden = true;

  const r = pctx.result;
  const rv = pctx.review || {};
  const panels = pctx.months;
  const mainMonths = pctx.mainMonths || 24;
  const setStatus = txt => {
    if (!statusEl) return;
    statusEl.hidden = !txt;
    statusEl.textContent = txt || '';
  };
  setStatus(`正在准备连环画画卷（共 ${panels.length} 帧）…`);

  /* 去重并行加载全部帧图、收官图与印章 Logo */
  const urlSet = new Set(['/assets/apple-touch-icon.png']);
  const finaleUrl = pctx.finaleImage || yearArtUrl(r.endYear || r.year);
  if (finaleUrl) urlSet.add(finaleUrl);
  for (const d of panels) {
    const u = d.image || yearArtUrl(d.year);
    if (u) urlSet.add(u);
  }
  const urls = [...urlSet];
  const imgMap = new Map();
  let loaded = 0;
  await Promise.all(urls.map(async u => {
    const im = await loadImgForCanvas(u);
    imgMap.set(u, im);
    loaded++;
    setStatus(`正在加载画帧（${loaded} / ${urls.length}）…`);
  }));
  if (modal.hidden || modal.dataset.state === 'closing') return;

  setStatus('正在拼接整卷连环画…');
  const logoImg = imgMap.get('/assets/apple-touch-icon.png') || null;
  const finaleArt = finaleUrl ? imgMap.get(finaleUrl) : null;
  const SERIF = '"Songti SC", "Noto Serif SC", "Source Han Serif SC", "SimSun", Georgia, serif';
  const SANS = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif';

  /* 统一采用双栏分镜画册排版导出（24 帧紧凑清晰，续走长局也不超画布上限） */
  const W = 960;
  const PAD = 40;
  const IN_W = W - PAD * 2;
  const GAP = 20;
  const COL_W = Math.floor((IN_W - GAP) / 2);
  const ART_H = Math.round(COL_W * 9 / 16);

  const mctx = document.createElement('canvas').getContext('2d');
  const titleStr = rv.title ? `《${rv.title}》` : `${r.nick} 的百年连环画`;
  const yrs = (r.score < 0 ? '−' : '') + Math.abs(r.score).toFixed(2);
  mctx.font = `400 16px ${SERIF}`;

  const measured = panels.map((d, idx) => {
    const head = comicHeadlineOf(d);
    const cap = comicCaptionOf(d);
    const lines = wrapCanvasLines(mctx, cap, COL_W - 24).slice(0, 3);
    const lineH = 23;
    const capH = 12 + 24 + (lines.length ? 6 + lines.length * lineH : 0) + 12;
    const net = parseNetInfo(d.tally, null, '');
    return {
      d, idx, head, lines, lineH, capH,
      totalH: ART_H + capH,
      net,
      img: imgMap.get(d.image || yearArtUrl(d.year)) || null,
      isFallback: !d.image,
    };
  });

  /* 预先排布双栏分镜并精确计算画布总高度 */
  const HEADER_H = 148;
  const layout = [];
  let curY = HEADER_H;
  const groups = [];
  const mainList = measured.filter(m => m.d.n <= mainMonths);
  const extraList = measured.filter(m => m.d.n > mainMonths);
  if (mainList.length) groups.push({ label: null, items: mainList });
  if (extraList.length) groups.push({ label: '两年之后 · 续走篇', items: extraList });
  for (const grp of groups) {
    if (grp.label) {
      layout.push({ kind: 'phase', y: curY, h: 52, text: grp.label });
      curY += 52;
    }
    for (let i = 0; i < grp.items.length; i += 2) {
      const left = grp.items[i];
      const right = grp.items[i + 1] || null;
      const rowH = Math.max(left.totalH, right ? right.totalH : 0);
      layout.push({ kind: 'panel', x: PAD, y: curY, w: COL_W, h: rowH, m: left });
      if (right) layout.push({ kind: 'panel', x: PAD + COL_W + GAP, y: curY, w: COL_W, h: rowH, m: right });
      curY += rowH + 16;
    }
  }

  /* 终章收官板尺寸 */
  const FIN_ART_H = finaleArt ? Math.round(IN_W * 9 / 16) : 0;
  mctx.font = `400 19px ${SERIF}`;
  const becameLines = rv.became ? wrapCanvasLines(mctx, rv.became, IN_W - 44).slice(0, 2) : [];
  const FIN_BODY_H = 128 + becameLines.length * 28;
  const FIN_H = FIN_ART_H + FIN_BODY_H;
  const FIN_Y = curY + 26;
  const H = FIN_Y + FIN_H + 84;

  const cvs = document.createElement('canvas');
  cvs.width = W;
  cvs.height = H;
  const c = cvs.getContext('2d');

  /* 暖宣纸底 + 古籍双线外框 */
  c.fillStyle = '#f5f2eb';
  c.fillRect(0, 0, W, H);
  c.strokeStyle = '#c2bdb2';
  c.lineWidth = 2;
  c.strokeRect(18, 18, W - 36, H - 36);
  c.strokeStyle = '#e0dcd2';
  c.lineWidth = 1;
  c.strokeRect(24, 24, W - 48, H - 48);

  /* 卷首抬头 */
  let tx = PAD;
  if (logoImg) {
    c.drawImage(logoImg, PAD, 44, 42, 42);
    tx = PAD + 52;
  }
  c.fillStyle = '#1e2431';
  c.font = `600 34px ${SERIF}`;
  c.fillText('这一百年', tx, 75);

  c.fillStyle = '#b53426';
  c.fillRect(tx + 150, 48, 76, 30);
  c.fillStyle = '#fbf4e6';
  c.font = `500 16px ${SERIF}`;
  c.fillText('连环画', tx + 164, 69);

  c.textAlign = 'right';
  c.fillStyle = '#4a5160';
  c.font = `500 19px ${SERIF}`;
  c.fillText(`${r.nick} · ${r.city}`, W - PAD, 62);
  c.fillStyle = '#6b6860';
  c.font = `400 15px ${SANS}`;
  c.fillText(`${r.year}.${String(r.month).padStart(2, '0')} — ${r.endYear}.${String(r.endMonth).padStart(2, '0')} · 共 ${panels.length} 帧`, W - PAD, 84);
  c.textAlign = 'left';

  c.fillStyle = '#1e2431';
  c.font = `600 22px ${SERIF}`;
  c.fillText(titleStr, PAD, 118);
  c.strokeStyle = '#1e2431';
  c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(PAD, 132); c.lineTo(W - PAD, 132); c.stroke();

  /* 绘制每一帧与连接线 */
  for (const item of layout) {
    if (item.kind === 'seam') {
      const cx = W / 2;
      c.strokeStyle = '#c8c3b8';
      c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(cx, item.y); c.lineTo(cx, item.y + item.h); c.stroke();
      c.save();
      c.translate(cx, item.y + item.h / 2);
      c.rotate(Math.PI / 4);
      c.fillStyle = '#b53426';
      c.fillRect(-4, -4, 8, 8);
      c.restore();
      continue;
    }
    if (item.kind === 'year' || item.kind === 'phase') {
      const cy = item.y + item.h / 2;
      const isPh = item.kind === 'phase';
      c.font = `600 ${isPh ? 17 : 15}px ${SERIF}`;
      const tw = c.measureText(item.text).width;
      c.save();
      c.strokeStyle = isPh ? 'rgba(181,52,38,0.45)' : '#c8c3b8';
      c.lineWidth = 1;
      if (isPh) c.setLineDash([6, 4]);
      c.beginPath();
      c.moveTo(PAD, cy); c.lineTo(W / 2 - tw / 2 - 14, cy);
      c.moveTo(W / 2 + tw / 2 + 14, cy); c.lineTo(W - PAD, cy);
      c.stroke();
      c.restore();
      c.fillStyle = isPh ? '#b53426' : '#5e5a52';
      c.textAlign = 'center';
      c.fillText(item.text, W / 2, cy + 5);
      c.textAlign = 'left';
      continue;
    }

    const { x, y, w, h, m } = item;
    const d = m.d;
    /* 帧外框（宣纸白底 + 墨线） */
    c.fillStyle = '#fffdf8';
    c.fillRect(x, y, w, h);

    /* 上半 16:9 画框 */
    const focal = m.isFallback ? [0.35, 0.5, 0.65][m.idx % 3] : 0.5;
    drawCoverImage(c, m.img, x, y, w, ART_H, focal);

    /* 左上帧号徽标 */
    const ym = `${d.year}.${String(d.month).padStart(2, '0')}`;
    const noTxt = `第 ${String(m.idx + 1).padStart(2, '0')} 帧 · ${ym}`;
    c.font = `500 12.5px ${SANS}`;
    const nw = c.measureText(noTxt).width + 18;
    const nh = 24;
    drawRoundedRectPath(c, x + 10, y + 10, nw, nh, 5);
    c.fillStyle = 'rgba(22, 20, 18, 0.76)';
    c.fill();
    c.fillStyle = '#fbf6ec';
    c.fillText(noTxt, x + 19, y + 26.5);

    /* 右上盈亏徽标 */
    if (m.net) {
      const nt = m.net.short;
      c.font = `600 12px ${SANS}`;
      const bw = c.measureText(nt).width + 18;
      drawRoundedRectPath(c, x + w - bw - 10, y + 10, bw, nh, 13);
      c.fillStyle = m.net.neg ? 'rgba(155, 39, 28, 0.86)' : 'rgba(42, 110, 74, 0.86)';
      c.fill();
      c.fillStyle = '#fbf8f2';
      c.fillText(nt, x + w - bw - 1, y + 26.5);
    }

    /* 下半配文栏 */
    c.strokeStyle = '#ded9ce';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(x, y + ART_H); c.lineTo(x + w, y + ART_H); c.stroke();

    const px = x + 12;
    let py = y + ART_H + 27;
    c.fillStyle = '#1e2431';
    c.font = `600 17px ${SERIF}`;
    let headTxt = m.head;
    const maxHeadW = w - 24;
    while (headTxt.length > 4 && c.measureText(headTxt).width > maxHeadW) headTxt = headTxt.slice(0, -1);
    if (headTxt !== m.head) headTxt += '…';
    c.fillText(headTxt, px, py);

    c.fillStyle = '#333742';
    c.font = `400 15.5px ${SERIF}`;
    for (const ln of m.lines) {
      py += m.lineH;
      c.fillText(ln, px, py);
    }

    c.strokeStyle = '#c5bfb3';
    c.lineWidth = 1.25;
    c.strokeRect(x, y, w, h);
  }

  /* 终章连接菱 + 收官画卷落款 */
  const fcx = W / 2;
  c.strokeStyle = '#c8c3b8';
  c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(fcx, curY); c.lineTo(fcx, FIN_Y); c.stroke();
  c.save();
  c.translate(fcx, curY + 13);
  c.rotate(Math.PI / 4);
  c.fillStyle = '#b53426';
  c.fillRect(-4, -4, 8, 8);
  c.restore();

  c.fillStyle = '#fffdf8';
  c.fillRect(PAD, FIN_Y, IN_W, FIN_H);
  if (finaleArt) {
    drawCoverImage(c, finaleArt, PAD, FIN_Y, IN_W, FIN_ART_H, 0.5);
    const stTxt = pctx.extra ? '终章 · 续走收官' : '终章 · 两年收官';
    c.font = `600 15px ${SERIF}`;
    const sw = c.measureText(stTxt).width + 22;
    drawRoundedRectPath(c, PAD + IN_W - sw - 12, FIN_Y + 12, sw, 30, 5);
    c.fillStyle = '#b53426';
    c.fill();
    c.fillStyle = '#fbf4e6';
    c.fillText(stTxt, PAD + IN_W - sw - 1, FIN_Y + 32);
  }

  let fy = FIN_Y + FIN_ART_H + 38;
  c.fillStyle = '#1e2431';
  c.font = `600 26px ${SERIF}`;
  c.fillText(titleStr, PAD + 22, fy);
  c.textAlign = 'right';
  c.fillStyle = '#b53426';
  c.font = `600 18px ${SERIF}`;
  c.fillText(`抵当时普通人 ${yrs} 年收入`, PAD + IN_W - 22, fy);
  c.textAlign = 'left';

  fy += 36;
  const earnStr = `净赚 ${r.yearEarnedText || ''}`;
  let earnSz = 30;
  c.font = `600 ${earnSz}px ${SERIF}`;
  while (earnSz > 20 && c.measureText(earnStr).width > IN_W - 280) {
    earnSz -= 2;
    c.font = `600 ${earnSz}px ${SERIF}`;
  }
  c.fillStyle = r.yearEarned < 0 ? '#9b271c' : '#1e2431';
  c.fillText(earnStr, PAD + 22, fy);
  c.textAlign = 'right';
  c.fillStyle = '#5c5951';
  c.font = `400 16px ${SANS}`;
  c.fillText(`折合今天美元：${r.worldUsdText || '—'}`, PAD + IN_W - 22, fy - 4);
  c.textAlign = 'left';

  if (becameLines.length) {
    c.fillStyle = '#4a5160';
    c.font = `400 19px ${SERIF}`;
    for (const bl of becameLines) {
      fy += 28;
      c.fillText(bl, PAD + 22, fy);
    }
  }
  c.strokeStyle = 'rgba(181, 52, 38, 0.55)';
  c.lineWidth = 1.5;
  c.strokeRect(PAD, FIN_Y, IN_W, FIN_H);

  /* 页脚 */
  const footY = H - 36;
  c.fillStyle = '#6b6860';
  c.font = `400 16px ${SERIF}`;
  c.fillText('《这一百年》 · 挑一年落脚，在那时候的人间过上两年', PAD, footY);
  c.textAlign = 'right';
  c.fillStyle = '#9b271c';
  c.font = `600 16px ${SANS}`;
  c.fillText('100y.swaylab.ai', W - PAD, footY);
  c.textAlign = 'left';

  const fileName = `这一百年-连环画-${r.nick}-${r.year}.jpg`;
  bindPosterOutput(cvs, fileName, `《这一百年》${r.nick}的${r.year}年连环画`, `${r.nick}的${r.year}年连环画`);
}

async function openSharePoster(pctx) {
  if (!pctx || !pctx.result) return toast('请先完成结算');
  const modal = $('#poster-modal');
  const imgEl = $('#poster-img');
  const wrapEl = imgEl && imgEl.parentElement;
  const dlEl = $('#poster-dl');
  const shareEl = $('#poster-share');
  const statusEl = $('#poster-status');
  showOverlay(modal);
  imgEl.hidden = true;
  imgEl.removeAttribute('src');
  imgEl.alt = '';
  if (wrapEl) wrapEl.hidden = true;
  shareEl.hidden = true;
  if (statusEl) { statusEl.hidden = false; statusEl.textContent = '正在生成分享海报…'; }

  const r = pctx.result;
  const rv = pctx.review || {};
  const ranks = pctx.ranks || {};
  let imgUrl = pctx.finaleImage || null;
  if (!imgUrl && pctx.id) {
    try {
      const res = await post('/api/finale-image', { id: pctx.id, extra: !!pctx.extra });
      if (res && res.ok && res.image) { imgUrl = res.image; pctx.finaleImage = imgUrl; }
    } catch (e) {}
  }
  const [art, logoImg] = await Promise.all([
    loadImgForCanvas(imgUrl || yearArtUrl(r.year)),
    loadImgForCanvas('/assets/apple-touch-icon.png'),
  ]);

  const W = 900;
  const PAD = 54;
  const IN_W = W - PAD * 2;
  const SERIF = '"Songti SC", "Noto Serif SC", "Source Han Serif SC", "SimSun", Georgia, serif';
  const SANS = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif';

  const measureCvs = document.createElement('canvas');
  const mctx = measureCvs.getContext('2d');
  mctx.font = `400 21px ${SERIF}`;
  const becameLines = rv.became ? wrapCanvasLines(mctx, '—— ' + rv.became, IN_W - 12).slice(0, 2) : [];
  mctx.font = `400 22px ${SERIF}`;
  const verdictLines = wrapCanvasLines(mctx, rv.verdict || '', IN_W - 16).slice(0, 16);
  mctx.font = `400 20px ${SANS}`;
  const turns = (rv.turns || []).slice(0, 4).map(t => {
    const prefix = t.when ? `${t.when} · ` : '';
    return wrapCanvasLines(mctx, prefix + (t.what || ''), IN_W - 44).slice(0, 2);
  });
  const turnsLineCount = turns.reduce((a, b) => a + b.length, 0);

  const artH = art ? Math.round(IN_W * 9 / 16) : 0;
  const cardH = 236;
  const hasRev = !!(rv.title || verdictLines.length);
  const revH = hasRev
    ? 38 + 42 + (becameLines.length ? becameLines.length * 32 + 6 : 0) + 14 + verdictLines.length * 36
    : 0;
  const turnsH = turns.length ? 36 + 30 + turnsLineCount * 32 : 0;
  const H = 116 + (artH ? artH + 34 : 0) + 24 + cardH + revH + turnsH + 112;

  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const c = cvs.getContext('2d');

  c.fillStyle = '#f5f2eb';
  c.fillRect(0, 0, W, H);
  c.strokeStyle = '#bebbb1';
  c.lineWidth = 2;
  c.strokeRect(22, 22, W - 44, H - 44);
  c.strokeStyle = '#dedbd2';
  c.lineWidth = 1;
  c.strokeRect(28, 28, W - 56, H - 56);

  let y = 84;
  let titleX = PAD;
  if (logoImg) {
    c.drawImage(logoImg, PAD, y - 40, 44, 44);
    titleX = PAD + 56;
  }
  c.fillStyle = '#1e2431';
  c.font = `600 40px ${SERIF}`;
  c.fillText('这一百年', titleX, y - 2);

  c.fillStyle = '#b7312a';
  c.fillRect(titleX + 184, y - 33, 86, 34);
  c.fillStyle = '#fbf4e6';
  c.font = `500 17px ${SERIF}`;
  c.fillText(pctx.extra ? '续走档案' : '两年档案', titleX + 194, y - 10);

  c.textAlign = 'right';
  c.fillStyle = '#4a5160';
  c.font = `500 22px ${SERIF}`;
  c.fillText(`${r.nick} · ${r.city}`, W - PAD, y - 16);
  c.fillStyle = '#67675f';
  c.font = `400 18px ${SANS}`;
  c.fillText(`${r.year} 年 ${r.month} 月 — ${r.endYear} 年 ${r.endMonth} 月`, W - PAD, y + 12);
  c.textAlign = 'left';

  y += 32;
  c.strokeStyle = '#1e2431';
  c.lineWidth = 2;
  c.beginPath(); c.moveTo(PAD, y); c.lineTo(W - PAD, y); c.stroke();

  if (art) {
    y += 26;
    c.save();
    c.fillStyle = '#fffdf8';
    c.fillRect(PAD - 4, y - 4, IN_W + 8, artH + 8);
    c.strokeStyle = '#bebbb1';
    c.lineWidth = 1.5;
    c.strokeRect(PAD - 4, y - 4, IN_W + 8, artH + 8);
    c.drawImage(art, PAD, y, IN_W, artH);
    c.restore();
    y += artH + 8;
  }

  y += 24;
  c.fillStyle = '#fffdf8';
  c.fillRect(PAD, y, IN_W, cardH);
  c.strokeStyle = '#dedbd2';
  c.lineWidth = 1.5;
  c.strokeRect(PAD, y, IN_W, cardH);
  c.fillStyle = '#b7312a';
  c.fillRect(PAD, y, 5, cardH);

  c.fillStyle = '#67675f';
  c.font = `400 19px ${SANS}`;
  const earnedHead = pctx.extra
    ? `前前后后 ${(r.months / 12).toFixed(0)} 年净赚（收官家底 ${r.endWorthText || ''}）`
    : `这两年净赚（收官家底 ${r.endWorthText || ''}）`;
  c.fillText(earnedHead, PAD + 28, y + 40);

  const earnedStr = String(r.yearEarnedText || '');
  let numSize = 62;
  c.font = `600 ${numSize}px ${SERIF}`;
  while (numSize > 36 && c.measureText(earnedStr).width > IN_W - 220) {
    numSize -= 4;
    c.font = `600 ${numSize}px ${SERIF}`;
  }
  c.fillStyle = r.yearEarned < 0 ? '#8e2620' : '#1e2431';
  c.fillText(earnedStr, PAD + 28, y + 108);

  const yrs = (r.score < 0 ? '−' : '') + Math.abs(r.score).toFixed(2);
  c.fillStyle = '#8e2620';
  c.font = `600 25px ${SERIF}`;
  c.fillText(`抵得上当时普通人 ${yrs} 年的收入`, PAD + 28, y + 152);

  c.save();
  c.translate(W - PAD - 108, y + 88);
  c.rotate(-0.14);
  c.strokeStyle = 'rgba(183, 49, 42, 0.82)';
  c.lineWidth = 3;
  c.strokeRect(-68, -28, 136, 56);
  c.lineWidth = 1;
  c.strokeRect(-62, -22, 124, 44);
  c.fillStyle = 'rgba(183, 49, 42, 0.85)';
  c.font = `600 24px ${SERIF}`;
  c.textAlign = 'center';
  c.fillText(pctx.extra ? '续走结算' : '两年结算', 0, 9);
  c.restore();

  c.strokeStyle = '#dedbd2';
  c.beginPath(); c.moveTo(PAD + 24, y + 176); c.lineTo(W - PAD - 24, y + 176); c.stroke();
  c.fillStyle = '#4a5160';
  c.font = `400 18px ${SANS}`;
  const col1 = `折合今天美元：${r.worldUsdText || '—'}`;
  const col2 = pctx.extra
    ? `两年之后榜第 ${ranks.rankExtra ?? '—'} 名`
    : `${r.year} 年榜第 ${ranks.rankYear ?? '—'} 名 · 总榜第 ${ranks.rankWorld ?? '—'} 名`;
  c.fillText(col1, PAD + 28, y + 212);
  c.textAlign = 'right';
  c.fillText(col2, W - PAD - 28, y + 212);
  c.textAlign = 'left';

  y += cardH;

  if (hasRev) {
    y += 38;
    c.fillStyle = '#8e2620';
    c.font = `600 17px ${SANS}`;
    c.fillText('【 记事人判词 】', PAD, y);

    y += 42;
    c.fillStyle = '#1e2431';
    c.font = `600 34px ${SERIF}`;
    c.fillText(rv.title || '这些日子', PAD, y);

    if (becameLines.length) {
      c.fillStyle = '#4a5160';
      c.font = `400 21px ${SERIF}`;
      for (const bl of becameLines) { y += 32; c.fillText(bl, PAD, y); }
      y += 6;
    }
    y += 14;
    c.fillStyle = '#1e2431';
    c.font = `400 22px ${SERIF}`;
    for (const ln of verdictLines) { y += 36; c.fillText(ln, PAD, y); }
  }

  if (turns.length) {
    y += 36;
    c.strokeStyle = '#dedbd2';
    c.beginPath(); c.moveTo(PAD, y); c.lineTo(W - PAD, y); c.stroke();
    y += 30;
    c.fillStyle = '#67675f';
    c.font = `600 18px ${SANS}`;
    c.fillText('关键转折', PAD, y);
    c.fillStyle = '#4a5160';
    c.font = `400 20px ${SANS}`;
    for (const tLines of turns) {
      for (let idx = 0; idx < tLines.length; idx++) {
        y += 32;
        if (idx === 0) { c.fillStyle = '#b7312a'; c.fillText('·', PAD + 4, y); c.fillStyle = '#4a5160'; }
        c.fillText(tLines[idx], PAD + 22, y);
      }
    }
  }

  const footY = H - 52;
  c.strokeStyle = '#dedbd2';
  c.beginPath(); c.moveTo(PAD, footY - 26); c.lineTo(W - PAD, footY - 26); c.stroke();
  c.fillStyle = '#67675f';
  c.font = `400 18px ${SERIF}`;
  c.fillText('《这一百年》 · 挑一年落脚，在那时候的人间过上两年', PAD, footY);
  c.textAlign = 'right';
  c.fillStyle = '#8e2620';
  c.font = `600 18px ${SANS}`;
  c.fillText('100y.swaylab.ai', W - PAD, footY);
  c.textAlign = 'left';

  const fileName = `这一百年-${r.nick}-${r.year}.jpg`;
  bindPosterOutput(cvs, fileName, `《这一百年》${r.nick}的${r.year}年`, `${r.nick}的${r.year}年分享海报`, '保存海报');
}

$('#poster-close').addEventListener('click', closePosterModal);
$('#poster-modal').addEventListener('click', e => { if (e.target.id === 'poster-modal') closePosterModal(); });

/* ── 6. 排行榜与我的记录（画报卡片流） ────────────────────── */
function setBoardMode(mode, opts = {}) {
  const next = mode === 'mine' ? 'mine' : 'world';
  const changed = next !== boardMode;
  boardMode = next;
  const isMine = boardMode === 'mine';
  $$('[data-bmode]').forEach(b => b.classList.toggle('on', b.dataset.bmode === boardMode));
  $('#rank-world').hidden = isMine;
  $('#rank-mine').hidden = !isMine;
  $('#board-filter').hidden = isMine;
  if (opts.animate && changed) {
    animatePanel(isMine ? $('#rank-mine') : $('#rank-world'), isMine ? 'panel-in-r' : 'panel-in-l');
  }
  $$('#top .nav-links button[data-go]').forEach(b => {
    if (b.dataset.go === 'board' || b.dataset.go === 'mine') {
      b.classList.toggle('on', b.dataset.go === (isMine ? 'mine' : 'board'));
    }
  });
}

$$('[data-bmode]').forEach(b => b.addEventListener('click', () => {
  const m = b.dataset.bmode;
  if (m === boardMode) return;
  setBoardMode(m, { animate: true });
  document.body.dataset.screen = m === 'mine' ? 'mine' : 'board';
  if (m === 'mine') loadMine();
  else loadBoard();
}));

$('#board-filter').addEventListener('change', e => {
  const v = e.target.value;
  if (v === 'world') { boardScope = 'world'; boardYear = null; }
  else if (v === 'extra') { boardScope = 'extra'; boardYear = null; }
  else { boardScope = 'world'; boardYear = Number(v) || null; }
  loadBoard();
});

function buildRankCard(opts) {
  const btn = el('button', 'rank-card');
  btn.type = 'button';
  if (opts.disabled) btn.disabled = true;

  const thumb = el('div', 'rank-thumb' + (opts.pendingArt && !opts.year ? ' pending' : ''));
  if (opts.pendingArt && opts.id) thumb.dataset.boardArt = opts.id;
  const thumbSrc = opts.image || yearThumbUrl(opts.year);
  if (thumbSrc) {
    const im = el('img');
    im.src = thumbSrc;
    im.alt = '';
    im.loading = 'lazy';
    im.decoding = 'async';
    thumb.appendChild(im);
  } else if (!opts.pendingArt) {
    thumb.appendChild(el('span', 'rank-mono', String(opts.year || '百').slice(-2)));
  }
  const badge = el('span', 'rank-no' + (opts.badgeCls ? ' ' + opts.badgeCls : ''), opts.badge);
  thumb.appendChild(badge);
  btn.appendChild(thumb);

  const info = el('div', 'rank-info');
  const nm = el('div', 'rank-name');
  nm.appendChild(document.createTextNode(opts.nick || '无名'));
  if (opts.title) nm.appendChild(el('span', 'rank-title', opts.title));
  info.appendChild(nm);
  info.appendChild(el('div', 'rank-sub num', opts.sub || ''));
  btn.appendChild(info);

  const sc = el('div', 'rank-score');
  sc.appendChild(el('b', 'num', opts.scoreTop || ''));
  if (opts.scoreSub) sc.appendChild(el('span', 'num', opts.scoreSub));
  btn.appendChild(sc);

  if (opts.onClick && !opts.disabled) btn.addEventListener('click', opts.onClick);
  return btn;
}

async function loadBoard() {
  const box = $('#rank-world');
  box.innerHTML = '<p class="wait">正在翻开榜单…</p>';
  const qs = boardScope === 'extra' ? '&scope=extra' : (boardYear ? '&year=' + boardYear : '');
  let d;
  try { d = await api('/api/board?limit=50' + qs); }
  catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }

  const sel = $('#board-filter');
  const curVal = boardScope === 'extra' ? 'extra' : (boardYear ? String(boardYear) : 'world');
  sel.innerHTML =
    `<option value="world">总榜 · 全部年份</option>
     <option value="extra">两年之后榜</option>` +
    (d.yearsWithRuns || []).map(r => `<option value="${r.year}">${r.year} 年（${r.n} 局）</option>`).join('');
  sel.value = curVal;

  box.innerHTML = '';
  if (!d.rows.length) {
    const eb = el('div', 'empty-box');
    eb.appendChild(el('p', '', boardScope === 'extra'
      ? '还没有人走完两年之后的续篇。'
      : boardYear ? `还没有人走完从 ${boardYear} 年开始的对局。` : '榜上还没有记录，去挑个年份开一局吧。'));
    const b = el('button', 'btn-ghost', '去挑个年份');
    b.type = 'button';
    b.addEventListener('click', () => go('pick'));
    eb.appendChild(b);
    box.appendChild(eb);
    return;
  }

  const pendingArts = [];
  for (const r of d.rows) {
    const ym = `${r.year}.${String(r.month).padStart(2, '0')}`;
    const sub = boardScope === 'extra'
      ? `${ym} · ${r.city || ''} · ${Math.round((r.months || 0) / 12 * 10) / 10} 年`
      : `${ym}${r.city ? ' · ' + r.city : ''}`;
    const scoreTop = boardYear ? (r.yearEarnedText || '') : (r.worldUsdText || '');
    const scoreSub = r.score != null ? `${Math.abs(r.score) < 10 ? r.score.toFixed(2) : r.score.toFixed(1)} 年` : '';
    const needArt = !r.image && r.rank <= 6 && !!r.id;
    if (needArt) pendingArts.push({ id: r.id, extra: boardScope === 'extra' });

    box.appendChild(buildRankCard({
      id: r.id,
      year: r.year,
      image: r.image,
      pendingArt: needArt,
      badge: String(r.rank),
      badgeCls: r.rank <= 3 ? 'top' : '',
      nick: r.nick,
      title: r.title || '',
      sub,
      scoreTop,
      scoreSub,
      onClick: r.id ? () => openPeek(r.id) : null,
    }));
  }
  if (pendingArts.length) fillBoardArts(pendingArts, 'board');
}

async function fillBoardArts(items, screen) {
  for (const raw of items.slice(0, 4)) {
    if (document.body.dataset.screen !== screen) return;
    const id = raw.id;
    const extra = !!raw.extra;
    try {
      const res = await post('/api/finale-image', { id, extra });
      const slot = document.querySelector(`.rank-thumb[data-board-art="${CSS.escape(id)}"]`);
      if (!slot) continue;
      slot.classList.remove('pending');
      if (res && res.ok && res.image) {
        const prevImg = slot.querySelector('img');
        if (prevImg) {
          prevImg.src = res.image;
        } else {
          const im = el('img');
          im.src = res.image;
          im.alt = '';
          slot.insertBefore(im, slot.firstChild);
        }
      }
    } catch (e) {
      const slot = document.querySelector(`.rank-thumb[data-board-art="${CSS.escape(id)}"]`);
      if (slot) slot.classList.remove('pending');
    }
  }
}

async function loadMine() {
  const box = $('#rank-mine');
  box.innerHTML = '';
  const showEmpty = () => {
    const eb = el('div', 'empty-box');
    eb.appendChild(el('p', '', '还没有玩过的记录，去挑个年份开一局吧。'));
    const b = el('button', 'btn-ghost', '去挑个年份');
    b.type = 'button';
    b.addEventListener('click', () => go('pick'));
    eb.appendChild(b);
    box.appendChild(eb);
  };
  if (!token) return showEmpty();

  box.innerHTML = '<p class="wait">正在翻找记录…</p>';
  let d;
  try { d = await api('/api/mine?token=' + encodeURIComponent(token)); }
  catch (e) { box.innerHTML = `<p class="empty">${esc(e.message)}</p>`; return; }

  box.innerHTML = '';
  if (!d.rows.length) return showEmpty();

  const pendingArts = [];
  for (const r of d.rows) {
    const old = r.mode && r.mode !== 'months24';
    const done = r.status === 'done';
    const playing = !old && (!done || r.extra_status === 'playing');
    const badge = old ? '旧版'
      : r.extra_status === 'playing' ? '续走中'
      : r.extra_status === 'done' ? '续走已结'
      : done ? '已结算' : '进行中';
    const badgeCls = playing ? 'live' : (done && !old ? 'top' : '');
    const sc = r.extra_status === 'done' && r.extra_score != null ? r.extra_score : r.score;
    const scoreTop = old ? '旧版记录'
      : playing ? '继续 →'
      : (sc == null ? '—' : `${Math.abs(sc) < 10 ? sc.toFixed(2) : sc.toFixed(1)} 年`);
    const scoreSub = old ? '' : (playing ? '接上进度' : '连环画 →');
    const title = r.title || (playing && r.stepN ? `第 ${r.stepN} / ${r.totalMonths || 24} 月` : '');
    const ym = `${r.year}.${String(r.month).padStart(2, '0')}`;
    const sub = `${ym}${r.city ? ' · ' + r.city : ''}`;
    const needArt = !r.image && !old && done && !!r.id;
    if (needArt) pendingArts.push({ id: r.id, extra: r.extra_status === 'done' });

    box.appendChild(buildRankCard({
      id: r.id,
      year: r.year,
      image: r.image,
      pendingArt: needArt,
      badge,
      badgeCls,
      nick: r.nick,
      title,
      sub,
      scoreTop,
      scoreSub,
      disabled: old,
      onClick: old ? null : (playing ? () => resume(r.id) : () => openDetail(r.id, 'mine')),
    }));
  }
  if (pendingArts.length) fillBoardArts(pendingArts, 'mine');
}

/* ── 续接进度与启动 ──────────────────────────────────────── */
function lastOf(state) {
  const last = state.recent && state.recent.length ? state.recent[state.recent.length - 1] : null;
  return last
    ? {
        list: last.list,
        headline: last.headline,
        summary: last.summary,
        story: last.story,
        assetsAdded: last.assetsAdded || [],
        image: last.image || null,
        tally: last.tally,
        refused: last.refused,
        entries: last.entries,
        moved: last.moved,
        worldTrace: last.worldTrace,
        at: { n: last.n, year: last.year, month: last.month },
      }
    : {
        headline: `${state.year} 年 ${state.month} 月 · ${state.city}`,
        summary: '已接上你上次的进度，写下这个月的打算即可继续。',
        story: '已接上你上次的进度，写下这个月的打算即可继续。',
        first: true,
      };
}

async function resume(id) {
  try {
    const d = await api(`/api/load?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
    run = { id, state: d.state };
    syncNavPlay();
    localStorage.setItem(RUN_KEY, id);
    renderPlay(lastOf(d.state));
    go('play');
  } catch (e) {
    toast(e.message);
  }
}

if (window.HYVoice) {
  voice = window.HYVoice.init({
    textarea: $('#list'),
    dock: $('#play-write'),
    pressLayer: $('#hold-press'),
    micBtn: $('#btn-mic'),
    hintBar: $('#mic-hint'),
    hintText: $('#mic-hint-text'),
    getTarget: () => (run && run.id && token ? { id: run.id, token } : null),
    isDisabled: () => {
      const ta = $('#list');
      const send = $('#send');
      return !run || !ta || ta.disabled || (send && send.classList.contains('busy'));
    },
    isActiveScreen: () =>
      document.body.dataset.screen === 'play' &&
      $('#sheet-bg').hidden &&
      $('#poster-modal').hidden &&
      $('#comic-modal').hidden,
    onSubmit: () => sendMonth(),
    onDraftChange: () => {
      const ta = $('#list');
      autoResizeTa(ta);
      const n = countHan(ta.value);
      const lim = (run && run.state.listLimit) || 500;
      const c = $('#count');
      c.textContent = `${n} / ${lim}`;
      c.classList.toggle('over', n > lim);
      updateDepthBar(n);
      if (!ta.disabled) $('#send').disabled = n === 0 || n > lim;
    },
  });
}

(async () => {
  try { await loadYears(); }
  catch (e) { $('#grid').innerHTML = `<p class="wait">年份加载失败：${esc(e.message)}</p>`; }

  if (location.hash.startsWith('#k=')) {
    const k = decodeURIComponent(location.hash.slice(3)).trim();
    if (k) {
      addToken(k, true);
      history.replaceState(null, '', location.pathname + location.search);
      go('mine', { instant: true });
      toast('已接回之前的记录');
      return;
    }
  }
  const rid = localStorage.getItem(RUN_KEY);
  if (rid && token) {
    try {
      const d = await api(`/api/load?id=${encodeURIComponent(rid)}&token=${encodeURIComponent(token)}`);
      if (d.status === 'playing') {
        run = { id: rid, state: d.state };
        syncNavPlay();
        renderPlay(lastOf(d.state));
        go('play', { instant: true });
        toast('已接上上次的进度');
      } else {
        localStorage.removeItem(RUN_KEY);
      }
    } catch (e) {
      localStorage.removeItem(RUN_KEY);
    }
  }
})();
