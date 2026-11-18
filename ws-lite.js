'use strict';
/* 轻量零依赖 RFC 6455 WebSocket 实现（服务端升级 + 客户端 TLS 外连）。
 * 供《这一百年》语音实时转写 /api/asr 与 DashScope fun-asr-realtime 双工流使用。
 *
 * 覆盖：
 *   - 文本帧 (0x1)、二进制帧 (0x2)、分片续帧 (0x0)
 *   - 控制帧：Close (0x8)、Ping (0x9 自动回 Pong)、Pong (0xA)
 *   - 客户端发帧强制加随机 4 字节掩码；服务端收帧解掩码、发帧不加掩码
 *   - 单消息长度上限保护（maxPayload）
 */
const crypto = require('crypto');
const EventEmitter = require('events');
const net = require('net');
const tls = require('tls');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

function acceptHash(key) {
  return crypto.createHash('sha1').update(String(key || '') + WS_GUID).digest('base64');
}

function buildFrame(opcode, payload, mask) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const len = data.length;
  let headLen = 2;
  if (len >= 126 && len <= 65535) headLen = 4;
  else if (len > 65535) headLen = 10;
  const maskLen = mask ? 4 : 0;
  const out = Buffer.allocUnsafe(headLen + maskLen + len);
  out[0] = 0x80 | (opcode & 0x0f);
  const mBit = mask ? 0x80 : 0;
  if (len < 126) {
    out[1] = mBit | len;
  } else if (len <= 65535) {
    out[1] = mBit | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = mBit | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  if (mask) {
    const key = crypto.randomBytes(4);
    key.copy(out, headLen);
    const bodyOff = headLen + 4;
    for (let i = 0; i < len; i++) out[bodyOff + i] = data[i] ^ key[i & 3];
  } else {
    data.copy(out, headLen);
  }
  return out;
}

class WsConn extends EventEmitter {
  constructor(socket, { isClient, maxPayload = 512 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.isClient = !!isClient;
    this.maxPayload = maxPayload;
    this.readyState = OPEN;
    this._buf = Buffer.alloc(0);
    this._fragOpcode = 0;
    this._fragParts = [];
    this._fragBytes = 0;
    this._closedEmitted = false;
    this._closeSent = false;
    this._closeCode = 1006;
    this._closeReason = '';

    socket.on('data', chunk => this._onData(chunk));
    socket.on('end', () => this._finishClose(this._closeCode, this._closeReason));
    socket.on('close', () => this._finishClose(this._closeCode, this._closeReason));
    socket.on('error', err => {
      if (this.listenerCount('error') > 0) this.emit('error', err);
      this._finishClose(1006, err && err.message ? err.message : '');
    });
  }

  _feed(buf) {
    if (buf && buf.length) this._onData(buf);
  }

  _writeFrame(opcode, payload) {
    if (this.readyState === CLOSED || this.socket.destroyed) return;
    try {
      this.socket.write(buildFrame(opcode, payload, this.isClient));
    } catch {
      /* 对端已断 */
    }
  }

  send(data) {
    if (this.readyState !== OPEN) return;
    if (typeof data === 'string') {
      this._writeFrame(0x1, Buffer.from(data, 'utf8'));
    } else if (Buffer.isBuffer(data)) {
      this._writeFrame(0x2, data);
    } else if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      this._writeFrame(0x2, Buffer.from(data));
    } else {
      this._writeFrame(0x1, Buffer.from(String(data), 'utf8'));
    }
  }

  ping(payload) {
    if (this.readyState !== OPEN) return;
    this._writeFrame(0x9, payload ? Buffer.from(payload) : Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSING;
    if (!this._closeSent) {
      this._closeSent = true;
      const rBuf = Buffer.from(String(reason || '').slice(0, 120), 'utf8');
      const body = Buffer.allocUnsafe(2 + rBuf.length);
      body.writeUInt16BE(code, 0);
      rBuf.copy(body, 2);
      this._writeFrame(0x8, body);
    }
    this._closeCode = code;
    this._closeReason = String(reason || '');
    try { this.socket.end(); } catch {}
    setTimeout(() => {
      if (!this.socket.destroyed) {
        try { this.socket.destroy(); } catch {}
      }
      this._finishClose(this._closeCode, this._closeReason);
    }, 800).unref();
  }

  terminate() {
    this.readyState = CLOSED;
    try { this.socket.destroy(); } catch {}
    this._finishClose(1006, '');
  }

  _finishClose(code, reason) {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this.readyState = CLOSED;
    this._buf = Buffer.alloc(0);
    this._fragParts = [];
    this.emit('close', code, reason);
  }

  _onData(chunk) {
    if (this.readyState === CLOSED) return;
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;

    while (this._buf.length >= 2) {
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;

      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        const big = this._buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) {
          this.close(1009, 'payload too large');
          return;
        }
        len = Number(big);
        off = 10;
      }

      if (len > this.maxPayload) {
        this.close(1009, 'payload too large');
        return;
      }

      const need = off + (masked ? 4 : 0) + len;
      if (this._buf.length < need) return;

      let payload;
      if (masked) {
        const key = this._buf.subarray(off, off + 4);
        const raw = this._buf.subarray(off + 4, need);
        payload = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) payload[i] = raw[i] ^ key[i & 3];
      } else {
        payload = Buffer.from(this._buf.subarray(off, need));
      }
      this._buf = this._buf.subarray(need);

      if (opcode === 0x8) {
        let code = 1005;
        let reason = '';
        if (payload.length >= 2) {
          code = payload.readUInt16BE(0);
          reason = payload.subarray(2).toString('utf8');
        }
        this._closeCode = code;
        this._closeReason = reason;
        if (!this._closeSent) {
          this._closeSent = true;
          this._writeFrame(0x8, payload.subarray(0, Math.min(payload.length, 125)));
        }
        try { this.socket.end(); } catch {}
        this._finishClose(code, reason);
        return;
      }

      if (opcode === 0x9) {
        this._writeFrame(0xA, payload);
        continue;
      }

      if (opcode === 0xA) {
        this.emit('pong', payload);
        continue;
      }

      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          this.emit('message', payload, opcode === 0x2);
        } else {
          this._fragOpcode = opcode;
          this._fragParts = [payload];
          this._fragBytes = payload.length;
        }
        continue;
      }

      if (opcode === 0x0 && this._fragOpcode) {
        this._fragBytes += payload.length;
        if (this._fragBytes > this.maxPayload) {
          this.close(1009, 'payload too large');
          return;
        }
        this._fragParts.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragParts, this._fragBytes);
          const isBin = this._fragOpcode === 0x2;
          this._fragOpcode = 0;
          this._fragParts = [];
          this._fragBytes = 0;
          this.emit('message', full, isBin);
        }
        continue;
      }

      this.close(1002, 'protocol error');
      return;
    }
  }
}

/** 服务端接受浏览器的 WebSocket 升级请求。 */
function acceptWebSocket(req, socket, head, opts = {}) {
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const key = req.headers['sec-websocket-key'];
  if (upgrade !== 'websocket' || !key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return null;
  }

  let selectedProto = null;
  if (opts.selectProtocol && req.headers['sec-websocket-protocol']) {
    const list = String(req.headers['sec-websocket-protocol'])
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    selectedProto = opts.selectProtocol(list) || null;
  }

  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptHash(key)}`,
  ];
  if (selectedProto) lines.push(`Sec-WebSocket-Protocol: ${selectedProto}`);
  lines.push('', '');
  socket.write(lines.join('\r\n'));
  try { socket.setNoDelay(true); } catch {}

  const ws = new WsConn(socket, { isClient: false, maxPayload: opts.maxPayload || 256 * 1024 });
  if (head && head.length) setImmediate(() => ws._feed(head));
  return ws;
}

/** 客户端发起 WebSocket 连接（支持 wss:// + 自定义 Authorization 头）。 */
function connectWebSocket(urlStr, opts = {}) {
  const u = new URL(urlStr);
  const isTls = u.protocol === 'wss:';
  const port = Number(u.port || (isTls ? 443 : 80));
  const pathWithQuery = (u.pathname || '/') + (u.search || '');
  const key = crypto.randomBytes(16).toString('base64');
  const expectedAccept = acceptHash(key);

  const emitter = new EventEmitter();
  emitter.readyState = CONNECTING;
  let inner = null;
  let closed = false;
  let headerBuf = Buffer.alloc(0);

  const socket = isTls
    ? tls.connect({ host: u.hostname, port, servername: u.hostname })
    : net.connect({ host: u.hostname, port });

  try { socket.setNoDelay(true); } catch {}

  const fail = err => {
    if (closed) return;
    closed = true;
    emitter.readyState = CLOSED;
    try { socket.destroy(); } catch {}
    if (emitter.listenerCount('error') > 0) emitter.emit('error', err);
    emitter.emit('close', 1006, err && err.message ? err.message : '');
  };

  socket.once('error', fail);
  socket.once('close', () => {
    if (!inner && !closed) {
      closed = true;
      emitter.readyState = CLOSED;
      emitter.emit('close', 1006, 'closed before upgrade');
    }
  });

  const onConnect = () => {
    const hdrs = {
      Host: u.host,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...(opts.headers || {}),
    };
    const reqStr = `GET ${pathWithQuery} HTTP/1.1\r\n` +
      Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n';
    socket.write(reqStr);
  };

  const onHandshakeData = chunk => {
    headerBuf = headerBuf.length ? Buffer.concat([headerBuf, chunk]) : chunk;
    const sep = headerBuf.indexOf('\r\n\r\n');
    if (sep < 0) {
      if (headerBuf.length > 16384) fail(new Error('WebSocket handshake header too large'));
      return;
    }
    socket.removeListener('data', onHandshakeData);
    socket.removeListener('error', fail);

    const headText = headerBuf.subarray(0, sep).toString('utf8');
    const rest = headerBuf.subarray(sep + 4);
    headerBuf = Buffer.alloc(0);

    const [statusLine, ...rawHeaders] = headText.split('\r\n');
    if (!/^HTTP\/1\.[01]\s+101\b/.test(statusLine || '')) {
      fail(new Error(`WebSocket upgrade failed: ${statusLine || 'empty'}`));
      return;
    }
    const headers = {};
    for (const line of rawHeaders) {
      const idx = line.indexOf(':');
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    if (headers['sec-websocket-accept'] !== expectedAccept) {
      fail(new Error('WebSocket accept hash mismatch'));
      return;
    }

    inner = new WsConn(socket, { isClient: true, maxPayload: opts.maxPayload || 4 * 1024 * 1024 });
    emitter.readyState = OPEN;
    inner.on('message', (data, isBin) => emitter.emit('message', data, isBin));
    inner.on('close', (code, reason) => {
      closed = true;
      emitter.readyState = CLOSED;
      emitter.emit('close', code, reason);
    });
    inner.on('error', err => {
      if (emitter.listenerCount('error') > 0) emitter.emit('error', err);
    });
    emitter.emit('open');
    if (rest.length) inner._feed(rest);
  };

  socket.on('data', onHandshakeData);
  socket.once(isTls ? 'secureConnect' : 'connect', onConnect);

  emitter.send = data => { if (inner) inner.send(data); };
  emitter.ping = payload => { if (inner) inner.ping(payload); };
  emitter.close = (code, reason) => {
    if (inner) {
      emitter.readyState = CLOSING;
      inner.close(code, reason);
    } else {
      closed = true;
      emitter.readyState = CLOSED;
      try { socket.destroy(); } catch {}
      emitter.emit('close', code || 1000, reason || '');
    }
  };
  emitter.terminate = () => {
    if (inner) inner.terminate();
    else {
      closed = true;
      emitter.readyState = CLOSED;
      try { socket.destroy(); } catch {}
    }
  };

  return emitter;
}

module.exports = {
  CONNECTING,
  OPEN,
  CLOSING,
  CLOSED,
  acceptWebSocket,
  connectWebSocket,
};
