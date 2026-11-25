# FLIXTV Party

Independent real-time room service for FLIXTV. It provides synchronized playback state, online presence, room chat, reactions and a shared watch queue. It does **not** proxy or deliver video and has no voice/video calling.

## Stack

- Node.js 20+
- Express
- Socket.IO
- In-memory room state for the first single-instance deployment

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

Health check: `GET /health`

## Create a room

`POST /api/rooms`

```json
{
  "username": "Leon",
  "name": "Friday Movie Night",
  "visibility": "private",
  "movie": { "id": "27205", "title": "Inception", "type": "movie" }
}
```

The response contains a one-time `hostToken` and, for private rooms, an `inviteCode`. Keep the host token secret. It grants host privileges.

## Socket.IO events

Client to server:
- `room:join` — `{ roomId, username, userId?, inviteCode?, hostToken? }`
- `playback:command` — host only; `{ action: "play" | "pause" | "seek", position, duration? }`
- `chat:send` — `{ message }`
- `reaction:send` — `{ emoji }`
- `queue:add` — `{ title, tmdbId?, type? }`
- `queue:remove` — host only; `{ id }`
- `room:typing` — `{ typing }`
- `room:leave`

Server to client:
- `room:state`, `presence:update`, `presence:joined`, `presence:left`
- `playback:state`, `chat:new`, `reaction:new`, `queue:updated`
- `room:typing`, `room:host-changed`, `room:closed`

Most client events accept an optional Socket.IO acknowledgement callback and return `{ ok, ... }`.

## Important deployment notes

1. Set `CORS_ORIGINS` to the exact FLIXTV web/PWA origins before production integration.
2. Room state currently lives in process memory. This is intentional for the first single-instance prototype. A restart clears rooms; multiple replicas will require Redis adapter + shared room state before scaling.
3. This initial backend is a functional foundation, not yet production-hardened identity. FLIXTV must later issue trusted user identities and protect host tokens; do not treat a client-supplied username as account authentication.
4. Playback synchronization coordinates timestamps and commands only. Each participant still needs an independently working, compatible video source/player.
5. No voice chat, camera, or media relay is included.
