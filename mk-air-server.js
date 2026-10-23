// mk-air: signaling for a radio that forgets. audio goes peer to peer; rooms live only in memory

const http = require('http');
const path = require('path');
const express = require('express');
const { originCheck, registry } = require('./guard');
const { createAir } = require('./air');
const { createLegacy } = require('./legacy');

const MAX_ROOMS = 50;
const MAX_LISTENERS = 50;
const MAX_RATE = 60;

// events and counts only: no ids, names, tokens or addresses reach the logs
const log = msg => console.log(msg);

const originAllowed = originCheck(process.env);
const ids = registry(MAX_ROOMS);
const limits = { maxListeners: MAX_LISTENERS, maxRate: MAX_RATE };

const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);

const air = createAir({ server, registry: ids, originAllowed, log, limits });
createLegacy({ server, registry: ids, originAllowed, log, limits });

app.use('/air', (req, res, next) => {
  const origin = req.headers.origin;
  res.set('Vary', 'Origin');
  res.set('Cache-Control', 'no-store');
  if (origin !== undefined) {
    if (!originAllowed(origin, req.headers.host)) return res.status(403).json({ error: 'origin' });
    res.set('Access-Control-Allow-Origin', origin);
  }
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET');
    return res.sendStatus(204);
  }
  next();
});

app.get('/air/now', (req, res) => res.json(air.now()));
app.get('/air/ice', (req, res) => res.json(air.ice()));

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/broadcast', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'broadcast.html'));
});

app.get('/listen/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'listen.html'));
});

app.use((err, req, res, next) => {
  res.status(err && err.status && err.status < 500 ? err.status : 500).end();
});

// losing the process loses every room on air; a bug in one handler must not take the others down
process.on('uncaughtException', e => log(`uncaught ${e && e.name}`));
process.on('unhandledRejection', e => log(`unhandled ${e && e.name}`));

const PORT = Number(process.env.PORT) || 3000;
server.on('error', e => {
  log(`server error ${e && e.code}`);
  process.exit(1);
});
server.listen(PORT, () => {
  log(`mk-air on port ${PORT}`);
});
