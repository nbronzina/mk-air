const { Server } = require('socket.io');
const { bucket, take, isObj, cleanDescription, cleanCandidate } = require('./guard');

const MAX_MESSAGE = 64 * 1024;
const PER_LISTENER_RATE = 10;

// the socket.io pages in public/ stay up during the migration, but signaling only flows broadcaster ↔ its own listeners
function createLegacy({ server, registry, originAllowed, log, limits = {} }) {
  const maxListeners = limits.maxListeners || 50;
  const maxRate = limits.maxRate || 60;
  const rooms = new Map();

  const io = new Server(server, {
    cors: { origin: (origin, cb) => cb(null, originAllowed(origin)), methods: ['GET', 'POST'] },
    // same-origin polling GETs carry no Origin header; every cross-origin request does
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      cb(null, origin === undefined || originAllowed(origin, req.headers.host));
    },
    allowEIO3: false,
    maxHttpBufferSize: MAX_MESSAGE,
    destroyUpgrade: false,
  });

  const sendCount = room => {
    const n = room.listeners.size;
    room.broadcaster.emit('listener-count', n);
    for (const l of room.listeners.values()) l.emit('listener-count', n);
  };

  function closeRoom(room) {
    rooms.delete(room.id);
    registry.release(room.id);
    for (const l of room.listeners.values()) {
      l.data.role = null;
      l.data.room = null;
      l.emit('stream-ended');
    }
    log(`legacy · ended · rooms ${rooms.size}`);
  }

  io.on('connection', socket => {
    socket.data.role = null;
    socket.data.room = null;
    const rate = bucket();

    socket.use((packet, next) => {
      const room = socket.data.role === 'b' ? socket.data.room : null;
      if (take(rate, maxRate + (room ? PER_LISTENER_RATE * room.listeners.size : 0))) return next();
      log('legacy · flood · closed');
      socket.disconnect(true);
    });

    const on = (event, fn) => socket.on(event, (...args) => {
      try {
        fn(...args);
      } catch (e) {
        log(`legacy · handler error ${e && e.name}`);
      }
    });

    const own = role => (socket.data.role === role ? socket.data.room : null);

    on('create-room', () => {
      if (socket.data.role) return;
      const id = registry.reserve();
      if (!id) {
        socket.emit('room-error', 'full');
        return;
      }
      const room = { id, broadcaster: socket, listeners: new Map() };
      rooms.set(id, room);
      socket.data.role = 'b';
      socket.data.room = room;
      socket.emit('room-created', id);
      log(`legacy · live · rooms ${rooms.size}`);
    });

    on('join-room', roomId => {
      if (socket.data.role) return;
      const room = typeof roomId === 'string' && roomId.length <= 64 ? rooms.get(roomId) : undefined;
      if (!room || room.listeners.size >= maxListeners) {
        socket.emit('room-not-found');
        return;
      }
      room.listeners.set(socket.id, socket);
      socket.data.role = 'l';
      socket.data.room = room;
      room.broadcaster.emit('listener-joined', socket.id);
      sendCount(room);
      log(`legacy · listener in · listeners ${room.listeners.size}`);
    });

    on('offer', data => {
      const room = own('b');
      if (!room || !isObj(data) || typeof data.target !== 'string') return;
      const target = room.listeners.get(data.target);
      const offer = cleanDescription(data.offer, 'offer', MAX_MESSAGE);
      if (target && offer) target.emit('offer', { offer, broadcaster: socket.id });
    });

    on('answer', data => {
      const room = own('l');
      if (!room || !isObj(data) || data.target !== room.broadcaster.id) return;
      const answer = cleanDescription(data.answer, 'answer', MAX_MESSAGE);
      if (answer) room.broadcaster.emit('answer', { answer, listener: socket.id });
    });

    on('ice-candidate', data => {
      if (!isObj(data) || typeof data.target !== 'string') return;
      const candidate = cleanCandidate(data.candidate);
      if (!candidate) return;
      const asBroadcaster = own('b');
      const asListener = own('l');
      if (asBroadcaster) {
        const target = asBroadcaster.listeners.get(data.target);
        if (target) target.emit('ice-candidate', { candidate, from: socket.id });
      } else if (asListener && data.target === asListener.broadcaster.id) {
        asListener.broadcaster.emit('ice-candidate', { candidate, from: socket.id });
      }
    });

    socket.on('disconnect', () => {
      try {
        const { role, room } = socket.data;
        socket.data.role = null;
        socket.data.room = null;
        if (!room || rooms.get(room.id) !== room) return;
        if (role === 'b') {
          closeRoom(room);
        } else if (role === 'l' && room.listeners.get(socket.id) === socket) {
          room.listeners.delete(socket.id);
          sendCount(room);
          log(`legacy · listener out · listeners ${room.listeners.size}`);
        }
      } catch (e) {
        log(`legacy · disconnect error ${e && e.name}`);
      }
    });
  });

  return { io, get rooms() { return rooms.size; } };
}

module.exports = { createLegacy };
