'use strict';
/* 为《这一百年》1926–2025 全部 100 个年份生成统一画风的历史风貌插画。
 *
 * 两阶段、可断点续跑：
 *   1. 根据 data/spine.json + data/years/<y>.json 的真实城市、时代氛围、当年大事与日常器物，
 *      为每一年撰写具象且互相区分的英文视觉分镜，缓存在 data/year-art-prompts.json。
 *   2. 并发调用 OpenRouter 图像模型生成 16:9 满幅画卷，并用 ImageMagick + cwebp
 *      裁成精确 16:9 满幅大图（960x540）与年历墙缩略图（360x202）。
 *
 * 用法：
 *   secret exec OPENROUTER_API_KEY -- node tools/gen-year-art.js --prompts-only
 *   secret exec OPENROUTER_API_KEY -- node tools/gen-year-art.js --years 1926,1988
 *   secret exec OPENROUTER_API_KEY -- node tools/gen-year-art.js --concurrency 8
 *   secret exec OPENROUTER_API_KEY -- node tools/gen-year-art.js --years 1944 --force
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const OR = require('./or.js');

const ROOT = path.join(__dirname, '..');
const SPINE_FILE = path.join(ROOT, 'data', 'spine.json');
const YEARS_DIR = path.join(ROOT, 'data', 'years');
const PROMPTS_FILE = path.join(ROOT, 'data', 'year-art-prompts.json');
const OUT_DIR = path.join(ROOT, 'public', 'assets', 'years');
const THUMB_DIR = path.join(OUT_DIR, 'thumb');

const TEXT_MODEL = process.env.HY_PROMPT_MODEL || 'google/gemini-3.1-flash-lite';
const IMG_MODEL = process.env.HY_YEAR_IMAGE_MODEL || 'google/gemini-3.1-flash-lite-image';

const args = process.argv.slice(2);
const hasFlag = f => args.includes(f);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const PROMPTS_ONLY = hasFlag('--prompts-only');
const FORCE = hasFlag('--force');
const FORCE_PROMPTS = hasFlag('--force-prompts');
const CONCURRENCY = Math.max(1, Math.min(12, Number(getArg('--concurrency', '8')) || 8));
const ONLY_YEARS = (() => {
  const raw = getArg('--years', '');
  if (!raw) return null;
  const set = new Set();
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (/^\d{4}-\d{4}$/.test(p)) {
      const [a, b] = p.split('-').map(Number);
      for (let y = a; y <= b; y++) set.add(y);
    } else if (/^\d{4}$/.test(p)) {
      set.add(Number(p));
    }
  }
  return set;
})();

const CITY_EN = {
  '上海': 'Shanghai',
  '武汉': 'Wuhan',
  '重庆': 'Chongqing',
  '天津': 'Tianjin',
  '沈阳': 'Shenyang',
  '北京': 'Beijing',
  '广州': 'Guangzhou',
  '深圳': 'Shenzhen',
  '海口': 'Haikou',
  '杭州': 'Hangzhou',
};

const ERAS = [
  {
    id: 'republic',
    range: [1926, 1949],
    label: 'Republican Era (1926–1949)',
    palette: 'warm sepia ochre, wet slate stone, amber oil-lamp glow, deep indigo twilight, weathered brick and crimson accent',
  },
  {
    id: 'founding',
    range: [1950, 1977],
    label: 'Early PRC Era (1950–1977)',
    palette: 'mineral teal, warm terracotta brick, dawn sunlit gold, poplar green, muted steel blue and warm tungsten glow',
  },
  {
    id: 'reform',
    range: [1978, 2008],
    label: 'Reform & Opening Era (1978–2008)',
    palette: 'sunlit ochre dust, coastal turquoise, vibrant emerald, warm sodium streetlamps, early dusk neon coral and cerulean sky',
  },
  {
    id: 'modern',
    range: [2009, 2025],
    label: 'Contemporary Era (2009–2025)',
    palette: 'crisp misty willow teal, warm amber glass reflections, twilight cyan-gold skyline, rain-slicked street shimmer',
  },
];

const LIGHTING_CYCLE = [
  'golden late-afternoon sunlight casting long warm shadows',
  'soft misty dawn light with pale warm mist on the horizon',
  'rain-slicked blue-hour twilight with warm glowing windows and streetlamps',
  'crisp clear autumn afternoon with vibrant sky and sunlit facades',
  'overcast silver-warm morning after rain with reflective wet pavement',
  'dramatic amber sunset breaking through scattered clouds',
  'bright spring midday light with dappled tree shadows',
  'quiet winter dusk with warm interior light spilling onto the street',
];

function loadYearRecords() {
  const spine = JSON.parse(fs.readFileSync(SPINE_FILE, 'utf8'));
  return spine.years.map(s => {
    const f = path.join(YEARS_DIR, `${s.year}.json`);
    const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    return {
      year: s.year,
      city: s.city,
      cityEn: CITY_EN[s.city] || s.city,
      era: c.era || '',
      mood: (c.economy && c.economy.mood) || '',
      events: (c.events || []).slice(0, 3).map(e => e.text),
      daily: ((c.tech && c.tech['日常']) || []).slice(0, 6),
      rare: ((c.tech && c.tech['稀罕']) || []).slice(0, 3),
      hasSwitch: !!s.switch,
    };
  });
}

async function generatePrompts(records) {
  let existing = {};
  if (!FORCE_PROMPTS && fs.existsSync(PROMPTS_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(PROMPTS_FILE, 'utf8')); } catch (e) {}
  }

  const batches = ERAS.map(era => {
    const items = records.filter(r => r.year >= era.range[0] && r.year <= era.range[1]);
    const need = items.filter(r => !existing[String(r.year)]);
    return { era, items, need };
  }).filter(b => b.need.length > 0);

  if (batches.length === 0) {
    console.log(`[prompts] 已有全部 ${Object.keys(existing).length} 年分镜，跳过生成。`);
    return existing;
  }

  console.log(`[prompts] 需要为 ${batches.reduce((s, b) => s + b.need.length, 0)} 个年份撰写视觉分镜（${batches.length} 批并行）…`);

  const sys = [
    'You are the art director for an illustrated Chinese century chronicle game (1926–2025).',
    'For each year provided, write ONE vivid, historically authentic, visually distinct English scene brief for a widescreen 16:9 editorial illustration.',
    'Rules:',
    '1. Ground every scene strictly in that exact year, city, landmarks, authentic architecture, period clothing, vehicles, and everyday objects.',
    '2. Make neighboring years visually distinct in setting, composition, camera angle, weather, and mood (street corner, riverfront dock, market, courtyard, factory floor, rooftop overlook, railway station, bridge, teahouse, construction site, lakeside dusk, etc.).',
    '3. Keep scenes painterly and cinematic with clear foreground, midground, and background depth. Focus on atmosphere, environment, and ordinary people in the scene (never close-up portraits).',
    '4. NEVER ask for legible text, banners with words, calendars, year numbers, newspapers with headlines, or readable signs. If storefronts or banners exist, explicitly describe them as blank/unreadable painterly strokes.',
    '5. Avoid modern anachronisms in older years, and avoid cartoonish clichés or sensitive political portraits/slogans — portray everyday urban life, architecture, commerce, transport, and seasonal atmosphere.',
    '6. Return ONLY a JSON object mapping 4-digit year strings (e.g. "1926") to concise 2-sentence English visual descriptions (45–70 words each).',
  ].join('\n');

  await Promise.all(batches.map(async ({ era, need }) => {
    const userLines = [
      `Era: ${era.label}`,
      `Era color feel: ${era.palette}`,
      '',
      'Generate a JSON object {"YYYY": "scene description..."} for these years:',
      ...need.map((r, idx) => {
        const light = LIGHTING_CYCLE[(r.year + idx) % LIGHTING_CYCLE.length];
        const ev = r.events.slice(0, 2).join(' | ');
        const objs = [...r.daily, ...r.rare].slice(0, 6).join('、');
        return `- ${r.year} (${r.cityEn}/${r.city}) [lighting hint: ${light}]: era="${r.era}"; mood="${r.mood}"; events="${ev}"; props="${objs}"`;
      }),
    ].join('\n');

    const raw = await OR.call(TEXT_MODEL, sys, userLines, { json: true, maxTokens: 6000, temperature: 0.75 });
    const parsed = OR.parseJson(raw);
    let ok = 0;
    for (const r of need) {
      const k = String(r.year);
      if (typeof parsed[k] === 'string' && parsed[k].trim().length > 20) {
        existing[k] = parsed[k].trim();
        ok++;
      }
    }
    console.log(`[prompts] ${era.id}: 完成 ${ok}/${need.length} 年`);
  }));

  /* 补漏（如果有偶发漏键，用本地模板兜底再补） */
  for (const r of records) {
    const k = String(r.year);
    if (!existing[k]) {
      const light = LIGHTING_CYCLE[r.year % LIGHTING_CYCLE.length];
      existing[k] = `Wide atmospheric street view of ${r.cityEn}, China in ${r.year}, ${light}. Authentic period architecture, pedestrians in historically accurate ${r.year} attire, local transport and everyday market life reflecting the city's historic mood, rich environmental depth from foreground street details to distant city skyline.`;
    }
  }

  fs.mkdirSync(path.dirname(PROMPTS_FILE), { recursive: true });
  const ordered = {};
  for (const r of records) ordered[String(r.year)] = existing[String(r.year)];
  fs.writeFileSync(PROMPTS_FILE, JSON.stringify(ordered, null, 2) + '\n');
  console.log(`[prompts] 已写入 ${PROMPTS_FILE}（共 ${Object.keys(ordered).length} 年）`);
  return ordered;
}

function eraOf(year) {
  return ERAS.find(e => year >= e.range[0] && year <= e.range[1]) || ERAS[0];
}

function buildImagePrompt(record, sceneDesc) {
  const era = eraOf(record.year);
  return [
    `Create a full-bleed edge-to-edge 16:9 widescreen cinematic editorial illustration of ${record.cityEn}, China in the year ${record.year}.`,
    `Scene: ${sceneDesc}`,
    `Unified Art Style: museum-grade Chinese historical editorial painting blending expressive fine ink-wash linework with rich painterly gouache and warm mineral watercolor washes, subtle warm paper luminosity, harmonious cinematic lighting, and rich depth. Palette guidance: ${era.palette}.`,
    `Composition: full-bleed widescreen artwork extending cleanly to all four edges of the image, open atmospheric upper sky/background and grounded street/river foreground with natural breathing room.`,
    `STRICT PROHIBITIONS: NO borders, NO frames, NO white or cream margins, NO polaroid or scroll edges, NO text, NO Chinese characters, NO English letters, NO numbers or dates, NO watermarks, NO red seals or artist signatures. Avoid close-up shop signs or banners; any distant storefronts, awnings, or lanterns must be blank or purely abstract painterly color strokes with zero legible writing.`,
  ].join('\n');
}

function callOpenRouterImage(prompt, timeoutMs = 55000) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('没有 OPENROUTER_API_KEY —— 用 secret exec 起');
  const payload = JSON.stringify({
    model: IMG_MODEL,
    modalities: ['image', 'text'],
    image_config: { aspect_ratio: '16:9' },
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/chat/completions',
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + key,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'http-referer': 'https://100y.swaylab.ai',
        'x-title': 'hundred-years-year-art',
      },
    }, res => {
      let s = '';
      res.on('data', c => s += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${s.slice(0, 260)}`));
        try {
          const r = JSON.parse(s);
          const msg = r.choices?.[0]?.message || {};
          const imgs = msg.images || [];
          let dataUrl = imgs[0]?.image_url?.url || imgs[0]?.url || '';
          if (!dataUrl && typeof msg.content === 'string') {
            const m = msg.content.match(/data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+/);
            if (m) dataUrl = m[0];
          }
          const match = String(dataUrl).match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/);
          if (!match) return reject(new Error('模型未返回有效图片数据'));
          const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
          const buffer = Buffer.from(match[2], 'base64');
          const cost = Number(r.usage?.cost || 0);
          resolve({ buffer, ext, cost });
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`超时 ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(payload);
  });
}

function runExec(bin, cmdArgs) {
  return new Promise((resolve, reject) => {
    execFile(bin, cmdArgs, (err, stdout, stderr) => {
      if (err) reject(new Error(`${bin} failed: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

async function processImage(rawBuf, rawExt, year) {
  const tmpRaw = path.join(OUT_DIR, `.tmp-${year}.${rawExt || 'png'}`);
  const tmpFullPng = path.join(OUT_DIR, `.tmp-${year}-full.png`);
  const tmpThumbPng = path.join(OUT_DIR, `.tmp-${year}-thumb.png`);
  const fullWebp = path.join(OUT_DIR, `${year}.webp`);
  const thumbWebp = path.join(THUMB_DIR, `${year}.webp`);

  fs.writeFileSync(tmpRaw, rawBuf);
  try {
    const dims = await runExec('/opt/homebrew/bin/magick', ['identify', '-format', '%w %h', tmpRaw]);
    const [w, h] = dims.split(/\s+/).map(Number);
    if (!(w > h && w >= 400)) {
      throw new Error(`非横图尺寸 ${w}x${h}`);
    }
    /* 轻裁 2% 边缘防白边/画框，再精确裁成 16:9 满幅 */
    await runExec('/opt/homebrew/bin/magick', [
      tmpRaw,
      '-gravity', 'center',
      '-crop', '96%x96%+0+0', '+repage',
      '-resize', '960x540^',
      '-gravity', 'center',
      '-extent', '960x540',
      tmpFullPng,
    ]);
    await runExec('/opt/homebrew/bin/cwebp', ['-quiet', '-q', '82', '-m', '5', tmpFullPng, '-o', fullWebp]);

    await runExec('/opt/homebrew/bin/magick', [
      tmpFullPng,
      '-resize', '360x202!',
      tmpThumbPng,
    ]);
    await runExec('/opt/homebrew/bin/cwebp', ['-quiet', '-q', '76', '-m', '5', tmpThumbPng, '-o', thumbWebp]);

    const fullSize = fs.statSync(fullWebp).size;
    const thumbSize = fs.statSync(thumbWebp).size;
    return { w, h, fullSize, thumbSize };
  } finally {
    for (const f of [tmpRaw, tmpFullPng, tmpThumbPng]) {
      try { fs.unlinkSync(f); } catch (e) {}
    }
  }
}

async function generateOne(record, promptText) {
  const fullWebp = path.join(OUT_DIR, `${record.year}.webp`);
  const thumbWebp = path.join(THUMB_DIR, `${record.year}.webp`);
  if (!FORCE && fs.existsSync(fullWebp) && fs.existsSync(thumbWebp) && fs.statSync(fullWebp).size > 5000) {
    return { year: record.year, skipped: true };
  }
  const fullPrompt = buildImagePrompt(record, promptText);
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const t0 = Date.now();
      const res = await callOpenRouterImage(fullPrompt, 60000);
      const info = await processImage(res.buffer, res.ext, record.year);
      return {
        year: record.year,
        ms: Date.now() - t0,
        cost: res.cost,
        fullKB: Math.round(info.fullSize / 1024),
        thumbKB: Math.round(info.thumbSize / 1024),
        rawDims: `${info.w}x${info.h}`,
      };
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  return { year: record.year, error: String(lastErr && lastErr.message || lastErr) };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(THUMB_DIR, { recursive: true });

  const records = loadYearRecords();
  const prompts = await generatePrompts(records);
  if (PROMPTS_ONLY) return;

  const targets = ONLY_YEARS ? records.filter(r => ONLY_YEARS.has(r.year)) : records;
  console.log(`[images] 准备生成 ${targets.length} 张年份画卷（模型=${IMG_MODEL}，并发=${CONCURRENCY}）…`);

  let done = 0, skipped = 0, failed = 0, totalCost = 0;
  const failures = [];
  const tStart = Date.now();

  await OR.pool(targets, CONCURRENCY, async r => {
    const res = await generateOne(r, prompts[String(r.year)]);
    if (res.skipped) {
      skipped++;
    } else if (res.error) {
      failed++;
      failures.push(res);
      console.error(`[FAIL] ${res.year}: ${res.error}`);
    } else {
      done++;
      totalCost += res.cost || 0;
      console.log(`[OK ${done + skipped}/${targets.length}] ${res.year} (${r.city}) · ${res.rawDims} -> ${res.fullKB}KB / ${res.thumbKB}KB · ${(res.ms / 1000).toFixed(1)}s`);
    }
  });

  const sec = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`\n完成：新生成 ${done}，跳过 ${skipped}，失败 ${failed}，耗时 ${sec}s，估算图像费用 $${totalCost.toFixed(3)}`);
  if (failures.length) {
    console.error('失败年份：', failures.map(x => `${x.year}(${x.error})`).join(', '));
    process.exitCode = 1;
  }
})();
