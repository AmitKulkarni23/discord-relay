---
paths:
  - "backend/**/*.ts"
---

# Backend Rules

## Boundaries

- Only `backend/server.ts` MUST call `Bun.serve`, and only `backend/events.ts` MUST build SSE streams. Only `backend/sources/discord.ts` MUST import discord.js. Only `backend/flags.ts` MUST import the `railway` runtime SDK (`.railway/railway.ts` uses `railway/iac`).
- Feature flags MUST be read through the reader from `startFlags`, at request time, never cached at startup. A flag read MUST never throw or block startup; missing flags fall back to off.
- Messages MUST flow through `hub.publish` / `hub.subscribe`. Sources and the HTTP server MUST NOT call each other directly.
- Dependencies MUST be passed as function arguments and wired only in `server.ts`. Modules MUST NOT import another module's instance; the hub MUST be created with `createHub()`.
- A new source MUST go in `backend/sources/` and reach the hub only through functions it is passed, such as `publish` and `remove`.
- Everything in the hub MUST be keyed by `channelId`, even with one channel.
- Env vars MUST be read and validated once at startup. A missing or invalid value MUST exit with a log line naming the variable.

## Messages

- Discord messages MUST be normalized to `Msg` in `discord-message.ts`. Raw discord.js objects MUST NOT leave that file.
- The hub ring buffer MUST be fixed-size: `BUFFER_SIZE` (1 to 500, default 100). Unbounded arrays, maps or queues MUST NOT be added.
- On startup, and again whenever the Gateway starts a fresh session instead of resuming, the bot MUST fetch the latest `BUFFER_SIZE` messages, in pages of at most 100 (Discord's limit).
- The hub MUST drop a message whose ID is already in the buffer (dedupe by Discord message ID).
- The hub buffer MUST stay in ID order, and eviction MUST remove the oldest ID, whatever order messages arrive in.
- The Discord client MUST request `Guilds`, `GuildMessages` and `MessageContent`. The first message with empty content and no attachments MUST log one warning per process naming the MessageContent intent.

## SSE (`/events`)

- Every message event MUST set `id:` to the Discord message ID. Named events (`ping`, `discord`, `delete`) MUST NOT set `id:`, because they are not positions in the stream.
- A new connection MUST receive the buffer first, then live messages. With a valid `?since=`, both MUST be limited to newer messages.
- An `event: ping` MUST be sent every 25 seconds, so the page can notice a dead stream (Railway closes streams idle for 5 minutes and caps requests at 15 minutes).
- Subscriptions MUST be removed when the request aborts.
- A stream MUST count queued bytes and drop a client past the limit on a live write. `/events` MUST return 429 past the per-IP connection cap.

## Reliability

- `/health` MUST return 200 only when the Discord gateway is connected, 503 otherwise.
- If the gateway stays disconnected for more than 5 minutes, the process MUST reconnect with a fresh client and keep its buffer. It MUST exit with code 1 only for a login that retrying cannot fix, such as a bad token.
- A SIGTERM handler MUST close SSE streams and destroy the Discord client before exiting.
- The start command MUST be `bun run backend/server.ts`, never a package script (scripts swallow SIGTERM).

## Logging

- Logs MUST go through `log.debug|info|warn|error(event, fields)` in `backend/log.ts`: one JSON object per line with `level` and `event` fields (e.g. `gateway_connected`, `client_connected`). Railway filters on `@level:` and `@event:`.
- Levels: `error` for failures that need action (bad config, login failed, watchdog), `warn` for degraded but self-healing (Gateway down, missing content), `info` for lifecycle, `debug` for per-browser connects and disconnects.
- `debug` lines MUST stay off in production unless `LOG_LEVEL=debug`, so nothing that needs noticing may log only at `debug`.
- `client_*` events MUST include `requestId` from `X-Railway-Request-Id`, so they can be matched to Railway's network logs.
- The bot token, message content and client IP addresses MUST NOT be logged.
