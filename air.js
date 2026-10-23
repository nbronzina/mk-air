const { WebSocketServer, WebSocket } = require('ws');
const { hex, sameSecret, bucket, take, cleanText, isObj, cleanDescription, cleanCandidate } = require('./guard');

const MAX_MESSAGE = 64 * 1024;
const MAX_FRAME = 256 * 1024;
const MAX_SOCKETS = 3000;
const PER_LISTENER_RATE = 10;
const STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };
const ID = /^[a-z0-9]{6}$/;
const TOKEN = /^[0-9a-f]{32}$/;
// the relay: when a listener's network won't take a direct line, the broadcaster's Opus packets come through this
// server. Render's free tier allows 5 GB out a month and suspends the service past it, so the relay has a budget
const RELAY_CHUNK = 4096;
const RELAY_BYTES_PER_S = 16 * 1024;
const RELAY_BACKLOG = 64 * 1024;

function createAir({ server, registry, originAllowed, log, env = process.env, limits = {} }) {
  const maxListeners = limits.maxListeners || 50;
  const maxRate = limits.maxRate || 60;
  const graceMs = Number(env.AIR_GRACE_MS) || 20000;
  const heartbeatMs = Number(env.AIR_HEARTBEAT_MS) || 20000;
  const relayMax = env.RELAY_MAX !== undefined ? Math.max(0, Number(env.RELAY_MAX) || 0) : 5;
  const relayBudget = (env.RELAY_GB !== undefined ? Math.max(0, Number(env.RELAY_GB) || 0) : 4) * 1e9;
  // past the budget nobody new gets in; past a tenth more, the ones still relayed are cut too
  const relayHardStop = relayBudget * 1.1;
  let relayed = 0;
  let relayMonth = '';
  let relayBytes = 0;

  const month = () => new Date().toISOString().slice(0, 7);
  function relaySpent() {
    if (relayMonth !== month()) {
      relayMonth = month();
      relayBytes = 0;
    }
    return relayBytes;
  }
  const mb = () => Math.round(relayBytes / 1e6);

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
    relayed -= room.relays.size;
    room.relays.clear();
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
        canRelay: m.relay === true, relays: new Set(), relayConfig: null,
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
      if (typeof m.relay === 'boolean') room.canRelay = m.relay;
      send(ws, { t: 'live', id: room.id, token: room.token });
      const direct = [...room.listeners.keys()].filter(lid => !room.relays.has(lid));
      for (const lid of room.known) if (!direct.includes(lid)) send(ws, { t: 'listener-left', lid });
      for (const lid of direct) if (!room.known.has(lid)) send(ws, { t: 'listener', lid });
      room.known = new Set(direct);
      // a recorder left running from before the drop stops if nobody needs the relay anymore
      send(ws, { t: 'relay', on: room.relays.size > 0 });
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

    relay(ws) {
      if (ws.air.role !== 'l') return fail(ws, 'not-listening');
      const room = ws.air.room;
      const lid = ws.air.lid;
      if (room.relays.has(lid)) return send(ws, { t: 'relay', ok: true });
      const reason = !room.canRelay ? 'unsupported'
        : !relayMax || !relayBudget ? 'off'
        : relayed >= relayMax ? 'full'
        : relaySpent() >= relayBudget ? 'spent'
        : null;
      if (reason) {
        log(`air · relay refused (${reason})`);
        return send(ws, { t: 'relay', ok: false, reason });
      }
      room.relays.add(lid);
      relayed++;
      // the broadcaster stops trying a direct line nobody will answer
      if (room.known.delete(lid) && room.ws) send(room.ws, { t: 'listener-left', lid });
      send(ws, { t: 'relay', ok: true });
      if (room.relayConfig) send(ws, room.relayConfig);
      if (room.relays.size === 1 && room.ws) send(room.ws, { t: 'relay', on: true });
      log(`air · relay in · relayed ${relayed} · ${mb()} MB this month`);
    },

    'relay-config'(ws, m) {
      if (ws.air.role !== 'b') return fail(ws, 'not-live');
      if (!Number.isInteger(m.rate) || m.rate < 8000 || m.rate > 48000 || (m.channels !== 1 && m.channels !== 2)) {
        return fail(ws, 'bad-message');
      }
      const room = ws.air.room;
      room.relayConfig = { t: 'relay-config', rate: m.rate, channels: m.channels };
      for (const lid of room.relays) send(room.listeners.get(lid), room.relayConfig);
    },

    ping(ws) {
      send(ws, { t: 'pong' });
    },
  };

  function dropRelay(room, lid) {
    if (!room.relays.delete(lid)) return;
    relayed--;
    if (!room.relays.size && room.ws) send(room.ws, { t: 'relay', on: false });
    log(`air · relay out · relayed ${relayed} · ${mb()} MB this month`);
  }

  function cutRelays() {
    log(`air · relay spent · ${mb()} MB this month`);
    for (const room of rooms.values()) {
      for (const lid of [...room.relays]) {
        send(room.listeners.get(lid), { t: 'relay', ok: false, reason: 'spent' });
        dropRelay(room, lid);
      }
    }
  }

  function onAudio(ws, raw) {
    const room = ws.air.role === 'b' ? ws.air.room : null;
    // a packet in flight when the relay stopped is not an error
    if (!room || !room.relays.size) return;
    if (raw.length > RELAY_CHUNK) return fail(ws, 'too-big');
    const t = Date.now();
    const a = ws.air.audio;
    if (t - a.since >= 1000) {
      a.since = t;
      a.bytes = 0;
    }
    if (a.bytes + raw.length > RELAY_BYTES_PER_S) return;
    a.bytes += raw.length;
    let sent = 0;
    for (const lid of room.relays) {
      const l = room.listeners.get(lid);
      // a listener who can't keep up loses packets rather than piling them up here
      if (!l || l.readyState !== WebSocket.OPEN || l.bufferedAmount > RELAY_BACKLOG) continue;
      try {
        l.send(raw, { binary: true });
        sent += raw.length;
      } catch {}
    }
    relaySpent();
    relayBytes += sent;
    if (relayBytes >= relayHardStop) cutRelays();
  }

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
      dropRelay(room, lid);
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
    if (isBinary) {
      if (ws.air.role !== 'b') return fail(ws, 'bad-message');
      return onAudio(ws, raw);
    }
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
    ws.air = { alive: true, role: null, room: null, lid: null, bucket: bucket(), audio: { since: 0, bytes: 0 } };
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

  function ice() {
    return { iceServers: [STUN] };
  }

  return { now, ice, wss, get rooms() { return rooms.size; } };
}

module.exports = { createAir };
