// mk-air server
// handles webrtc signaling for ephemeral live streams

const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true
});
const path = require('path');

// store active rooms
const rooms = new Map();

// serve static files
app.use(express.static('public'));

// routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/broadcast', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'broadcast.html'));
});

app.get('/listen/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'listen.html'));
});

// socket.io connection handling
io.on('connection', (socket) => {
  console.log('user connected:', socket.id);

  // broadcaster creates room
  socket.on('create-room', (roomId) => {
    console.log('room created:', roomId);
    socket.join(roomId);
    rooms.set(roomId, {
      broadcaster: socket.id,
      listeners: new Set()
    });
    socket.emit('room-created', roomId);
  });

  // listener joins room
  socket.on('join-room', (roomId) => {
    const room = rooms.get(roomId);
    
    if (!room) {
      console.log('room not found:', roomId);
      socket.emit('room-not-found');
      return;
    }

    console.log('listener joined room:', roomId, 'socket:', socket.id);
    socket.join(roomId);
    room.listeners.add(socket.id);
    
    // notify broadcaster
    io.to(room.broadcaster).emit('listener-joined', socket.id);
    
    // send current listener count to all
    io.to(roomId).emit('listener-count', room.listeners.size);
  });

  // webrtc signaling
  socket.on('offer', (data) => {
    console.log('offer sent to:', data.target);
    socket.to(data.target).emit('offer', {
      offer: data.offer,
      broadcaster: socket.id
    });
  });

  socket.on('answer', (data) => {
    console.log('answer sent to:', data.target);
    socket.to(data.target).emit('answer', {
      answer: data.answer,
      listener: socket.id
    });
  });

  socket.on('ice-candidate', (data) => {
    socket.to(data.target).emit('ice-candidate', {
      candidate: data.candidate,
      from: socket.id
    });
  });

  // disconnect handling
  socket.on('disconnect', () => {
    console.log('user disconnected:', socket.id);
    
    // check if broadcaster disconnected
    for (const [roomId, room] of rooms.entries()) {
      if (room.broadcaster === socket.id) {
        // notify all listeners stream ended
        io.to(roomId).emit('stream-ended');
        rooms.delete(roomId);
        console.log('room closed:', roomId);
      } else if (room.listeners.has(socket.id)) {
        // remove listener
        room.listeners.delete(socket.id);
        io.to(roomId).emit('listener-count', room.listeners.size);
        console.log('listener left room:', roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`mk-air server running on port ${PORT}`);
});
