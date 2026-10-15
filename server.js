'use strict';
/*
 * WaferRun 課堂版伺服器（零依賴：只需要 Node.js 18 以上）
 *   node server.js
 * 老師開 /host，學生開 / 並輸入房號。
 *
 * 環境變數
 *   PORT       埠號，預設 3000
 *   HOST_PASS  設了之後，開房要輸入這個密碼（放到雲端時請務必設定）
 *              沒設的話，只有「跑伺服器的那台電腦」可以開房
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const HOST_PASS = process.env.HOST_PASS || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, ''); // 用隧道/雲端時，學生實際連的網址
const PUB = path.join(__dirname, 'public');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PLAYERS = 80;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';

/* ---------- 計分：全部集中在這裡，想改公式只改這個函式 ---------- */
// y：整體良率 0–100；h：遊戲內花費的分鐘；drops：摔晶圓次數；scold：被課長罵的次數
function calcScore(m) {
  const s = m.y * 10 + Math.max(0, 360 - m.h) * 1.5 - m.drops * 80 - m.scold * 20;
  return Math.max(0, Math.round(s));
}
const SCORE_TEXT = '分數 ＝ 良率×10 ＋ 節省的遊戲時間（每少 1 分鐘加 1.5，以 360 分鐘為基準）－ 摔晶圓每次 80 － 被課長罵每次 20';

/* ---------- 迷你 WebSocket（RFC 6455，只做文字訊息） ---------- */
class WS {
  constructor(socket) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.frag = null; this.open = true;
    this.onmessage = null; this.onclose = null; this.last = Date.now(); this.data = {};
    socket.on('data', d => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }
  _closed() { if (!this.open) return; this.open = false; try { this.socket.destroy(); } catch (e) {} if (this.onclose) this.onclose(); }
  _data(d) {
    this.last = Date.now();
    this.buf = Buffer.concat([this.buf, d]);
    if (this.buf.length > 1 << 20) return this.close(1009);
    for (;;) {
      const b = this.buf; if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6); if (hi) return this.close(1009); len = lo; off = 10; }
      if (!masked) return this.close(1002);
      if (len > 65536) return this.close(1009);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4), payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      if (op === 8) { this.close(1000); return; }
      if (op === 9) { this._frame(0xA, payload); continue; }
      if (op === 10) continue;
      if (op === 1 || op === 2 || op === 0) {
        if (op !== 0) this.frag = { op, parts: [] };
        if (!this.frag) return this.close(1002);
        this.frag.parts.push(payload);
        if (fin) { const full = Buffer.concat(this.frag.parts), isText = this.frag.op === 1; this.frag = null; if (isText && this.onmessage) { try { this.onmessage(full.toString('utf8')); } catch (e) { console.error('訊息處理錯誤', e); } } }
      }
    }
  }
  _frame(op, payload) {
    if (!this.open) return;
    const n = payload.length; let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(0, 2); head.writeUInt32BE(n, 6); }
    try { this.socket.write(Buffer.concat([head, payload])); } catch (e) { this._closed(); }
  }
  send(obj) { this._frame(1, Buffer.from(JSON.stringify(obj), 'utf8')); }
  ping() { this._frame(9, Buffer.alloc(0)); }
  close(code) {
    if (!this.open) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code || 1000, 0); this._frame(8, p);
    this.open = false; try { this.socket.end(); } catch (e) {} setTimeout(() => { try { this.socket.destroy(); } catch (e) {} }, 500);
    if (this.onclose) this.onclose();
  }
}

/* ---------- 房間 ---------- */
const rooms = new Map();
const rnd = n => crypto.randomInt(n);
function newCode() { for (let k = 0; k < 200; k++) { let c = ''; for (let i = 0; i < 4; i++) c += CODE_CHARS[rnd(CODE_CHARS.length)]; if (!rooms.has(c)) return c; } return null; }
const token = () => crypto.randomBytes(9).toString('base64url');
const num = (v, lo, hi, d) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
function cleanName(s) {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim();
  const a = Array.from(s); return a.slice(0, 8).join('').trim();
}
function sock(p) { return p.ws && p.ws.open ? p.ws : null; }

function makeRoom(joinSec, playMin) {
  const code = newCode(); if (!code) return null;
  const now = Date.now();
  const r = { code, hostKey: token(), host: null, phase: 'lobby', joinSec, playMin, joinEnd: now + joinSec * 1000, startAt: 0, playEnd: 0, endedAt: 0,
    players: new Map(), timers: {}, dirty: false, ldirty: false, created: now, touched: now, hostGone: 0 };
  rooms.set(code, r); schedule(r); return r;
}
function schedule(r) {
  clearTimeout(r.timers.join);
  if (r.phase === 'lobby') r.timers.join = setTimeout(() => startGame(r), Math.max(0, r.joinEnd - Date.now()) + 20);
}
function startGame(r) {
  if (r.phase !== 'lobby') return;
  clearTimeout(r.timers.join);
  if (!r.players.size) { r.joinEnd = Date.now() + 30000; schedule(r); return pushHost(r); } // 沒人進房就不開場，順延 30 秒
  r.phase = 'playing'; r.startAt = Date.now() + 3500; r.playEnd = r.playMin ? r.startAt + r.playMin * 60000 : 0;
  if (r.playEnd) r.timers.end = setTimeout(() => endGame(r), r.playEnd - Date.now() + 20);
  for (const p of r.players.values()) { const w = sock(p); if (w) w.send({ t: 'start', now: Date.now(), startAt: r.startAt, playEnd: r.playEnd }); }
  pushHost(r);
}
function ranking(r) {
  const all = [...r.players.values()];
  const fin = all.filter(p => p.done).sort((a, b) => b.score - a.score || a.h - b.h || a.name.localeCompare(b.name));
  fin.forEach((p, i) => { p.rank = i + 1; });
  const rest = all.filter(p => !p.done).sort((a, b) => b.step - a.step || a.name.localeCompare(b.name));
  rest.forEach(p => { p.rank = null; });
  return fin.concat(rest);
}
function endGame(r) {
  if (r.phase === 'ended') return;
  clearTimeout(r.timers.join); clearTimeout(r.timers.end);
  r.phase = 'ended'; r.endedAt = Date.now();
  const list = ranking(r), fin = list.filter(p => p.done), total = list.length;
  const top = fin.slice(0, 5).map(p => ({ name: p.name, score: p.score }));
  for (const p of list) sendResult(r, p, top, fin.length, total);
  pushHost(r);
}
function sendResult(r, p, top, nFin, total) {
  const w = sock(p); if (!w) return;
  w.send({ t: 'result', now: Date.now(), done: p.done, rank: p.rank, score: p.score, step: p.step, finished: nFin, total, top });
}
function snapshot(r) {
  const list = r.phase === 'ended' || r.phase === 'playing' ? ranking(r) : [...r.players.values()];
  return { t: 'room', now: Date.now(), code: r.code, phase: r.phase, joinSec: r.joinSec, playMin: r.playMin, joinEnd: r.joinEnd, startAt: r.startAt, playEnd: r.playEnd,
    scoreText: SCORE_TEXT,
    players: list.map(p => ({ name: p.name, step: p.step, avg: p.avg, done: p.done, score: p.score, rank: p.rank || null, y: p.y, h: p.h, drops: p.drops, scold: p.scold, sus: !!p.sus, on: !!sock(p) })) };
}
function pushHost(r) { r.dirty = false; if (r.host && r.host.open) r.host.send(snapshot(r)); }
function pushLobby(r) {
  r.ldirty = false;
  const n = r.players.size, m = { t: 'lobby', now: Date.now(), count: n, joinEnd: r.joinEnd };
  for (const p of r.players.values()) { const w = sock(p); if (w) w.send(m); }
}
function touch(r) {
  r.touched = Date.now();
  if (!r.dirty) { r.dirty = true; setTimeout(() => { if (r.dirty) pushHost(r); }, 150); }
  if (r.phase === 'lobby' && !r.ldirty) { r.ldirty = true; setTimeout(() => { if (r.ldirty && r.phase === 'lobby') pushLobby(r); }, 300); }
}

/* ---------- 訊息處理 ---------- */
const localAddrs = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function refreshLocal() { for (const l of Object.values(os.networkInterfaces())) for (const a of l || []) { localAddrs.add(a.address); if (a.family === 'IPv4') localAddrs.add('::ffff:' + a.address); } }
refreshLocal();
function hostAllowed(ws, pass) {
  if (HOST_PASS) return pass === HOST_PASS ? '' : '密碼不對';
  return localAddrs.has(ws.data.ip) && !ws.data.proxied ? '' : '請在跑伺服器的那台電腦上開啟主持頁（用 localhost 網址）';
}
function bindHost(ws, r) { if (r.host && r.host !== ws) { try { r.host.close(1000); } catch (e) {} } r.host = ws; ws.data = Object.assign(ws.data, { role: 'host', room: r }); r.hostGone = 0; }

function onMessage(ws, text) {
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  const d = ws.data;

  /* ----- 老師 ----- */
  if (m.t === 'host_create') {
    const bad = hostAllowed(ws, m.pass); if (bad) return ws.send({ t: 'err', msg: bad });
    if (rooms.size > 200) return ws.send({ t: 'err', msg: '伺服器房間太多，請稍後再試' });
    const r = makeRoom(num(m.joinSec, 15, 900, 90) | 0, num(m.playMin, 0, 90, 15) | 0);
    if (!r) return ws.send({ t: 'err', msg: '無法建立房間' });
    bindHost(ws, r); return ws.send({ t: 'created', code: r.code, key: r.hostKey }), pushHost(r);
  }
  if (m.t === 'host_resume') {
    const r = rooms.get(String(m.code || '').toUpperCase());
    if (!r || r.hostKey !== m.key) return ws.send({ t: 'err', msg: '找不到這個房間（可能已過期）', code: 'gone' });
    bindHost(ws, r); return ws.send({ t: 'created', code: r.code, key: r.hostKey }), pushHost(r);
  }
  if (d.role === 'host' && d.room) {
    const r = d.room; r.touched = Date.now();
    if (m.t === 'host_start') { if (r.phase !== 'lobby') return; if (!r.players.size) return ws.send({ t: 'err', msg: '還沒有學生進房，不能開始' }); return startGame(r); }
    if (m.t === 'host_extend') { if (r.phase !== 'lobby') return; r.joinEnd = Math.max(r.joinEnd, Date.now()) + 30000; schedule(r); return pushHost(r), pushLobby(r); }
    if (m.t === 'host_end') { if (r.phase === 'playing') return endGame(r); return; }
    if (m.t === 'host_kick') {
      const key = String(m.name || '').toLowerCase();
      for (const [k, p] of r.players) if (p.name.toLowerCase() === key) { const w = sock(p); if (w) { w.send({ t: 'kicked' }); setTimeout(() => w.close(1000), 100); } r.players.delete(k); }
      if (r.phase === 'lobby') pushLobby(r);
      if (r.phase === 'playing' && ![...r.players.values()].some(p => !p.done) && r.players.size) { /* 全部完成，交給老師決定何時公布 */ }
      return touch(r);
    }
    return;
  }

  /* ----- 學生 ----- */
  if (m.t === 'join') {
    const r = rooms.get(String(m.code || '').toUpperCase().trim());
    if (!r) return ws.send({ t: 'err', code: 'room', msg: '找不到這個房號，請再確認（4 個字母）' });
    const name = cleanName(m.name); if (!name) return ws.send({ t: 'err', code: 'name', msg: '請先輸入暱稱（最多 8 個字）' });
    const key = name.toLowerCase(); let p = r.players.get(key);
    const tk = typeof m.token === 'string' ? m.token.slice(0, 40) : '';
    if (p) {
      if (!tk || p.token !== tk) return ws.send({ t: 'err', code: 'name', msg: '這個暱稱已經有人用了，換一個吧' });
      const old = sock(p); if (old && old !== ws) { old.data.role = null; old.send({ t: 'kicked', dup: true }); setTimeout(() => old.close(1000), 100); }
    } else {
      if (r.phase !== 'lobby') return ws.send({ t: 'err', code: 'locked', msg: '房間已經鎖定開始了，下一場再來吧' });
      if (r.players.size >= MAX_PLAYERS) return ws.send({ t: 'err', code: 'full', msg: '房間已滿' });
      p = { name, token: tk || token(), ws: null, step: 0, avg: 100, done: false, score: 0, y: 0, h: 0, drops: 0, scold: 0, chatM: 0, rank: null, sus: false };
      r.players.set(key, p);
    }
    p.ws = ws; ws.data = Object.assign(d, { role: 'player', room: r, key });
    ws.send({ t: 'joined', name: p.name, token: p.token, code: r.code, phase: r.phase, now: Date.now(), joinEnd: r.joinEnd, startAt: r.startAt, playEnd: r.playEnd, count: r.players.size, done: p.done });
    if (r.phase === 'ended') { const list = ranking(r), fin = list.filter(x => x.done); sendResult(r, p, fin.slice(0, 5).map(x => ({ name: x.name, score: x.score })), fin.length, list.length); }
    return touch(r);
  }
  if (d.role === 'player' && d.room) {
    const r = d.room, p = r.players.get(d.key); if (!p || p.ws !== ws) return;
    if (m.t === 'prog' && r.phase === 'playing' && !p.done) { p.step = num(m.step, 0, 7, p.step) | 0; p.avg = Math.round(num(m.avg, 0, 100, p.avg)); return touch(r); }
    if (m.t === 'done' && r.phase === 'playing' && !p.done) {
      const q = { y: Math.round(num(m.y, 0, 100, 0)), h: Math.round(num(m.h, 0, 5000, 0)), drops: num(m.drops, 0, 99, 0) | 0, scold: num(m.scold, 0, 99, 0) | 0 };
      p.y = q.y; p.h = q.h; p.drops = q.drops; p.scold = q.scold; p.chatM = num(m.chatM, 0, 999, 0) | 0;
      p.score = calcScore(q); p.done = true; p.step = 7; p.avg = q.y;
      p.sus = Date.now() - r.startAt < 45000; // 45 秒內就跑完七站，幾乎不可能
      ws.send({ t: 'saved', score: p.score });
      touch(r);
      return;
    }
  }
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const FILES = { '/': 'index.html', '/index.html': 'index.html', '/host': 'host.html', '/host.html': 'host.html', '/three.min.js': 'three.min.js', '/qrcode.js': 'qrcode.js' };
function lanUrls() {
  const out = [];
  for (const [name, l] of Object.entries(os.networkInterfaces())) for (const a of l || []) if (a.family === 'IPv4' && !a.internal) out.push({ name, url: 'http://' + a.address + ':' + PORT });
  return out;
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); const p = u.pathname;
  if (p === '/info') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ lan: lanUrls(), needPass: !!HOST_PASS, publicUrl: PUBLIC_URL, localOnly: !HOST_PASS, port: PORT, scoreText: SCORE_TEXT }));
  }
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  const f = FILES[p];
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('找不到頁面'); }
  fs.readFile(path.join(PUB, f), (err, data) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('檔案遺失：' + f); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': f.endsWith('.js') ? 'public, max-age=86400' : 'no-store' });
    res.end(data);
  });
});
const clients = new Set();
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || new URL(req.url, 'http://x').pathname !== '/ws' || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  const acc = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  socket.setNoDelay(true);
  const ws = new WS(socket);
  ws.data = { ip: req.socket.remoteAddress, proxied: !!(req.headers['x-forwarded-for'] || req.headers['forwarded']) };
  clients.add(ws);
  ws.onmessage = t => onMessage(ws, t);
  ws.onclose = () => {
    clients.delete(ws); const d = ws.data;
    if (d.role === 'host' && d.room && d.room.host === ws) { d.room.host = null; d.room.hostGone = Date.now(); }
    if (d.role === 'player' && d.room) { const p = d.room.players.get(d.key); if (p && p.ws === ws) { p.ws = null; touch(d.room); } }
  };
});
setInterval(() => {
  const now = Date.now();
  for (const ws of clients) { if (now - ws.last > 75000) ws.close(1001); else ws.ping(); }
  for (const [c, r] of rooms) {
    const idle = now - r.touched;
    if ((r.phase === 'ended' && now - r.endedAt > 3 * 3600e3) || idle > 8 * 3600e3 || (!r.host && r.hostGone && now - r.hostGone > 30 * 60e3)) {
      clearTimeout(r.timers.join); clearTimeout(r.timers.end);
      for (const p of r.players.values()) { const w = sock(p); if (w) w.close(1001); }
      rooms.delete(c);
    }
  }
}, 20000).unref();

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  WaferRun 課堂版伺服器已啟動（埠 ' + PORT + '）\n');
    console.log('  老師請在這台電腦開：  http://localhost:' + PORT + '/host');
    const l = lanUrls();
    if (l.length) { console.log('  學生請開：'); l.forEach(x => console.log('     ' + x.url + '    （' + x.name + '）')); }
    else console.log('  （沒偵測到區域網路位址，請確認電腦已連上 Wi-Fi）');
    console.log(HOST_PASS ? '\n  已啟用老師密碼。' : '\n  目前只有這台電腦能開房（若要放雲端，請設定環境變數 HOST_PASS）。');
    console.log('  按 Ctrl+C 可以關閉。\n');
  });
}
module.exports = { server, calcScore, rooms, onMessage, WS };
