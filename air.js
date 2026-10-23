const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const { hex, sameSecret, bucket, take, cleanText, isObj, cleanDescription, cleanCandidate } = require('./guard');

const MAX_MESSAGE = 64 * 1024;
const MAX_FRAME = 256 * 1024;
const MAX_SOCKETS = 3000;
const PER_LISTENER_RATE = 10;
const STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };
const ID = /^[a-z0-9]{6}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const CF_TTL = 86400;
const CF_REUSE_MS = 6 * 3600 * 1000;
const CF_RETRY_MS = 60 * 1000;
const CF_TIMEOUT_MS = 4000;
// port 53 is on the browsers' bad-ports list: a candidate there only costs a timeout
const BAD_PORT = /:53(\?|$)/;

function createAir({ server, registry, originAllowed, log, env = process.env, limits = {} }) {
  const maxListeners = limits.maxListeners || 50;
  const maxRate = limits.maxRate || 60;
  const graceMs = Number(env.AIR_GRACE_MS) || 20000;
  const heartbeatMs = Number(env.AIR_HEARTBEAT_MS) || 20000;

  const rooms = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });

  const send = (ws, msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch {}
    }
  };
  const fail = (ws, code) => send(ws, { t: 'error', code });

  function sendCount(room) {
    const msg = { t: 'count', listeners: room.listeners.size };
    send(room.ws, msg);
    for (const l of room.listeners.values()) send(l, msg);
  }

  function release(ws) {
    ws.air.role = null;
    ws.air.room = null;
    ws.air.lid = null;
  }

  function closeRoom(room, why) {
    if (rooms.get(room.id) !== room) return;
    clearTimeout(room.grace);
    rooms.delete(room.id);
    registry.release(room.id);
    for (const l of room.listeners.values()) {
      send(l, { t: 'ended' });
      release(l);
    }
    if (room.ws) {
      send(room.ws, { t: 'ended' });
      release(room.ws);
    }
    log(`air · ended (${why}) · rooms ${rooms.size}`);
  }

  function pause(room) {
    room.ws = null;
    room.grace = setTimeout(() => closeRoom(room, 'grace'), graceMs);
    for (const l of room.listeners.values()) send(l, { t: 'paused' });
    log(`air · paused · listeners ${room.listeners.size}`);
  }

  function attach(room, ws) {
    room.ws = ws;
    ws.air.role = 'b';
    ws.air.room = room;
  }

  const handlers = {
    'go-live'(ws, m) {
      if (ws.air.role) return fail(ws, 'busy');
      const name = cleanText(m.name, 40);
      const from = cleanText(m.from, 16);
      if (name === null || from === null) return fail(ws, 'bad-message');
      const id = registry.reserve();
      if (!id) return fail(ws, 'full');
      const room = {
        id, token: hex(16), name, from, since: Date.now(),
        ws: null, listeners: new Map(), known: new Set(), grace: null,
      };
      rooms.set(id, room);
      attach(room, ws);
      send(ws, { t: 'live', id, token: room.token });
      log(`air · live · rooms ${rooms.size}`);
    },

    resume(ws, m) {
      if (ws.air.role) return fail(ws, 'busy');
      const room = typeof m.id === 'string' && ID.test(m.id) ? rooms.get(m.id) : undefined;
      if (!room || typeof m.token !== 'string' || !TOKEN.test(m.token) || !sameSecret(room.token, m.token)) {
        return send(ws, { t: 'not-found' });
      }
      const wasPaused = !room.ws;
      // the old socket can still look alive for up to two heartbeats after a network change
      if (room.ws) {
        const old = room.ws;
        release(old);
        fail(old, 'replaced');
        old.close(4000, 'replaced');
      }
      clearTimeout(room.grace);
      room.grace = null;
      attach(room, ws);
      send(ws, { t: 'live', id: room.id, token: room.token });
      for (const lid of room.known) if (!room.listeners.has(lid)) send(ws, { t: 'listener-left', lid });
      for (const lid of room.listeners.keys()) if (!room.known.has(lid)) send(ws, { t: 'listener', lid });
      room.known = new Set(room.listeners.keys());
      sendCount(room);
      if (wasPaused) for (const l of room.listeners.values()) send(l, { t: 'resumed' });
      log(`air · resumed · listeners ${room.listeners.size}`);
    },

    end(ws) {
      if (ws.air.role !== 'b') return fail(ws, 'not-live');
      closeRoom(ws.air.room, 'end');
    },

    listen(ws, m) {
      if (ws.air.role) return fail(ws, 'busy');
      const room = typeof m.id === 'string' && ID.test(m.id) ? rooms.get(m.id) : undefined;
      if (!room) return send(ws, { t: 'not-found' });
      if (room.listeners.size >= maxListeners) return fail(ws, 'room-full');
      let lid;
      do lid = hex(6); while (room.listeners.has(lid) || room.known.has(lid));
      room.listeners.set(lid, ws);
      ws.air.role = 'l';
      ws.air.room = room;
      ws.air.lid = lid;
      send(ws, { t: 'joined', id: room.id, name: room.name, from: room.from, since: room.since, listeners: room.listeners.size });
      if (room.ws) {
        room.known.add(lid);
        send(room.ws, { t: 'listener', lid });
      } else {
        send(ws, { t: 'paused' });
      }
      sendCount(room);
      log(`air · listener in · listeners ${room.listeners.size}`);
    },

    signal(ws, m) {
      const room = ws.air.room;
      if (!room || typeof m.to !== 'string') return;
      const data = cleanSignal(m.data);
      if (!data) return;
      if (ws.air.role === 'b') {
        const target = room.listeners.get(m.to);
        if (target) send(target, { t: 'signal', from: room.id, data });
      } else if (ws.air.role === 'l') {
        if (m.to === room.id && room.ws) send(room.ws, { t: 'signal', from: ws.air.lid, data });
      }
    },

    ping(ws) {
      send(ws, { t: 'pong' });
    },
  };

  function cleanSignal(d) {
    if (!isObj(d)) return null;
    if (d.type === 'offer' || d.type === 'answer') {
      const desc = cleanDescription(d, d.type, MAX_MESSAGE);
      return desc && { type: d.type, sdp: desc.sdp };
    }
    if (d.type === 'ice') {
      if (d.candidate === null || d.candidate === undefined) return { type: 'ice', candidate: null };
      const candidate = cleanCandidate(d.candidate);
      return candidate && { type: 'ice', candidate };
    }
    return null;
  }

  function onClose(ws) {
    const { role, room, lid } = ws.air;
    release(ws);
    if (!room || rooms.get(room.id) !== room) return;
    if (role === 'b' && room.ws === ws) {
      pause(room);
    } else if (role === 'l' && room.listeners.get(lid) === ws) {
      room.listeners.delete(lid);
      if (room.ws && room.known.has(lid)) {
        room.known.delete(lid);
        send(room.ws, { t: 'listener-left', lid });
      }
      sendCount(room);
      log(`air · listener out · listeners ${room.listeners.size}`);
    }
  }

  function onMessage(ws, raw, isBinary) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const room = ws.air.role === 'b' ? ws.air.room : null;
    // a 1→N broadcaster sends an offer and its candidates per listener, so its budget grows with the room
    const rate = maxRate + (room ? PER_LISTENER_RATE * room.listeners.size : 0);
    if (!take(ws.air.bucket, rate)) {
      log('air · flood · closed');
      ws.close(1008, 'rate');
      return;
    }
    if (isBinary) return fail(ws, 'bad-message');
    if (raw.length > MAX_MESSAGE) return fail(ws, 'too-big');
    let m;
    try {
      m = JSON.parse(raw.toString('utf8'));
    } catch {
      return fail(ws, 'bad-message');
    }
    if (!isObj(m) || typeof m.t !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, m.t)) {
      return fail(ws, 'bad-message');
    }
    handlers[m.t](ws, m);
  }

  wss.on('connection', ws => {
    ws.air = { alive: true, role: null, room: null, lid: null, bucket: bucket() };
    ws.on('pong', () => { ws.air.alive = true; });
    ws.on('error', () => {});
    ws.on('message', (raw, isBinary) => {
      try {
        onMessage(ws, raw, isBinary);
      } catch (e) {
        log(`air · handler error ${e && e.name}`);
        fail(ws, 'internal');
      }
    });
    ws.on('close', () => {
      try {
        onClose(ws);
      } catch (e) {
        log(`air · close error ${e && e.name}`);
      }
    });
  });
  wss.on('error', () => {});

  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.air || !ws.air.alive) {
        ws.terminate();
        continue;
      }
      ws.air.alive = false;
      try { ws.ping(); } catch {}
    }
  }, heartbeatMs);
  beat.unref();

  function reject(socket, status) {
    try {
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {}
    socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let path = '';
    try { path = new URL(req.url, 'http://x').pathname; } catch {}
    if (path !== '/air' && path !== '/air/') return reject(socket, '404 Not Found');
    const ok = originAllowed(req.headers.origin);
    const full = wss.clients.size >= MAX_SOCKETS;
    wss.handleUpgrade(req, socket, head, ws => {
      if (!ok || full) {
        ws.on('error', () => {});
        log(ok ? 'air · full · refused' : 'air · origin refused');
        ws.close(ok ? 1013 : 1008, ok ? 'full' : 'origin');
        return;
      }
      wss.emit('connection', ws, req);
    });
  });

  function now() {
    const list = [];
    for (const r of rooms.values()) {
      if (r.ws) list.push({ id: r.id, name: r.name, from: r.from, listeners: r.listeners.size, since: r.since });
    }
    return { rooms: list };
  }

  // Cloudflare mints credentials good for a day; one call is reused for hours so listeners don't each wait on the API
  let cf = null;
  let cfPending = null;
  let cfFailedAt = 0;

  function cleanIce(list) {
    const out = [];
    for (const s of Array.isArray(list) ? list : [list]) {
      if (!isObj(s)) continue;
      const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => typeof u === 'string' && !BAD_PORT.test(u));
      if (!urls.length) continue;
      const server = { urls };
      if (typeof s.username === 'string' && typeof s.credential === 'string') {
        server.username = s.username;
        server.credential = s.credential;
      }
      out.push(server);
    }
    return out;
  }

  function cloudflare() {
    if (!env.CF_TURN_KEY_ID || !env.CF_TURN_API_TOKEN) return null;
    const t = Date.now();
    if (cf && t - cf.at < CF_REUSE_MS) return cf.servers;
    const usable = cf && t - cf.at < CF_TTL * 1000 - 3600 * 1000 ? cf.servers : null;
    if (t - cfFailedAt < CF_RETRY_MS) return usable;
    if (!cfPending) {
      const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`;
      cfPending = fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: CF_TTL }),
        signal: AbortSignal.timeout(CF_TIMEOUT_MS)
      })
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
        .then(body => {
          const servers = cleanIce(body && body.iceServers);
          if (!servers.some(s => s.username)) throw new Error('no turn');
          cf = { at: Date.now(), servers };
          return servers;
        })
        .catch(e => {
          cfFailedAt = Date.now();
          log(`ice · cloudflare failed · ${e && e.message}`);
          return usable;
        })
        .finally(() => { cfPending = null; });
    }
    return cfPending;
  }

  async function ice() {
    const fromCloudflare = await cloudflare();
    if (fromCloudflare) return { iceServers: fromCloudflare };
    const servers = [STUN];
    const urls = (env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (urls.length && env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 3600}:${hex(8)}`;
      const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
      servers.push({ urls, username, credential });
    }
    return { iceServers: servers };
  }

  return { now, ice, wss, get rooms() { return rooms.size; } };
}

module.exports = { createAir };
