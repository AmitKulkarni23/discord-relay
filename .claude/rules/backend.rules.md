---
paths:
  - "backend/**/*.ts"
---

# Backend Rules

## Boundaries

- Only `backend/server.ts` MUST handle HTTP (`Bun.serve`). Only `backend/discord.ts` MUST import discord.js.
- Messages MUST flow through `hub.publish` / `hub.subscribe`. `discord.ts` and `server.ts` MUST NOT call each other directly.
- Everything in the hub MUST be keyed by `channelId`, even with one channel.
- Env vars MUST be read and validated once at startup. A missing or invalid value MUST exit with a log line naming the variable.

## Messages

- Discord messages MUST be normalized to `Msg` in `discord.ts`. Raw discord.js objects MUST NOT leave that file.
- The hub ring buffer MUST be fixed-size (100). Unbounded arrays, maps or queues MUST NOT be added.
- On startup the bot MUST fetch the latest 100 messages to fill the buffer.
- The hub MUST drop a message whose ID is already in the buffer (dedupe by Discord message ID).
- The Discord client MUST request `Guilds`, `GuildMessages` and `MessageContent`. A message with empty content and no attachments MUST log a warning naming the MessageContent intent.

## SSE (`/events`)

- Every event MUST set `id:` to the Discord message ID.
- A new connection MUST receive the buffer first, then live messages.
- A `: ping` comment MUST be sent every 25 seconds (Railway closes streams idle for 5 minutes and caps requests at 15 minutes).
- Subscriptions MUST be removed when the request aborts.

## Reliability

- `/health` MUST return 200 only when the Discord gateway is connected, 503 otherwise.
- If the gateway stays disconnected for more than 5 minutes, the process MUST exit with code 1 so Railway's restart policy restarts it.
- A SIGTERM handler MUST close SSE streams and destroy the Discord client before exiting.
- The start command MUST be `bun run backend/server.ts`, never a package script (scripts swallow SIGTERM).

## Logging

- Logs MUST be one JSON object per line with an `event` field (e.g. `gateway_connected`, `client_connected`, `client_count`).
- The bot token and message content MUST NOT be logged.
