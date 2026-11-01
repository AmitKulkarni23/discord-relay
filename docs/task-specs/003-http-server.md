# Task 003: HTTP server and SSE stream

## Summary

Add the entry point: load and validate config, create the hub, and serve `/`, `/events`, `/health` and `/config` with `Bun.serve`. `/events` sends the buffered messages, then live ones, with a heartbeat. The server is tested end to end with a fake source that publishes into the hub, so no Discord bot is needed. See "HTTP API", "Flows" and "Limits" in `docs/system-specs/architecture.md` and rows 1, 2, 14 and 15 in `docs/system-specs/failure-modes.md`.

## Conventions

Read these before writing code:

- `CLAUDE.md`
- `docs/system-specs/architecture.md`: HTTP API, Flows (startup, browser connecting, shutdown), Configuration, Limits
- `.claude/rules/typescript.rules.md`
- `.claude/rules/backend.rules.md`
- `.claude/rules/testing.rules.md`

## Requirements

### Config

1. `loadConfig(env)` MUST return `{ token, channelId, port, flags }` from an env object. It MUST throw an error naming the variable when `DISCORD_TOKEN` or `CHANNEL_ID` is missing or empty.
2. `port` MUST default to 3000 when `PORT` is unset and MUST reject a value that is not a positive integer.
3. Each flag (`FEATURE_ATTACHMENTS`, `FEATURE_EDITS_DELETES`, `DEBUG_PANEL`) MUST be `true` only when its value is the string `true`.

### Routes

4. `startServer(deps)` MUST take its dependencies as arguments: `port`, `hub`, `channelId`, `flags`, `isDiscordConnected`, and an optional `pingMs` (default 25000).
5. `GET /` MUST return a short plain-text page until the frontend exists.
6. `GET /events` MUST respond with `Content-Type: text/event-stream` and `Cache-Control: no-cache`, send every buffered message for the channel, then each new message as it is published.
7. Each event MUST be formatted as `id: <message id>\ndata: <Msg JSON>\n\n`.
8. `/events` MUST send `: ping\n\n` every `pingMs`.
9. When the client disconnects, the server MUST unsubscribe it from the hub and stop its heartbeat.
10. `/events` MUST turn off Bun's idle timeout for that request so the stream is not closed after 10 seconds.
11. `GET /health` MUST return 200 when `isDiscordConnected()` is true and 503 otherwise, with the JSON body from "HTTP API".
12. `GET /config` MUST return `{ attachments, editsDeletes, debugPanel }`.
13. `startServer` MUST return a `stop()` function that closes every open stream and stops the server.

### Entry point and logging

14. `main()` MUST run only when `backend/server.ts` is executed directly (`import.meta.main`).
15. `main()` MUST exit with code 1 and a log line naming the variable when config is invalid.
16. On SIGTERM, `main()` MUST call `stop()` and exit with code 0.
17. Logs MUST be single-line JSON with an `event` field, written by a small `log()` helper in `backend/log.ts`. The token MUST NOT be logged.
18. Every exported function MUST have a comment saying what it does.

## Technical notes

- Until task 004, `main()` passes `isDiscordConnected: () => false`, so `/health` returns 503 locally. That is expected.
- Bun's default `idleTimeout` is 10 seconds. Use `server.timeout(req, 0)` inside the `/events` handler.
- Encode stream chunks with `TextEncoder` before enqueueing them.
- Integration tests start the server on port 0 and read `/events` with `fetch` and a stream reader. To wait for an async condition, await the next chunk or use a small `waitFor` helper that polls with a deadline; never a fixed sleep.

## TDD plan

### RED

Unit tests in `backend/server.test.ts` under `describe('loadConfig')` and `describe('formatEvent')`. Integration tests in the same file under `describe('server')`.

| # | Test | Asserts |
|---|---|---|
| 1 | loadConfig: when DISCORD_TOKEN is missing, should throw naming it | error message contains `DISCORD_TOKEN` |
| 2 | loadConfig: when CHANNEL_ID is empty, should throw naming it | error message contains `CHANNEL_ID` |
| 3 | loadConfig: when PORT is unset, should default to 3000 | `port === 3000` |
| 4 | loadConfig: when PORT is not a number, should throw naming it | error message contains `PORT` |
| 5 | loadConfig: when a flag is "true", should enable only that flag | flags object |
| 6 | formatEvent: when given a message, should produce an SSE event with its ID | exact string |
| 7 | server: when a browser opens /events, should send the buffered messages first | first events match `recent()` order |
| 8 | server: when a message is published after connecting, should stream it | event arrives |
| 9 | server: when the stream is idle, should send a ping | `: ping` chunk with `pingMs: 20` |
| 10 | server: when the browser disconnects, should unsubscribe it | `subscriberCount()` returns to 0 |
| 11 | server: when Discord is connected, should report healthy | 200 and `discord: "connected"` |
| 12 | server: when Discord is disconnected, should report unhealthy | 503 |
| 13 | server: when /config is requested, should return the flags | JSON body |
| 14 | server: when stop is called, should close open streams | reader reports `done` |

### GREEN

1. `backend/log.ts`
2. `loadConfig` and `formatEvent` (tests 1 to 6)
3. `startServer` routes (tests 7 to 14)
4. `main()` with SIGTERM handling

### REFACTOR

- Move test helpers (fake message factory, stream reader, `waitFor`) to the top of the test file if they repeat.

## Dependencies

- TASK-002: the hub and `Msg`.

## Files to create or modify

- `backend/log.ts` (create)
- `backend/server.ts` (create)
- `backend/server.test.ts` (create)

## Acceptance criteria

- [ ] Tests 1 to 14 were written first and failed for the right reason
- [ ] All tests pass and `bun run typecheck` is clean
- [ ] `bun run dev` with `DISCORD_TOKEN` and `CHANNEL_ID` set serves `/`, `/config` and `/health` (503) locally
- [ ] Every exported function has a comment

## Spec updates

- [ ] `docs/system-specs/architecture.md`: note that `GET /` is plain text until the frontend task, if the route table needs it
