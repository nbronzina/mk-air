# mk-air

signaling for mk-air, the radio of [play·ground](https://nbronzina.github.io/playground/mk-air/).
audio goes browser to browser. this server only introduces them, and keeps rooms in memory: nothing is recorded, nothing survives a restart.

the pages live in play·ground (`mk-air/`, `air-client.js`). this repo runs on Render.

## endpoints

- `WebSocket /air` — signaling v1: `go-live`, `listen`, `signal`, `resume`, `end`; the server sends `count`, `paused`, `ended`
- `GET /air/now` — who is on air
- `GET /air/ice` — STUN, plus TURN when it is configured

## environment

| variable | what |
|---|---|
| `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | Cloudflare TURN key. the server mints day-long credentials and reuses them for 6 h |
| `TURN_URLS`, `TURN_SECRET` | your own coturn with `use-auth-secret`; used when Cloudflare is not set or fails |
| `ALLOWED_ORIGINS` | replaces the default origins (nbronzina.github.io, localhost, 127.0.0.1); comma separated, `:*` for any port |
| `PORT` | set by Render |

without TURN, listeners behind strict NAT or some mobile networks can't connect and see "can't reach".

### TURN with Cloudflare

1. Cloudflare dashboard → Realtime → TURN: create a TURN key
2. copy the key id and the API token
3. Render → mk-air → Environment: add `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN`, save (it redeploys)
4. check: `GET /air/ice` returns `turn:turn.cloudflare.com` urls with a username

the first 1,000 GB a month are free, then $0.05 per GB.

## run locally

```
npm install
PORT=8181 node mk-air-server.js
```

open a play·ground page with `?air=http://localhost:8181`.
