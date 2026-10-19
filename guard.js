const crypto = require('crypto');

const DEFAULT_ORIGINS = ['https://nbronzina.github.io', 'http://localhost:*', 'http://127.0.0.1:*'];

function parsePattern(raw) {
  const s = raw.trim().replace(/\/+$/, '');
  if (!s) return null;
  const any = s.endsWith(':*');
  try {
    const u = new URL(any ? s.slice(0, -2) : s);
    return { protocol: u.protocol, hostname: u.hostname, port: any ? '*' : u.port };
  } catch {
    return null;
  }
}

function originCheck(env = process.env) {
  const list = env.ALLOWED_ORIGINS ? env.ALLOWED_ORIGINS.split(',') : DEFAULT_ORIGINS.slice();
  if (env.RENDER_EXTERNAL_URL) list.push(env.RENDER_EXTERNAL_URL);
  const patterns = list.map(parsePattern).filter(Boolean);

  return function allowed(origin, host) {
    if (typeof origin !== 'string' || origin.length > 256) return false;
    let u;
    try {
      u = new URL(origin);
    } catch {
      return false;
    }
    // a browser sends the bare origin; anything else (paths, default ports, "null") is not one
    if (u.origin !== origin) return false;
    if (typeof host === 'string' && u.host === host.toLowerCase()) return true;
    return patterns.some(p =>
      p.protocol === u.protocol && p.hostname === u.hostname && (p.port === '*' || p.port === u.port));
  };
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomId() {
  let id = '';
  for (let i = 0; i < 6; i++) id += ID_CHARS[crypto.randomInt(ID_CHARS.length)];
  return id;
}

// one id space and one cap for legacy and v1 rooms: the 50-room limit is the server's, not each transport's
function registry(max) {
  const taken = new Set();
  return {
    get size() { return taken.size; },
    reserve() {
      if (taken.size >= max) return null;
      let id;
      do id = randomId(); while (taken.has(id));
      taken.add(id);
      return id;
    },
    release(id) { taken.delete(id); },
  };
}

const hex = bytes => crypto.randomBytes(bytes).toString('hex');

function sameSecret(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function bucket() {
  return { tokens: null, last: 0 };
}

function take(b, perSecond, now = Date.now()) {
  if (b.tokens === null) b.tokens = perSecond;
  else b.tokens = Math.min(perSecond, b.tokens + (now - b.last) * perSecond / 1000);
  b.last = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const INVISIBLE = /[\p{Cf}\p{Cs}]/gu;

// names end up in other people's pages: no markup, no bidi tricks, no invisible padding
function cleanText(v, max) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return null;
  const s = v.slice(0, max * 4).replace(INVISIBLE, '').replace(BREAKS, ' ').replace(/[<>]/g, '')
    .replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('').trim();
}

const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v);

function cleanDescription(d, type, maxLen) {
  if (!isObj(d) || d.type !== type || typeof d.sdp !== 'string' || !d.sdp || d.sdp.length > maxLen) return null;
  return { type, sdp: d.sdp };
}

function cleanCandidate(c) {
  if (!isObj(c) || typeof c.candidate !== 'string' || c.candidate.length > 2048) return null;
  const out = { candidate: c.candidate };
  if (c.sdpMid !== undefined) {
    if (c.sdpMid !== null && (typeof c.sdpMid !== 'string' || c.sdpMid.length > 64)) return null;
    out.sdpMid = c.sdpMid;
  }
  if (c.sdpMLineIndex !== undefined) {
    if (c.sdpMLineIndex !== null && !(Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 1024)) return null;
    out.sdpMLineIndex = c.sdpMLineIndex;
  }
  if (c.usernameFragment !== undefined) {
    if (c.usernameFragment !== null && (typeof c.usernameFragment !== 'string' || c.usernameFragment.length > 256)) return null;
    out.usernameFragment = c.usernameFragment;
  }
  return out;
}

module.exports = {
  originCheck, registry, hex, sameSecret, bucket, take, cleanText, isObj, cleanDescription, cleanCandidate,
};
