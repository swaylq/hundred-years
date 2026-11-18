'use strict';
/* 《这一百年》语音输入：完整移植本机 Hermit 语音交互逻辑（配色适配暖纸·墨黑·朱砂）。
 *
 * 包含：
 *   1. dictation-text  —— 游标处/末尾插入、并发手动编辑保留、选区映射、整段校对判定
 *   2. typewriter      —— 28ms 逐字吐字动画（短改写回退重写，长改写一步到位）
 *   3. asr-reduce      —— 流式 partial / final / 乱序 polished 三层归约
 *   4. mic-level       —— 音量 RMS 电平与 micLive 广播（直接写 --lv，不触发整页重排）
 *   5. voice-capture   —— 16kHz 单声道 PCM16 采集、20s 热麦复用、权限缓存、首音唤醒、静音检测、WAV 兜底切片
 *   6. asr-socket      —— /api/asr WebSocket 客户端（4s 预缓冲、16s 结束超时）
 *   7. dictation-core  —— 实时流式 → 静默降级 /api/transcribe → 停录 /api/transcribe/refine 完整编排
 *   8. hold-core + overlay —— 微信同心圆全屏遮罩（三态 primed/open/closed，上滑取消/编辑，松开发送）
 *   9. 三种入口：
 *      - 移动端空输入框未聚焦时「按住说话」（轻点聚焦、滑动滚屏放弃、长按弹同心圆、松开发送/取消/编辑）
 *      - 操作栏「语音」按钮（轻点自由听写开关、按住说话松手留框里、收尾时再点强制立即落地）
 *      - 桌面端按住右 Option（AltRight）随时口述，松手留在输入框
 */
(function () {
  /* ── 1. dictation-text ─────────────────────────────────────────── */
  const END_PUNCT = /[。！？.!?]$/;
  const ASCII_TAIL = /[A-Za-z0-9]$/;
  const ASCII_HEAD = /^[A-Za-z0-9]/;

  function joinSegments(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (ASCII_TAIL.test(a) && ASCII_HEAD.test(b)) return a + ' ' + b;
    return a + b;
  }

  function newClaim(draft, selStart, selEnd, atCaret) {
    if (!atCaret) return { before: draft, after: '', last: '' };
    const s = Math.max(0, Math.min(selStart, draft.length));
    const e = Math.max(s, Math.min(selEnd, draft.length));
    return { before: draft.slice(0, s), after: draft.slice(e), last: '' };
  }

  function foldTail(before, tail) {
    if (!before) return tail;
    if (!tail) return before;
    const trimmed = before.replace(/[ \t]+$/, '');
    if (!trimmed) return tail;
    if (trimmed.endsWith('\n')) return before + tail;
    if (END_PUNCT.test(trimmed)) return trimmed + ' ' + tail;
    return joinSegments(trimmed, tail);
  }

  function foldInsert(before, after, tail) {
    const left = foldTail(before, tail);
    if (!after) return left;
    if (!tail) return before + after;
    if (after.startsWith('\n') || after.startsWith(' ')) return left + after;
    return joinSegments(left, after);
  }

  function foldClaim(claim, tail) {
    return claim.after ? foldInsert(claim.before, claim.after, tail) : foldTail(claim.before, tail);
  }

  function commonPrefixLen(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    return i;
  }

  function commonSuffixLen(a, b, minPrefix) {
    const max = Math.min(a.length, b.length) - minPrefix;
    let i = 0;
    while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++;
    return i;
  }

  function mergeTranscriptUpdate(current, claim, nextTail, completeTail) {
    const prevFull = foldClaim(claim, claim.last);
    if (current === prevFull) {
      return {
        draft: foldClaim(claim, nextTail),
        claim: { before: claim.before, after: claim.after, last: nextTail },
        usedTail: nextTail,
      };
    }
    const targetTail = completeTail !== undefined ? completeTail : nextTail;
    // 用户在听写过程中手动编辑了文本框：把手动改的部分保留住，把新到的语音增量接进去
    const p = commonPrefixLen(prevFull, current);
    const s = commonSuffixLen(prevFull, current, p);
    const delta = targetTail.startsWith(claim.last) ? targetTail.slice(claim.last.length) : targetTail;

    if (!claim.last && current !== claim.before) {
      const nextClaim = { before: current, after: '', last: targetTail };
      return { draft: foldClaim(nextClaim, targetTail), claim: nextClaim, usedTail: targetTail };
    }

    const oldSpanStart = claim.before.length;
    const oldSpanEnd = prevFull.length - claim.after.length;
    const editInsideOrBefore = p <= oldSpanEnd && (prevFull.length - s) >= oldSpanStart;

    if (editInsideOrBefore && delta) {
      const nextBefore = current;
      const nextClaim = { before: nextBefore, after: '', last: delta };
      return { draft: foldTail(nextBefore, delta), claim: nextClaim, usedTail: targetTail };
    }

    const head = current.slice(0, current.length - claim.after.length);
    if (claim.after && current.endsWith(claim.after)) {
      const newBefore = head.endsWith(claim.last) ? head.slice(0, head.length - claim.last.length) : head;
      const nextClaim = { before: newBefore, after: claim.after, last: targetTail };
      return { draft: foldClaim(nextClaim, targetTail), claim: nextClaim, usedTail: targetTail };
    }

    const nextClaim = { before: current, after: '', last: delta };
    return { draft: foldTail(current, delta), claim: nextClaim, usedTail: targetTail };
  }

  function replaceTail(current, claim, refinedTail) {
    const prevFull = foldClaim(claim, claim.last);
    if (current !== prevFull) return null;
    return foldClaim(claim, refinedTail);
  }

  function mapTranscriptSelection(prev, next, start, end) {
    if (prev === next) return { start, end };
    const p = commonPrefixLen(prev, next);
    const s = commonSuffixLen(prev, next, p);
    const diff = next.length - prev.length;
    const mapPos = pos => {
      if (pos <= p) return pos;
      if (pos >= prev.length - s) return Math.max(0, pos + diff);
      return p + Math.max(0, next.length - p - s);
    };
    return { start: mapPos(start), end: mapPos(end) };
  }

  function worthRefining(text) {
    const t = String(text || '').trim();
    if (t.length >= 12) return true;
    const sents = t.split(/[。！？.!?]+/).filter(x => x.trim().length > 0);
    return sents.length >= 2;
  }

  /* ── 2. typewriter ─────────────────────────────────────────────── */
  const TYPE_TICK_MS = 28;
  const MAX_REWIND = 12;

  function typeFrame(shown, target, steps) {
    if (shown === target || steps <= 0) return shown;
    const pref = commonPrefixLen(shown, target);
    const toErase = shown.length - pref;
    if (toErase > MAX_REWIND) return target;
    let s = shown;
    let rem = steps;
    if (toErase > 0) {
      const cut = Math.min(toErase, rem);
      s = s.slice(0, s.length - cut);
      rem -= cut;
    }
    if (rem > 0 && s.length < target.length) {
      s = target.slice(0, Math.min(target.length, s.length + rem));
    }
    return s;
  }

  /* ── 3. asr-reduce ─────────────────────────────────────────────── */
  function emptyAsr() {
    return { segs: [], partial: '' };
  }

  function asrReduce(state, msg) {
    if (!msg || typeof msg !== 'object') return state;
    if (msg.type === 'partial') {
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (text === state.partial) return state;
      return { segs: state.segs, partial: text };
    }
    if (msg.type === 'final') {
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (!text) return { segs: state.segs, partial: '' };
      const segs = state.segs.slice();
      const idx = segs.findIndex(x => x.id === msg.segId);
      if (idx >= 0) segs[idx] = { id: msg.segId, text };
      else segs.push({ id: msg.segId, text });
      return { segs, partial: '' };
    }
    if (msg.type === 'polished') {
      const text = typeof msg.text === 'string' ? msg.text.trim() : '';
      if (!text) return state;
      const idx = state.segs.findIndex(x => x.id === msg.segId);
      if (idx < 0) return state;
      if (state.segs[idx].text === text) return state;
      const segs = state.segs.slice();
      segs[idx] = { id: msg.segId, text };
      return { segs, partial: state.partial };
    }
    return state;
  }

  function asrText(state) {
    let out = '';
    for (let i = 0; i < state.segs.length; i++) {
      out = joinSegments(out, state.segs[i].text);
    }
    if (state.partial) out = joinSegments(out, state.partial);
    return out;
  }

  /* ── 4. mic-level ──────────────────────────────────────────────── */
  const levelSubs = new Set();
  const liveSubs = new Set();
  let curMicLive = false;

  function publishMicLevel(rms) {
    const lv = Math.max(0, Math.min(1, rms));
    if (!curMicLive) {
      curMicLive = true;
      liveSubs.forEach(fn => { try { fn(true); } catch {} });
    }
    levelSubs.forEach(fn => { try { fn(lv); } catch {} });
  }

  function resetMicLevel() {
    if (curMicLive) {
      curMicLive = false;
      liveSubs.forEach(fn => { try { fn(false); } catch {} });
    }
    levelSubs.forEach(fn => { try { fn(0); } catch {} });
  }

  function subscribeMicLevel(fn) {
    levelSubs.add(fn);
    return () => levelSubs.delete(fn);
  }
  function subscribeMicLive(fn) {
    liveSubs.add(fn);
    return () => liveSubs.delete(fn);
  }
  function getMicLive() { return curMicLive; }

  /* ── 5. voice-capture ──────────────────────────────────────────── */
  const SAMPLE_RATE = 16000;
  const SCRIPT_BUFFER = 2048;
  const WARM_IDLE_MS = 20_000;
  const SILENCE_RMS = 0.01;
  const MAX_FALLBACK_SAMPLES = SAMPLE_RATE * 600; // 最多留 10 分钟兜底音频

  let micPerm = 'unknown'; // 'granted' | 'denied' | 'prompt' | 'unknown'
  let warmStream = null;
  let warmTimer = null;

  function canCaptureAudio() {
    return typeof navigator !== 'undefined' &&
      !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) &&
      typeof (window.AudioContext || window.webkitAudioContext) === 'function';
  }

  function releaseWarmMic() {
    if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
    if (warmStream) {
      try { warmStream.getTracks().forEach(t => t.stop()); } catch {}
      warmStream = null;
    }
  }

  function parkWarmMic(stream) {
    if (!stream || stream.getAudioTracks().every(t => t.readyState !== 'live')) {
      releaseWarmMic();
      return;
    }
    warmStream = stream;
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = setTimeout(releaseWarmMic, WARM_IDLE_MS);
  }

  function takeWarmMic() {
    if (warmTimer) { clearTimeout(warmTimer); warmTimer = null; }
    const s = warmStream;
    warmStream = null;
    if (s && s.getAudioTracks().some(t => t.readyState === 'live')) return s;
    if (s) { try { s.getTracks().forEach(t => t.stop()); } catch {} }
    return null;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') releaseWarmMic();
    });
  }

  async function refreshMicPermission() {
    if (!canCaptureAudio()) { micPerm = 'denied'; return micPerm; }
    if (warmStream && warmStream.getAudioTracks().some(t => t.readyState === 'live')) {
      micPerm = 'granted';
      return micPerm;
    }
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: 'microphone' });
        micPerm = st.state;
        st.onchange = () => { micPerm = st.state; };
        return micPerm;
      }
    } catch {}
    try {
      if (navigator.mediaDevices.enumerateDevices) {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const hasNamedMic = devs.some(d => d.kind === 'audioinput' && d.label);
        if (hasNamedMic) { micPerm = 'granted'; return micPerm; }
      }
    } catch {}
    return micPerm;
  }

  function canOpenMicSilently() {
    if (warmStream && warmStream.getAudioTracks().some(t => t.readyState === 'live')) return true;
    return micPerm === 'granted';
  }

  async function requestMicAccess() {
    if (!canCaptureAudio()) return { ok: false, reason: 'unsupported' };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micPerm = 'granted';
      parkWarmMic(stream);
      return { ok: true };
    } catch (err) {
      const name = err && err.name ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        micPerm = 'denied';
        return { ok: false, reason: 'denied' };
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return { ok: false, reason: 'no-device' };
      }
      return { ok: false, reason: 'error', message: err && err.message ? err.message : '' };
    }
  }

  function downsampleToInt16(input, inRate) {
    if (inRate === SAMPLE_RATE) {
      const out = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return out;
    }
    const ratio = inRate / SAMPLE_RATE;
    const outLen = Math.max(1, Math.floor(input.length / ratio));
    const out = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(input.length - 1, i0 + 1);
      const frac = pos - i0;
      const sample = input[i0] + (input[i1] - input[i0]) * frac;
      const s = Math.max(-1, Math.min(1, sample));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function encodeWavPcm16(chunks, sampleRate = SAMPLE_RATE) {
    let totalSamples = 0;
    for (let i = 0; i < chunks.length; i++) totalSamples += chunks[i].length;
    const dataBytes = totalSamples * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const v = new DataView(buf);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i)); };
    writeStr(0, 'RIFF');
    v.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    writeStr(36, 'data');
    v.setUint32(40, dataBytes, true);
    const dst = new Int16Array(buf, 44);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      dst.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  async function startVoiceCapture(handlers) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    let stream = takeWarmMic();
    const wasWarm = !!stream;
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micPerm = 'granted';
    }

    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch {}
    }

    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(SCRIPT_BUFFER, 1, 1);
    const zeroGain = ctx.createGain();
    zeroGain.gain.value = 0;

    let stopped = false;
    let heardSound = false;
    let smoothLv = 0;
    let totalSamples = 0;
    let markSample = 0;
    const ring = []; // { start, pcm }
    let ringSamples = 0;

    proc.onaudioprocess = ev => {
      if (stopped) return;
      const ch = ev.inputBuffer.getChannelData(0);
      let sumSq = 0;
      let nonZero = false;
      for (let i = 0; i < ch.length; i++) {
        const x = ch[i];
        if (x !== 0) nonZero = true;
        sumSq += x * x;
      }
      if (!heardSound) {
        if (!nonZero && !wasWarm) return; // 冷麦刚开时前几帧可能是全 0
        heardSound = true;
        if (handlers.onSound) handlers.onSound();
      }

      const rms = Math.sqrt(sumSq / Math.max(1, ch.length));
      const norm = Math.min(1, rms * 5.2);
      smoothLv = smoothLv * 0.55 + norm * 0.45;
      publishMicLevel(smoothLv);

      if (rms >= SILENCE_RMS) {
        if (handlers.onSpeech) handlers.onSpeech();
      } else {
        if (handlers.onSilence) handlers.onSilence();
      }

      const pcm = downsampleToInt16(ch, ctx.sampleRate);
      const start = totalSamples;
      totalSamples += pcm.length;

      ring.push({ start, pcm });
      ringSamples += pcm.length;
      while (ringSamples > MAX_FALLBACK_SAMPLES && ring.length > 1) {
        ringSamples -= ring.shift().pcm.length;
      }

      if (handlers.onPcm) {
        handlers.onPcm(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
      }
    };

    source.connect(proc);
    proc.connect(zeroGain);
    zeroGain.connect(ctx.destination);

    return {
      wasWarm,
      mark(endSample) {
        if (typeof endSample === 'number' && Number.isFinite(endSample) && endSample > markSample) {
          markSample = endSample;
        }
      },
      tailWav() {
        const slices = [];
        for (let i = 0; i < ring.length; i++) {
          const item = ring[i];
          const end = item.start + item.pcm.length;
          if (end <= markSample) continue;
          if (item.start >= markSample) slices.push(item.pcm);
          else slices.push(item.pcm.subarray(markSample - item.start));
        }
        return encodeWavPcm16(slices, SAMPLE_RATE);
      },
      allWav() {
        return encodeWavPcm16(ring.map(r => r.pcm), SAMPLE_RATE);
      },
      stop(keepWarm = true) {
        if (stopped) return;
        stopped = true;
        resetMicLevel();
        try { proc.onaudioprocess = null; } catch {}
        try { source.disconnect(); } catch {}
        try { proc.disconnect(); } catch {}
        try { zeroGain.disconnect(); } catch {}
        try { ctx.close(); } catch {}
        if (keepWarm && document.visibilityState === 'visible') {
          parkWarmMic(stream);
        } else {
          try { stream.getTracks().forEach(t => t.stop()); } catch {}
        }
      },
    };
  }

  /* ── 6. asr-socket ─────────────────────────────────────────────── */
  const PREOPEN_MAX_BYTES = 128 * 1024;
  const DONE_TIMEOUT_MS = 16_000;

  function toBase64Url(str) {
    const bytes = new TextEncoder().encode(String(str || ''));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function openAsrSocket(target, handlers) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${location.host}/api/asr/${encodeURIComponent(target.id)}`;
    const subproto = 'hy-token.b64_' + toBase64Url(target.token);

    let ws;
    try {
      ws = new WebSocket(wsUrl, [subproto]);
    } catch (err) {
      queueMicrotask(() => {
        if (handlers.onError) handlers.onError('无法建立语音连接', true);
      });
      return {
        sendPcm() {},
        stop() { return Promise.resolve(); },
        close() {},
      };
    }
    ws.binaryType = 'arraybuffer';

    let closed = false;
    let opened = false;
    let stopping = false;
    let preopen = [];
    let preopenBytes = 0;
    let doneResolve = null;
    let doneTimer = null;

    const finishDone = () => {
      if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
      if (doneResolve) { const r = doneResolve; doneResolve = null; r(); }
    };

    ws.onopen = () => {
      if (closed) { try { ws.close(); } catch {} return; }
      opened = true;
      for (let i = 0; i < preopen.length; i++) {
        try { ws.send(preopen[i]); } catch {}
      }
      preopen = [];
      preopenBytes = 0;
      if (stopping) {
        try { ws.send(JSON.stringify({ type: 'stop' })); } catch {}
      }
    };

    ws.onmessage = ev => {
      if (closed || typeof ev.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'ready') {
        if (handlers.onReady) handlers.onReady();
      } else if (msg.type === 'partial' || msg.type === 'final' || msg.type === 'polished') {
        if (handlers.onMessage) handlers.onMessage(msg);
      } else if (msg.type === 'done') {
        finishDone();
      } else if (msg.type === 'error') {
        if (handlers.onError) handlers.onError(msg.message || '语音连接失败', !!msg.fatal);
        if (msg.fatal) finishDone();
      }
    };

    ws.onerror = () => {
      if (!closed && !stopping && handlers.onError) {
        handlers.onError('语音连接异常', !opened);
      }
    };

    ws.onclose = ev => {
      closed = true;
      finishDone();
      if (!stopping && handlers.onClose) handlers.onClose(ev.code, ev.reason);
    };

    return {
      sendPcm(buf) {
        if (closed || stopping) return;
        if (opened && ws.readyState === WebSocket.OPEN) {
          try { ws.send(buf); } catch {}
          return;
        }
        preopen.push(buf);
        preopenBytes += buf.byteLength;
        while (preopenBytes > PREOPEN_MAX_BYTES && preopen.length > 1) {
          preopenBytes -= preopen.shift().byteLength;
        }
      },
      stop() {
        if (closed) return Promise.resolve();
        stopping = true;
        if (opened && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ type: 'stop' })); } catch {}
        }
        return new Promise(resolve => {
          doneResolve = resolve;
          doneTimer = setTimeout(() => {
            finishDone();
            try { ws.close(1000, 'timeout'); } catch {}
          }, DONE_TIMEOUT_MS);
        });
      },
      close() {
        closed = true;
        preopen = [];
        preopenBytes = 0;
        finishDone();
        try { ws.close(1000, 'abort'); } catch {}
      },
    };
  }

  /* ── 7. dictation-core + DictationEngine ───────────────────────── */
  const BATCH_MIN_BYTES = 6400; // ~0.2s 16kHz PCM
  const SILENCE_STOP_MS = 30_000;
  const MAX_DICTATION_MS = 20 * 60_000;
  const FINISH_MAX_MS = 12_000;

  function createDictationEngine({ getTarget, sink, onStateChange, onErrorHint }) {
    let phase = 'idle'; // 'idle' | 'listening' | 'finishing'
    let source = null;  // 'tap' | 'hold'
    let capture = null;
    let sock = null;
    let degraded = false;
    let asr = emptyAsr();
    let shown = '';
    let targetText = '';
    let rafId = 0;
    let lastTick = 0;
    let silenceTimer = null;
    let maxTimer = null;
    let runSeq = 0;
    let stopPromise = null;
    let forceCut = null;
    let everSpoke = false;

    const notify = () => {
      if (onStateChange) onStateChange({ phase, source, text: targetText, shown });
    };

    const stopTypewriter = () => {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    };

    const tickTypewriter = now => {
      rafId = 0;
      if (shown === targetText) return;
      if (!lastTick) lastTick = now;
      const steps = Math.floor((now - lastTick) / TYPE_TICK_MS);
      if (steps > 0) {
        lastTick += steps * TYPE_TICK_MS;
        const next = typeFrame(shown, targetText, steps);
        if (next !== shown) {
          shown = sink.setDictationTail(next, targetText);
          notify();
        }
      }
      if (shown !== targetText) {
        rafId = requestAnimationFrame(tickTypewriter);
      } else {
        lastTick = 0;
      }
    };

    const setTargetText = next => {
      targetText = next;
      if (shown === targetText) { notify(); return; }
      if (!rafId) {
        lastTick = 0;
        rafId = requestAnimationFrame(tickTypewriter);
      }
      notify();
    };

    const flushTypewriterNow = () => {
      stopTypewriter();
      if (shown !== targetText) {
        shown = sink.setDictationTail(targetText, targetText);
      }
      notify();
    };

    const clearTimers = () => {
      if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
      if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
    };

    const bumpSilence = id => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        if (runSeq === id && phase === 'listening') void stop(false);
      }, SILENCE_STOP_MS);
    };

    async function batchTranscribe(wavBlob, tgt) {
      if (!wavBlob || wavBlob.size < BATCH_MIN_BYTES) return '';
      const fd = new FormData();
      fd.append('audio', wavBlob, 'voice.wav');
      fd.append('id', tgt.id);
      fd.append('token', tgt.token);
      const res = await fetch('/api/transcribe', { method: 'POST', body: fd });
      if (!res.ok) return '';
      const j = await res.json();
      return typeof j.text === 'string' ? j.text.trim() : '';
    }

    async function refinePassage(text, preceding, tgt) {
      if (!worthRefining(text)) return null;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch('/api/transcribe/refine', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, preceding, id: tgt.id, token: tgt.token }),
          signal: ctrl.signal,
        });
        if (!res.ok) return null;
        const j = await res.json();
        return j && j.refined && typeof j.text === 'string' ? j.text.trim() : null;
      } catch {
        return null;
      } finally {
        clearTimeout(t);
      }
    }

    function start(src) {
      if (phase !== 'idle') return false;
      const tgt = getTarget();
      if (!tgt || !tgt.id || !tgt.token) {
        if (onErrorHint) onErrorHint('当前未在进行中的一局');
        return false;
      }
      if (!canCaptureAudio()) {
        if (onErrorHint) onErrorHint('当前浏览器不支持麦克风录音');
        return false;
      }

      const id = ++runSeq;
      phase = 'listening';
      source = src;
      degraded = false;
      everSpoke = false;
      asr = emptyAsr();
      shown = '';
      targetText = '';
      stopPromise = null;
      forceCut = null;

      sink.beginDictation(src === 'tap');
      notify();

      maxTimer = setTimeout(() => {
        if (runSeq === id && phase === 'listening') void stop(false);
      }, MAX_DICTATION_MS);

      sock = openAsrSocket(tgt, {
        onMessage(msg) {
          if (runSeq !== id) return;
          asr = asrReduce(asr, msg);
          if (msg.type === 'final' && typeof msg.endSample === 'number' && capture) {
            capture.mark(msg.endSample);
          }
          const txt = asrText(asr);
          if (txt) everSpoke = true;
          setTargetText(txt);
        },
        onError(_message, fatal) {
          if (runSeq !== id) return;
          if (fatal || !everSpoke) {
            degraded = true;
            if (sock) { sock.close(); sock = null; }
          }
        },
        onClose() {
          if (runSeq !== id || phase !== 'listening') return;
          degraded = true;
          sock = null;
        },
      });

      startVoiceCapture({
        onSound() {
          if (runSeq !== id) return;
          bumpSilence(id);
        },
        onSpeech() {
          if (runSeq !== id) return;
          everSpoke = true;
          bumpSilence(id);
        },
        onPcm(buf) {
          if (runSeq !== id || phase !== 'listening') return;
          if (sock && !degraded) sock.sendPcm(buf);
        },
      }).then(cap => {
        if (runSeq !== id || phase !== 'listening') {
          cap.stop(true);
          return;
        }
        capture = cap;
      }).catch(err => {
        if (runSeq !== id) return;
        const denied = err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
        if (denied) micPerm = 'denied';
        cancel();
        if (onErrorHint) {
          onErrorHint(denied ? '未获得麦克风权限，请在浏览器地址栏允许麦克风' : '麦克风启动失败，请重试');
        }
      });

      return true;
    }

    function stop(force = false) {
      if (phase === 'idle') return Promise.resolve({ text: '' });
      if (phase === 'finishing') {
        if (force && forceCut) forceCut();
        return stopPromise || Promise.resolve({ text: targetText });
      }

      const id = runSeq;
      const tgt = getTarget();
      const base = sink.dictationBase();
      phase = 'finishing';
      clearTimers();
      notify();

      const cap = capture;
      capture = null;
      if (cap) cap.stop(true);

      const activeSock = sock;
      sock = null;

      stopPromise = (async () => {
        let cut = false;
        const cutPromise = new Promise(resolve => {
          const t = setTimeout(() => { cut = true; resolve(); }, FINISH_MAX_MS);
          forceCut = () => { cut = true; clearTimeout(t); resolve(); };
        });

        try {
          if (activeSock && !degraded) {
            await Promise.race([activeSock.stop(), cutPromise]);
            if (cut) activeSock.close();
          }
          if (runSeq !== id) return { text: '' };

          // 若实时通道降级，或末尾还有未出句的录音，静默走整段兜底 /api/transcribe
          const needBatch = !cut && cap && tgt && (degraded || (!asrText(asr) && everSpoke));
          if (needBatch) {
            const wav = degraded && asr.segs.length > 0 ? cap.tailWav() : cap.allWav();
            const batchText = await Promise.race([
              batchTranscribe(wav, tgt).catch(() => ''),
              cutPromise.then(() => ''),
            ]);
            if (runSeq !== id) return { text: '' };
            if (batchText) {
              const merged = asr.segs.length > 0
                ? joinSegments(asr.segs.map(x => x.text).join(''), batchText)
                : batchText;
              targetText = merged;
            }
          }

          flushTypewriterNow();

          // 通读校对：只在实时模式产出足够长的内容、且未强行中断时执行
          const finalRaw = targetText.trim();
          if (!cut && finalRaw && !degraded && tgt && worthRefining(finalRaw)) {
            const refined = await Promise.race([
              refinePassage(finalRaw, base, tgt),
              cutPromise.then(() => null),
            ]);
            if (runSeq === id && refined && refined !== finalRaw) {
              targetText = refined;
              shown = refined;
              sink.refineDictationTail(refined);
            }
          }

          if (runSeq !== id) return { text: '' };
          const outText = targetText.trim();
          sink.endDictation(false);
          phase = 'idle';
          source = null;
          forceCut = null;
          notify();
          return { text: outText };
        } catch {
          if (runSeq === id) {
            flushTypewriterNow();
            sink.endDictation(false);
            phase = 'idle';
            source = null;
            forceCut = null;
            notify();
          }
          return { text: targetText.trim() };
        }
      })();

      return stopPromise;
    }

    function cancel() {
      if (phase === 'idle') return;
      runSeq++;
      clearTimers();
      stopTypewriter();
      if (capture) { capture.stop(true); capture = null; }
      if (sock) { sock.close(); sock = null; }
      sink.endDictation(true);
      phase = 'idle';
      source = null;
      asr = emptyAsr();
      shown = '';
      targetText = '';
      stopPromise = null;
      forceCut = null;
      notify();
    }

    return {
      start,
      stop,
      cancel,
      getPhase: () => phase,
      getSource: () => source,
      getText: () => targetText,
    };
  }

  /* ── 8. hold-core ──────────────────────────────────────────────── */
  const HOLD_MS = 180;
  const PRIME_MS = 140;
  const BAIL_PX = 10;
  const SLIDE_PX = 64;
  const PILL_MIN_PX = 24;
  const TAP_MAX_MS = 500;
  const ENTER_MS = 480;
  const LEAVE_MS = 200;

  const DROP = 419;
  const R_DOME = 540;
  const R_OUT = 620;
  const BAND = 62;
  const CAP = 46.5;
  const ZONE_H = 224;
  const LABEL_D = 114;
  const R_MID = R_OUT - BAND / 2;
  const PILL_BOTTOM = 100;
  const PILL_HEIGHT = 105;
  const PILL_GUTTER = 15;

  function midAt(d) {
    return Math.sqrt(R_MID * R_MID - d * d) - DROP;
  }

  function holdBailed(dx, dy) {
    return Math.hypot(dx, dy) > BAIL_PX;
  }

  function holdReleaseIsTap(pressMs, zone, heard) {
    return Number.isFinite(pressMs) && pressMs >= 0 && pressMs < TAP_MAX_MS && zone === 'send' && !heard;
  }

  function holdZoneAt({ dx, dy, x, y, cancel, edit, previous }) {
    const travelled = Math.hypot(dx, dy) > PILL_MIN_PX;
    const onPill = r => !!r && travelled && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    if (onPill(cancel)) return 'cancel';
    if (onPill(edit)) return 'edit';
    const near = r => !!r && travelled &&
      x >= r.left - 10 && x <= r.right + 10 && y >= r.top - 10 && y <= r.bottom + 10;
    if (previous === 'cancel' && (near(cancel) || dx <= -(SLIDE_PX - 12))) return 'cancel';
    if (previous === 'edit' && (near(edit) || dx >= SLIDE_PX - 12)) return 'edit';
    if (dx <= -SLIDE_PX) return 'cancel';
    if (dx >= SLIDE_PX) return 'edit';
    return 'send';
  }

  function holdClock(sec) {
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function holdCancelling(zone, phase) {
    return zone === 'cancel' && phase === 'listening';
  }

  function holdBlobMoving(open, zone, phase) {
    return open && phase === 'listening' && zone !== 'cancel';
  }

  function isTouchPrimary() {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(pointer: coarse)').matches;
  }

  /* ── 9. HoldToTalkOverlay（三态同心圆遮罩，DOM 持久复用不重建大圆） ── */
  const MIC_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
  const SPIN_SVG = '<svg class="hy-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>';

  function createHoldOverlay() {
    let root = null;
    let stage = null;
    let meterRow = null;
    let meterDot = null;
    let meterText = null;
    let authWrap = null;
    let authHint = null;
    let blobWrap = null;
    let blobCore = null;
    let blobGlow = null;
    let bubbleWrap = null;
    let bubbleCard = null;
    let bubbleTail = null;
    let transcriptBox = null;
    let transcriptSpan = null;
    let zonesWrap = null;
    let sendDisc = null;
    let sendLabel = null;
    let sendSpin = null;
    let sendLabelTxt = null;
    let leftBaseArc = null;
    let leftCancelArc = null;
    let leftLabel = null;
    let rightArc = null;
    let rightLabel = null;
    let hitCancel = null;
    let hitEdit = null;

    let clockTimer = null;
    let clockSecs = 0;
    let clockRunning = false;
    let leaveTimer = null;
    let unsubLevel = null;
    let unsubLive = null;

    let state = {
      pose: 'closed', // 'primed' | 'open' | 'closed'
      zone: 'send',
      phase: 'listening',
      text: '',
      exitZone: 'send',
      mounted: false,
      capturing: false,
      runId: 0,
    };

    function buildDom() {
      root = document.createElement('div');
      root.className = 'hold-overlay';
      root.style.setProperty('--hold-enter', `${ENTER_MS}ms`);
      root.style.setProperty('--hold-leave', `${LEAVE_MS}ms`);
      root.dataset.state = 'closed';
      root.setAttribute('aria-hidden', 'true');

      /* 舞台：计时器 + 声波球 / 实时转写气泡 */
      stage = document.createElement('div');
      stage.className = 'hold-stage';
      stage.style.setProperty('--lv', '0');

      meterRow = document.createElement('div');
      meterRow.className = 'hold-meter num';
      meterDot = document.createElement('span');
      meterDot.className = 'hold-meter-dot';
      meterText = document.createElement('span');
      meterText.className = 'hold-meter-text';
      meterRow.appendChild(meterDot);
      meterRow.appendChild(meterText);
      stage.appendChild(meterRow);

      /* 权限引导态 */
      authWrap = document.createElement('div');
      authWrap.className = 'hold-bubble';
      authWrap.hidden = true;
      authWrap.innerHTML =
        `<div class="hold-tint hold-bubble-card is-auth">
           <span class="hold-auth-row">${MIC_SVG}<span>需要麦克风权限才能说话</span></span>
         </div>
         <span class="hold-tint hold-bubble-tail is-auth" aria-hidden="true"></span>`;
      stage.appendChild(authWrap);

      /* 声波球（未出字前） */
      blobWrap = document.createElement('div');
      blobWrap.className = 'hold-blob';
      const ring = document.createElement('span');
      ring.className = 'hold-blob-ring';
      ring.setAttribute('aria-hidden', 'true');
      blobGlow = document.createElement('span');
      blobGlow.className = 'hold-blob-glow';
      blobGlow.setAttribute('aria-hidden', 'true');
      blobCore = document.createElement('span');
      blobCore.className = 'hold-blob-core';
      blobCore.setAttribute('aria-hidden', 'true');
      blobWrap.appendChild(ring);
      blobWrap.appendChild(blobGlow);
      blobWrap.appendChild(blobCore);
      stage.appendChild(blobWrap);

      /* 实时转写气泡（出字后） */
      bubbleWrap = document.createElement('div');
      bubbleWrap.className = 'hold-bubble';
      bubbleWrap.hidden = true;
      bubbleCard = document.createElement('div');
      bubbleCard.className = 'hold-tint hold-bubble-card';
      transcriptBox = document.createElement('span');
      transcriptBox.className = 'hold-transcript';
      transcriptSpan = document.createElement('span');
      transcriptSpan.className = 'hold-transcript-inner';
      transcriptBox.appendChild(transcriptSpan);
      bubbleCard.appendChild(transcriptBox);
      bubbleTail = document.createElement('span');
      bubbleTail.className = 'hold-tint hold-bubble-tail';
      bubbleTail.setAttribute('aria-hidden', 'true');
      bubbleWrap.appendChild(bubbleCard);
      bubbleWrap.appendChild(bubbleTail);
      stage.appendChild(bubbleWrap);

      authHint = document.createElement('div');
      authHint.className = 'hold-auth-hint';
      authHint.textContent = '松手 · 允许使用麦克风';
      authHint.hidden = true;
      stage.appendChild(authHint);

      root.appendChild(stage);

      /* 底部同心圆目标区 */
      zonesWrap = document.createElement('div');
      zonesWrap.className = 'hold-zones';
      zonesWrap.style.height = `${ZONE_H}px`;

      const spread = document.createElement('div');
      spread.className = 'hold-zones-spread';
      spread.style.setProperty('--hold-drop', `${DROP}px`);

      /* 1) 中间发送圆盘 */
      sendDisc = document.createElement('div');
      sendDisc.className = 'hold-lit hold-send-disc';
      sendDisc.style.width = `${R_DOME * 2}px`;
      sendDisc.style.height = `${R_DOME * 2}px`;
      sendDisc.style.marginLeft = `${-R_DOME}px`;
      sendDisc.style.bottom = `${-(DROP + R_DOME)}px`;
      spread.appendChild(sendDisc);

      sendLabel = document.createElement('div');
      sendLabel.className = 'hold-zone-label hold-send-label';
      sendLabel.style.bottom = `${R_DOME - DROP - 47}px`;
      sendSpin = document.createElement('span');
      sendSpin.className = 'hold-send-spin';
      sendSpin.innerHTML = SPIN_SVG;
      sendSpin.hidden = true;
      sendLabelTxt = document.createElement('span');
      sendLabelTxt.textContent = '松开发送';
      sendLabel.appendChild(sendSpin);
      sendLabel.appendChild(sendLabelTxt);
      spread.appendChild(sendLabel);

      /* 构造左右半弧（圆环 + 圆头端帽同层合并不叠亮） */
      const makeArcLayer = (side, extraCls) => {
        const left = side === 'left';
        const wrap = document.createElement('div');
        wrap.className = `hold-lit hold-arc-layer ${extraCls || ''}`;

        const clip = document.createElement('div');
        clip.className = 'hold-arc-clip';
        clip.style.clipPath = left
          ? `inset(0 calc(50% + ${CAP}px) 0 0)`
          : `inset(0 0 0 calc(50% + ${CAP}px))`;

        const ringEl = document.createElement('div');
        ringEl.className = 'hold-arc-ring';
        ringEl.style.width = `${R_OUT * 2}px`;
        ringEl.style.height = `${R_OUT * 2}px`;
        ringEl.style.marginLeft = `${-R_OUT}px`;
        ringEl.style.bottom = `${-(DROP + R_OUT)}px`;
        ringEl.style.borderWidth = `${BAND}px`;
        clip.appendChild(ringEl);
        wrap.appendChild(clip);

        const capEl = document.createElement('div');
        capEl.className = 'hold-arc-cap';
        capEl.style.width = `${BAND}px`;
        capEl.style.height = `${BAND}px`;
        capEl.style.marginLeft = `${left ? -(CAP + BAND / 2) : (CAP - BAND / 2)}px`;
        capEl.style.bottom = `${midAt(CAP) - BAND / 2}px`;
        wrap.appendChild(capEl);

        return wrap;
      };

      /* 2) 左弧：取消（常态暖白浅透明度，滑入交叉淡入朱砂红） */
      leftBaseArc = makeArcLayer('left', 'is-paper');
      leftCancelArc = makeArcLayer('left', 'is-cancel');
      spread.appendChild(leftBaseArc);
      spread.appendChild(leftCancelArc);

      leftLabel = document.createElement('div');
      leftLabel.className = 'hold-zone-label hold-arc-label';
      leftLabel.style.marginLeft = `${-LABEL_D - 60}px`;
      leftLabel.style.bottom = `${midAt(LABEL_D) - 10}px`;
      leftLabel.textContent = '取消';
      spread.appendChild(leftLabel);

      /* 3) 右弧：编辑 */
      rightArc = makeArcLayer('right', 'is-paper');
      spread.appendChild(rightArc);

      rightLabel = document.createElement('div');
      rightLabel.className = 'hold-zone-label hold-arc-label';
      rightLabel.style.marginLeft = `${LABEL_D - 60}px`;
      rightLabel.style.bottom = `${midAt(LABEL_D) - 10}px`;
      rightLabel.textContent = '编辑';
      spread.appendChild(rightLabel);

      zonesWrap.appendChild(spread);
      root.appendChild(zonesWrap);

      /* 不可见的稳定命中框（不随滑入动画飘移） */
      hitCancel = document.createElement('div');
      hitCancel.className = 'hold-hit';
      hitCancel.style.left = '0';
      hitCancel.style.right = `calc(50% + ${PILL_GUTTER}px)`;
      hitCancel.style.bottom = `${PILL_BOTTOM}px`;
      hitCancel.style.height = `${PILL_HEIGHT}px`;

      hitEdit = document.createElement('div');
      hitEdit.className = 'hold-hit';
      hitEdit.style.left = `calc(50% + ${PILL_GUTTER}px)`;
      hitEdit.style.right = '0';
      hitEdit.style.bottom = `${PILL_BOTTOM}px`;
      hitEdit.style.height = `${PILL_HEIGHT}px`;

      root.appendChild(hitCancel);
      root.appendChild(hitEdit);

      root.addEventListener('transitionend', ev => {
        if (ev.target === root && ev.propertyName === 'opacity' && state.pose === 'closed') {
          unmountDom();
        }
      });
    }

    function mountDom() {
      if (state.mounted) return;
      if (!root) buildDom();
      document.body.appendChild(root);
      state.mounted = true;
      unsubLevel = subscribeMicLevel(lv => {
        if (!stage) return;
        const moving = holdBlobMoving(state.pose === 'open', state.zone, state.phase);
        stage.style.setProperty('--lv', moving ? lv.toFixed(3) : '0');
      });
      unsubLive = subscribeMicLive(live => {
        state.capturing = live;
        syncDom();
      });
    }

    function unmountDom() {
      if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
      stopClock();
      if (unsubLevel) { unsubLevel(); unsubLevel = null; }
      if (unsubLive) { unsubLive(); unsubLive = null; }
      if (root && root.parentNode) root.parentNode.removeChild(root);
      state.mounted = false;
    }

    function startClock() {
      if (clockRunning) return;
      clockRunning = true;
      clockTimer = setInterval(() => {
        clockSecs++;
        if (meterText && !meterText.classList.contains('hold-warming-label')) {
          meterText.textContent = holdClock(clockSecs);
        }
      }, 1000);
    }

    function stopClock() {
      clockRunning = false;
      if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
    }

    function syncDom() {
      if (!state.mounted || !root) return;
      const open = state.pose === 'open';
      const isAuth = state.phase === 'auth';
      const cancelling = holdCancelling(state.zone, state.phase);
      const warming = state.phase === 'listening' && !state.capturing && state.pose !== 'closed';
      const quiet = cancelling || warming;

      root.dataset.state = state.pose;
      root.dataset.zone = state.zone;
      if (state.pose === 'closed') root.dataset.exit = state.exitZone;
      else delete root.dataset.exit;
      if (warming) root.dataset.warming = '';
      else delete root.dataset.warming;
      if (open) root.removeAttribute('aria-hidden');
      else root.setAttribute('aria-hidden', 'true');

      /* 计时器与指示点 */
      meterRow.hidden = isAuth;
      meterDot.classList.toggle('is-quiet', quiet);
      if (open && state.phase === 'listening' && state.capturing) startClock();
      else stopClock();

      if (warming) {
        meterText.className = 'hold-meter-text hold-warming-label';
        meterText.textContent = '麦克风准备中';
      } else {
        meterText.className = 'hold-meter-text';
        meterText.textContent = holdClock(clockSecs);
      }

      /* 权限 / 转写气泡 / 声波球 三选一 */
      authWrap.hidden = !isAuth;
      authHint.hidden = !isAuth;
      const hasText = !isAuth && !!state.text;
      bubbleWrap.hidden = !hasText;
      blobWrap.hidden = isAuth || hasText;

      if (hasText) {
        transcriptSpan.textContent = state.text;
        bubbleCard.classList.toggle('is-cancelling', cancelling);
        bubbleTail.classList.toggle('is-cancelling', cancelling);
        transcriptBox.classList.toggle('is-cancelling', cancelling);
      }
      if (!isAuth && !hasText) {
        blobCore.classList.toggle('is-dimmed', cancelling);
        blobCore.classList.toggle('is-warming', !cancelling && warming);
        blobGlow.classList.toggle('is-quiet', quiet);
      }
      if (!holdBlobMoving(open, state.zone, state.phase)) {
        stage.style.setProperty('--lv', '0');
      }

      /* 底部同心圆目标（权限态隐藏） */
      zonesWrap.hidden = isAuth;
      hitCancel.hidden = !open || isAuth;
      hitEdit.hidden = !open || isAuth;

      if (!isAuth) {
        const sendLit = state.zone === 'send';
        const cancelLit = cancelling;
        const editLit = state.zone === 'edit' && state.phase === 'listening';

        sendDisc.style.opacity = sendLit ? '0.9' : '0.13';
        sendLabel.classList.toggle('is-lit', sendLit);
        sendSpin.hidden = state.phase !== 'finishing';
        sendLabelTxt.textContent = state.phase === 'finishing' ? '正在发送' : '松开发送';

        leftBaseArc.style.opacity = cancelLit ? '0' : '0.14';
        leftCancelArc.style.opacity = cancelLit ? '0.94' : '0';
        leftLabel.classList.toggle('is-cancel-lit', cancelLit);
        leftLabel.classList.toggle('is-lit', false);
        leftLabel.textContent = cancelLit ? '松开取消' : '取消';

        rightArc.style.opacity = editLit ? '0.96' : '0.14';
        rightLabel.classList.toggle('is-lit', editLit);
        rightLabel.textContent = editLit ? '松开编辑' : '编辑';
      }
    }

    return {
      prime(phase) {
        if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
        state.runId++;
        clockSecs = 0;
        stopClock();
        state.pose = 'primed';
        state.zone = 'send';
        state.phase = phase;
        state.text = '';
        state.capturing = getMicLive();
        mountDom();
        syncDom();
      },
      open(phase, text) {
        if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
        const fresh = !state.mounted || state.pose === 'closed';
        if (fresh) {
          state.runId++;
          clockSecs = 0;
          stopClock();
          mountDom();
          // 强制一次 layout，确保从 primed/closed 过渡流畅
          void root.offsetHeight;
        }
        state.pose = 'open';
        state.zone = 'send';
        state.phase = phase;
        state.text = text || '';
        state.capturing = getMicLive();
        syncDom();
      },
      update({ zone, phase, text }) {
        if (zone !== undefined) state.zone = zone;
        if (phase !== undefined) state.phase = phase;
        if (text !== undefined) state.text = text;
        syncDom();
      },
      close(exitZone, snapshotText) {
        if (!state.mounted) return;
        if (state.pose === 'primed') {
          unmountDom();
          return;
        }
        state.pose = 'closed';
        state.exitZone = exitZone || state.zone;
        if (snapshotText !== undefined) state.text = snapshotText;
        stopClock();
        syncDom();
        if (leaveTimer) clearTimeout(leaveTimer);
        leaveTimer = setTimeout(unmountDom, LEAVE_MS + 80);
      },
      hitBoxes() {
        if (!state.mounted || !hitCancel || !hitEdit || hitCancel.hidden) return { cancel: null, edit: null };
        const cr = hitCancel.getBoundingClientRect();
        const er = hitEdit.getBoundingClientRect();
        return {
          cancel: cr.width > 0 ? { left: cr.left, top: cr.top, right: cr.right, bottom: cr.bottom } : null,
          edit: er.width > 0 ? { left: er.left, top: er.top, right: er.right, bottom: er.bottom } : null,
        };
      },
    };
  }

  /* ── 10. 主控制器（绑定 #list、#btn-mic、#hold-press、右 Option） ── */
  function init(opts) {
    const ta = opts.textarea;
    const dock = opts.dock;
    const pressLayer = opts.pressLayer;
    const micBtn = opts.micBtn;
    const hintBar = opts.hintBar;
    const hintText = opts.hintText;
    const getTarget = opts.getTarget;
    const isDisabled = opts.isDisabled;
    const isActiveScreen = opts.isActiveScreen || (() => true);
    const onSubmit = opts.onSubmit;
    const onDraftChange = opts.onDraftChange;

    let touch = isTouchPrimary();
    let voiceReady = canCaptureAudio();
    let focused = document.activeElement === ta;
    let claim = null;
    let dictating = false;
    let finishing = false;
    let holdPressed = false;
    let gestureLive = false;
    let warmingTimer = null;
    let warmingShown = false;
    let hintTimer = null;

    const overlay = createHoldOverlay();

    /* ── 权限与提示条 ── */
    refreshMicPermission();

    function showHint(msg, ms = 4200) {
      if (!hintBar || !hintText) return;
      if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
      if (!msg) {
        hintBar.hidden = true;
        return;
      }
      hintText.textContent = msg;
      hintBar.hidden = false;
      if (ms > 0) {
        hintTimer = setTimeout(() => { hintBar.hidden = true; }, ms);
      }
    }

    async function askPermissionNow() {
      showHint('请允许使用麦克风', 0);
      const res = await requestMicAccess();
      if (res.ok) {
        showHint('已授权 · 再按一下开始说话', 3200);
      } else if (res.reason === 'denied') {
        showHint('麦克风被拒绝，请在浏览器地址栏或系统设置里开启权限', 6000);
      } else if (res.reason === 'no-device') {
        showHint('未检测到可用的麦克风设备', 4500);
      } else {
        showHint('暂时无法打开麦克风，请稍后再试', 4500);
      }
      syncUi();
      return res.ok;
    }

    /* ── DictationDraft sink（直接读写 #list 且保留并发手动编辑） ── */
    const sink = {
      beginDictation(atCaret) {
        const val = ta.value;
        const s = typeof ta.selectionStart === 'number' ? ta.selectionStart : val.length;
        const e = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : val.length;
        const useCaret = atCaret && (focused || s < val.length);
        claim = newClaim(val, s, e, useCaret);
      },
      setDictationTail(tail, completeTail) {
        if (!claim) return tail;
        const prev = ta.value;
        const s0 = ta.selectionStart;
        const e0 = ta.selectionEnd;
        const res = mergeTranscriptUpdate(prev, claim, tail, completeTail);
        claim = res.claim;
        if (res.draft !== prev) {
          ta.value = res.draft;
          if (focused && typeof s0 === 'number' && typeof e0 === 'number') {
            const mapped = mapTranscriptSelection(prev, res.draft, s0, e0);
            try { ta.setSelectionRange(mapped.start, mapped.end); } catch {}
          }
          if (onDraftChange) onDraftChange();
        }
        syncUi();
        return res.usedTail;
      },
      refineDictationTail(refined) {
        if (!claim) return;
        const prev = ta.value;
        const next = replaceTail(prev, claim, refined);
        if (next === null || next === prev) return;
        claim = { before: claim.before, after: claim.after, last: refined };
        const s0 = ta.selectionStart;
        const e0 = ta.selectionEnd;
        ta.value = next;
        if (focused && typeof s0 === 'number' && typeof e0 === 'number') {
          const mapped = mapTranscriptSelection(prev, next, s0, e0);
          try { ta.setSelectionRange(mapped.start, mapped.end); } catch {}
        }
        if (onDraftChange) onDraftChange();
        syncUi();
      },
      dictationBase() {
        return claim ? claim.before : '';
      },
      endDictation(discard) {
        if (discard && claim) {
          const restored = claim.before + claim.after;
          if (ta.value !== restored) {
            ta.value = restored;
            if (onDraftChange) onDraftChange();
          }
        }
        claim = null;
        syncUi();
      },
    };

    /* ── DictationEngine 实例 ── */
    let holdOverlayActive = false;
    let holdZone = 'send';

    const engine = createDictationEngine({
      getTarget,
      sink,
      onErrorHint(msg) { showHint(msg, 4500); },
      onStateChange({ phase, text }) {
        dictating = phase !== 'idle';
        finishing = phase === 'finishing';
        if (holdOverlayActive) {
          overlay.update({
            text,
            phase: finishing ? 'finishing' : 'listening',
          });
        }
        syncWarming();
        syncUi();
      },
    });

    function syncWarming() {
      const needWarm = dictating && !finishing && !holdPressed && !getMicLive();
      if (!needWarm) {
        if (warmingTimer) { clearTimeout(warmingTimer); warmingTimer = null; }
        warmingShown = false;
      } else if (!warmingShown && !warmingTimer) {
        warmingTimer = setTimeout(() => {
          warmingTimer = null;
          if (dictating && !finishing && !holdPressed && !getMicLive()) {
            warmingShown = true;
            syncUi();
          }
        }, 150);
      }
    }

    subscribeMicLive(() => {
      syncWarming();
      syncUi();
    });

    /* ── 界面同步（占位词、麦克风按钮、press-layer 可见性、光标隐藏） ── */
    function syncUi() {
      const disabled = isDisabled();
      const live = getMicLive();
      const showWarming = dictating && !finishing && !holdPressed && !live && warmingShown;
      const micLit = dictating && !holdPressed && live;

      /* press-layer：仅移动端、非禁用、未聚焦且空框（或手势进行中）启用 */
      const wantPressLayer = touch && voiceReady && !disabled && ((ta.value === '' && !focused) || gestureLive);
      if (pressLayer) pressLayer.hidden = !wantPressLayer;

      if (dock) {
        if (holdPressed) dock.dataset.holdPressed = '';
        else delete dock.dataset.holdPressed;
        dock.classList.toggle('is-dictating', dictating && !holdPressed);
      }

      /* 听写中未手动聚焦时隐藏闪动光标 */
      ta.style.caretColor = (dictating && !focused) ? 'transparent' : '';

      /* 占位词梯级 */
      if (disabled) {
        ta.placeholder = '本月已结算';
      } else if (dictating && !holdPressed) {
        if (live) ta.placeholder = '正在听…';
        else if (warmingShown) ta.placeholder = '麦克风准备中…';
        else ta.placeholder = touch ? '写下这个月要办的事 · 按住说话' : '写下这个月要办的事…';
      } else {
        ta.placeholder = (touch && voiceReady) ? '写下这个月要办的事 · 按住说话' : '写下这个月要办的事…';
      }

      /* 麦克风按钮状态 */
      if (micBtn) {
        micBtn.hidden = !voiceReady || disabled;
        micBtn.disabled = disabled;
        micBtn.classList.toggle('is-lit', micLit);
        micBtn.classList.toggle('is-warming', showWarming || finishing);
        micBtn.setAttribute('aria-pressed', String(dictating));
        micBtn.setAttribute('aria-label', dictating ? '停止语音输入' : '语音输入');
        micBtn.title = showWarming
          ? '麦克风准备中 · 点一下取消'
          : dictating
            ? '正在听 · 点一下结束'
            : '语音输入 · 点一下或按住说话，文字留在输入框（也可按住右 Option）';
        const iconEl = micBtn.querySelector('.mic-icon');
        const labelEl = micBtn.querySelector('.mic-label');
        if (iconEl) iconEl.innerHTML = (finishing || showWarming) ? SPIN_SVG : MIC_SVG;
        if (labelEl) labelEl.textContent = finishing ? '整理中' : dictating ? '听写中' : '语音';
      }
    }

    ta.addEventListener('focus', () => { focused = true; syncUi(); });
    ta.addEventListener('blur', () => { focused = false; syncUi(); });
    ta.addEventListener('input', () => { syncUi(); });

    if (window.matchMedia) {
      const mq = window.matchMedia('(pointer: coarse)');
      const onMq = e => { touch = e.matches; syncUi(); };
      if (mq.addEventListener) mq.addEventListener('change', onMq);
    }

    /* ── 入口 A：移动端空框「按住说话」（同心圆全屏遮罩 + 松开发送） ── */
    let holdPtrId = null;
    let holdStartX = 0;
    let holdStartY = 0;
    let holdDownAt = 0;
    let holdPrimeTimer = null;
    let holdOpenTimer = null;
    let holdMode = 'none'; // 'none' | 'pending' | 'auth' | 'active'
    let holdRects = { cancel: null, edit: null };
    let removeBackstops = null;

    function clearHoldTimers() {
      if (holdPrimeTimer) { clearTimeout(holdPrimeTimer); holdPrimeTimer = null; }
      if (holdOpenTimer) { clearTimeout(holdOpenTimer); holdOpenTimer = null; }
    }

    function detachBackstops() {
      if (removeBackstops) { removeBackstops(); removeBackstops = null; }
    }

    function attachBackstops(ptrId) {
      detachBackstops();
      const onWinDown = e => {
        if (e.pointerId !== ptrId) interruptHold();
      };
      const onWinTouchEnd = e => {
        if (e.touches && e.touches.length === 0 && holdPtrId !== null) finishHoldGesture();
      };
      const onLost = () => interruptHold();
      const onVis = () => { if (document.visibilityState === 'hidden') interruptHold(); };

      window.addEventListener('pointerdown', onWinDown, true);
      window.addEventListener('touchend', onWinTouchEnd, true);
      window.addEventListener('touchcancel', onLost, true);
      window.addEventListener('blur', onLost);
      window.addEventListener('resize', onLost);
      document.addEventListener('visibilitychange', onVis);

      removeBackstops = () => {
        window.removeEventListener('pointerdown', onWinDown, true);
        window.removeEventListener('touchend', onWinTouchEnd, true);
        window.removeEventListener('touchcancel', onLost, true);
        window.removeEventListener('blur', onLost);
        window.removeEventListener('resize', onLost);
        document.removeEventListener('visibilitychange', onVis);
      };
    }

    function resetHoldState() {
      clearHoldTimers();
      detachBackstops();
      holdPtrId = null;
      holdMode = 'none';
      holdPressed = false;
      gestureLive = false;
      holdOverlayActive = false;
      holdZone = 'send';
      holdRects = { cancel: null, edit: null };
      syncUi();
    }

    function interruptHold() {
      if (holdMode === 'none') return;
      const mode = holdMode;
      const z = holdZone;
      const snap = engine.getText();
      resetHoldState();
      if (mode === 'active') {
        if (z === 'cancel') {
          engine.cancel();
          overlay.close('cancel', snap);
        } else {
          void engine.stop(false);
          overlay.close('edit', snap);
        }
      } else {
        engine.cancel();
        overlay.close('cancel', '');
      }
    }

    async function finishHoldGesture() {
      const mode = holdMode;
      const pressMs = Date.now() - holdDownAt;
      const z = holdZone;
      const heard = !!engine.getText().trim();

      if (mode === 'none') return;

      if (mode === 'pending') {
        // 未满 180ms 抬手：就是轻点打字
        resetHoldState();
        engine.cancel();
        overlay.close('cancel', '');
        ta.focus();
        return;
      }

      if (mode === 'auth') {
        resetHoldState();
        overlay.close('cancel', '');
        // 同步在 pointerup 手势里拉起系统麦克风授权弹窗
        void askPermissionNow();
        return;
      }

      // mode === 'active'
      if (holdReleaseIsTap(pressMs, z, heard)) {
        resetHoldState();
        engine.cancel();
        overlay.close('cancel', '');
        ta.focus();
        return;
      }

      if (z === 'cancel') {
        const snap = engine.getText();
        resetHoldState();
        engine.cancel();
        overlay.close('cancel', snap);
        return;
      }

      if (z === 'edit') {
        const snap = engine.getText();
        resetHoldState();
        overlay.close('edit', snap);
        void engine.stop(false);
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        return;
      }

      // z === 'send'：等待最终转写与校对落完，直接发出这个月
      clearHoldTimers();
      detachBackstops();
      holdPtrId = null;
      holdMode = 'none';
      holdPressed = false;
      gestureLive = false;
      overlay.update({ phase: 'finishing', zone: 'send' });
      syncUi();

      const res = await engine.stop(false);
      const finalText = (res && res.text) || ta.value.trim();
      holdOverlayActive = false;
      overlay.close('send', finalText);
      syncUi();

      if (ta.value.trim()) {
        if (onSubmit) onSubmit();
      } else {
        showHint('没听清，再试一次', 2800);
      }
    }

    if (pressLayer) {
      pressLayer.addEventListener('contextmenu', e => e.preventDefault());

      pressLayer.addEventListener('pointerdown', e => {
        if (!e.isPrimary || e.pointerType !== 'touch') return;
        if (isDisabled() || engine.getPhase() !== 'idle') return;
        e.preventDefault();

        holdPtrId = e.pointerId;
        holdStartX = e.clientX;
        holdStartY = e.clientY;
        holdDownAt = Date.now();
        holdMode = 'pending';
        holdZone = 'send';
        holdPressed = true;
        gestureLive = true;
        try { pressLayer.setPointerCapture(e.pointerId); } catch {}
        syncUi();

        const silent = canOpenMicSilently();
        if (silent) {
          // 按下即预热采集，不丢头两个字
          engine.start('hold');
        }

        holdPrimeTimer = setTimeout(() => {
          holdPrimeTimer = null;
          if (holdMode !== 'pending') return;
          overlay.prime(silent ? 'listening' : 'auth');
        }, PRIME_MS);

        holdOpenTimer = setTimeout(() => {
          holdOpenTimer = null;
          if (holdMode !== 'pending') return;
          if (!silent) {
            holdMode = 'auth';
            holdOverlayActive = true;
            overlay.open('auth', '');
            attachBackstops(holdPtrId);
          } else {
            holdMode = 'active';
            holdOverlayActive = true;
            overlay.open('listening', engine.getText());
            requestAnimationFrame(() => { holdRects = overlay.hitBoxes(); });
            attachBackstops(holdPtrId);
          }
        }, HOLD_MS);
      });

      pressLayer.addEventListener('pointermove', e => {
        if (e.pointerId !== holdPtrId || holdMode === 'none') return;
        const dx = e.clientX - holdStartX;
        const dy = e.clientY - holdStartY;

        if (holdMode === 'pending') {
          if (holdBailed(dx, dy)) {
            // 确认前手指明显滑动：让给页面滚动
            try { pressLayer.releasePointerCapture(e.pointerId); } catch {}
            resetHoldState();
            engine.cancel();
            overlay.close('cancel', '');
          }
          return;
        }

        if (holdMode === 'active') {
          if (!holdRects.cancel && !holdRects.edit) holdRects = overlay.hitBoxes();
          const nextZone = holdZoneAt({
            dx, dy,
            x: e.clientX, y: e.clientY,
            cancel: holdRects.cancel,
            edit: holdRects.edit,
            previous: holdZone,
          });
          if (nextZone !== holdZone) {
            holdZone = nextZone;
            overlay.update({ zone: nextZone });
          }
        }
      });

      pressLayer.addEventListener('pointerup', e => {
        if (e.pointerId !== holdPtrId) return;
        try { pressLayer.releasePointerCapture(e.pointerId); } catch {}
        void finishHoldGesture();
      });

      pressLayer.addEventListener('pointercancel', e => {
        if (e.pointerId !== holdPtrId) return;
        interruptHold();
      });

      pressLayer.addEventListener('lostpointercapture', e => {
        if (e.pointerId !== holdPtrId) return;
        if (holdMode === 'active' || holdMode === 'auth') void finishHoldGesture();
        else if (holdMode === 'pending') interruptHold();
      });
    }

    /* ── 入口 B：操作栏「语音」按钮（轻点开关听写 / 按住说话松手留框） ── */
    let micPtrId = null;
    let micHoldTimer = null;
    let micHeld = false;
    let micNeedAuth = false;
    let micStartedOnDown = false;
    let micClickSwallowed = false;
    let micClickTimer = null;

    function swallowMicClick() {
      micClickSwallowed = true;
      if (micClickTimer) clearTimeout(micClickTimer);
      micClickTimer = setTimeout(() => { micClickSwallowed = false; micClickTimer = null; }, 450);
    }

    function clearMicBtnGesture() {
      if (micHoldTimer) { clearTimeout(micHoldTimer); micHoldTimer = null; }
      micPtrId = null;
      micHeld = false;
      micNeedAuth = false;
      micStartedOnDown = false;
    }

    if (micBtn) {
      micBtn.addEventListener('contextmenu', e => e.preventDefault());

      micBtn.addEventListener('pointerdown', e => {
        if (!e.isPrimary || e.button > 0 || isDisabled()) return;
        e.preventDefault();
        swallowMicClick();
        micPtrId = e.pointerId;
        micHeld = false;
        micNeedAuth = false;
        micStartedOnDown = false;
        try { micBtn.setPointerCapture(e.pointerId); } catch {}

        const p = engine.getPhase();
        if (p !== 'idle') {
          // 已在听写或整理中：松手时结束（整理中再点则强制立即落地）
          return;
        }

        if (!canOpenMicSilently()) {
          micNeedAuth = true;
          return;
        }

        micStartedOnDown = engine.start('tap');
        micHoldTimer = setTimeout(() => {
          micHoldTimer = null;
          if (micPtrId !== null && micStartedOnDown) micHeld = true;
        }, HOLD_MS);
      });

      micBtn.addEventListener('pointerup', e => {
        if (e.pointerId !== micPtrId) return;
        try { micBtn.releasePointerCapture(e.pointerId); } catch {}
        const wasAuth = micNeedAuth;
        const wasHeld = micHeld;
        const started = micStartedOnDown;
        clearMicBtnGesture();

        if (wasAuth) {
          void askPermissionNow();
          return;
        }
        if (!started) {
          // 原本已在听写或整理：点一下停；整理中再点强制立即停
          const force = engine.getPhase() === 'finishing';
          void engine.stop(force);
          return;
        }
        if (wasHeld) {
          // 按住超过 180ms：松手即停，文字留在输入框里
          void engine.stop(false);
        }
        // 否则是轻点（<180ms）：保持自由听写状态，再点一次停
      });

      const onMicCancel = e => {
        if (e.pointerId !== micPtrId) return;
        const wasHeld = micHeld;
        clearMicBtnGesture();
        if (wasHeld) void engine.stop(false);
      };
      micBtn.addEventListener('pointercancel', onMicCancel);
      micBtn.addEventListener('lostpointercapture', onMicCancel);

      // 键盘回车/空格无障碍触发
      micBtn.addEventListener('click', () => {
        if (micClickSwallowed) { micClickSwallowed = false; return; }
        if (isDisabled()) return;
        if (engine.getPhase() !== 'idle') {
          void engine.stop(engine.getPhase() === 'finishing');
          return;
        }
        if (!canOpenMicSilently()) {
          void askPermissionNow();
          return;
        }
        engine.start('tap');
      });
    }

    /* ── 入口 C：桌面端按住右 Option（AltRight）随时听写 ── */
    let optTimer = null;
    let optActive = false;
    let optAuthPending = false;

    function cancelOptArm() {
      if (optTimer) { clearTimeout(optTimer); optTimer = null; }
    }

    window.addEventListener('keydown', e => {
      if (e.code === 'AltRight') {
        if (e.repeat || !isActiveScreen() || isDisabled()) return;
        if (optActive || optTimer || engine.getPhase() !== 'idle') return;
        optAuthPending = false;
        optTimer = setTimeout(() => {
          optTimer = null;
          if (!isActiveScreen() || isDisabled()) return;
          if (!canOpenMicSilently()) {
            optAuthPending = true;
            showHint('松开右 Option 后允许使用麦克风', 0);
            return;
          }
          if (engine.start('hold')) optActive = true;
        }, HOLD_MS);
        return;
      }
      // 蓄力期内按了别的键（例如 macOS Option 组合键）→ 立即放弃
      if (optTimer) cancelOptArm();
    });

    const releaseOpt = () => {
      cancelOptArm();
      if (optAuthPending) {
        optAuthPending = false;
        void askPermissionNow();
        return;
      }
      if (optActive) {
        optActive = false;
        void engine.stop(false);
      }
    };
    window.addEventListener('keyup', e => { if (e.code === 'AltRight') releaseOpt(); });
    window.addEventListener('blur', releaseOpt);

    syncUi();

    return {
      sync: syncUi,
      stop: (force) => engine.stop(!!force),
      cancel: () => {
        interruptHold();
        engine.cancel();
      },
      isActive: () => engine.getPhase() !== 'idle',
    };
  }

  window.HYVoice = { init };
})();
