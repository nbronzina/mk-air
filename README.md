# mk-air

signaling for mk-air, the radio of [play·ground](https://nbronzina.github.io/playground/mk-air/).
audio goes browser to browser. this server introduces them, and relays the sound for listeners whose network won't take a direct line. rooms live in memory: nothing is recorded, nothing survives a restart.

the pages live in play·ground (`mk-air/`, `air-client.js`). this repo runs on Render. old links land there: `/` and `/broadcast` on mk-air/, `/listen/<id>` on mk-air/?r=<id>.

## endpoints

- `WebSocket /air` — signaling v1: `go-live`, `listen`, `signal`, `resume`, `end`, `relay`; the server sends `count`, `paused`, `ended`. binary messages carry relayed audio
- `GET /air/now` — who is on air
- `GET /air/ice` — the STUN servers browsers use to find a direct line

## environment

| variable | what |
|---|---|
| `RELAY_GB` | monthly budget for the relay, in GB. default 4; `0` turns the relay off |
| `RELAY_MAX` | listeners on the relay at once, across every room. default 5 |
| `ALLOWED_ORIGINS` | replaces the default origins (nbronzina.github.io, localhost, 127.0.0.1); comma separated, `:*` for any port |
| `PORT` | set by Render |

## the relay

browsers try a direct line first (STUN). some networks don't allow it: strict NAT, some company networks, some mobile carriers. for those listeners the sound comes through this server instead, over the same WebSocket:

- the listener asks for it after 8 s without a direct line
- the broadcaster records its stream as Opus at 48 kbps (MediaRecorder) and sends the packets; the server passes them on and keeps nothing
- the listener decodes them (WebCodecs) and plays them under a second behind

it costs this server's bandwidth: about 22 MB an hour per relayed listener. Render's free plan includes 5 GB a month and suspends the service until the next month when it runs out (it doesn't charge without a card). so the relay stops taking listeners at `RELAY_GB` and cuts the ones left at 10% more.

the count lives in memory: when Render puts the server to sleep (15 minutes with nobody connected), it starts again from zero. Render's dashboard shows the real monthly usage; lower `RELAY_GB` if it gets close.

works for a broadcaster on Chrome, Edge or Firefox, and a listener on Chrome, Edge, Firefox on a computer, or Safari 26 and later. anywhere else the listener sees "can't reach", as before.

## run locally

```
npm install
PORT=8181 node mk-air-server.js
```

open a play·ground page with `?air=http://localhost:8181`.
