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
| `TURN_URLS`, `TURN_SECRET` | your own [coturn](https://github.com/coturn/coturn) with `use-auth-secret`. optional |
| `ALLOWED_ORIGINS` | replaces the default origins (nbronzina.github.io, localhost, 127.0.0.1); comma separated, `:*` for any port |
| `PORT` | set by Render |

## TURN, optional

without TURN, browsers connect directly (STUN). that works for most listeners; behind strict NAT, some company networks or some mobile carriers a listener sees "can't reach".

TURN relays the audio for them. coturn is free and open source, but it needs a machine with a public IP and open UDP ports, which Render doesn't offer: a computer at home with port forwarding, or a free VM.

1. install coturn (`apt install coturn`) and write `/etc/turnserver.conf`:

   ```
   listening-port=3478
   min-port=49160
   max-port=49200
   realm=mk-air
   use-auth-secret
   static-auth-secret=<a long random string>
   fingerprint
   no-cli
   no-multicast-peers
   denied-peer-ip=10.0.0.0-10.255.255.255
   denied-peer-ip=172.16.0.0-172.31.255.255
   denied-peer-ip=192.168.0.0-192.168.255.255
   total-quota=100
   max-bps=64000
   ```

   behind a router, add `external-ip=<public ip>/<private ip>`. the quotas keep a stranger from using it as a free relay: 100 sessions, 64 KB/s each (a stereo stream at 128 kbps uses about 16). then `systemctl enable --now coturn` (older Debian packages also want `TURNSERVER_ENABLED=1` in `/etc/default/coturn`)

2. open TCP and UDP 3478, and UDP 49160–49200
3. Render → mk-air → Environment:
   - `TURN_URLS` = `turn:<host>:3478?transport=udp,turn:<host>:3478?transport=tcp`
   - `TURN_SECRET` = the same string as `static-auth-secret`
4. check: `GET /air/ice` returns the `turn:` urls with a username

credentials last a day, so a long set keeps working for listeners who arrive late.

## run locally

```
npm install
PORT=8181 node mk-air-server.js
```

open a play·ground page with `?air=http://localhost:8181`.
