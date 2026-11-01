# Task 004: Discord bot source

## Summary

Add the Discord source: log in to the Gateway, fetch the latest 100 messages at startup, convert each discord.js message to `Msg`, and publish it to the hub. Track whether the Gateway is connected for `/health`, and exit the process if it stays disconnected for 5 minutes so Railway restarts it. See "Flows" in `docs/system-specs/architecture.md`, rows 7 to 11 in `docs/system-specs/failure-modes.md`, and D11 in `docs/system-specs/decisions.md`.

## Conventions

Read these before writing code:

- `CLAUDE.md`
- `docs/system-specs/architecture.md`: Components, Flows (startup, a new message), Message shape
- `docs/system-specs/failure-modes.md`: rows 7 to 11
- `.claude/rules/typescript.rules.md`
- `.claude/rules/backend.rules.md`
- `.claude/rules/testing.rules.md`

## Requirements

### Normalizing

1. `backend/sources/discord.ts` MUST be the only file that imports `discord.js`.
2. `toMsg(message)` MUST convert a discord.js message to `Msg`: author name is `globalName` when set, otherwise `username`; times are ISO strings; attachments keep `url`, `name` and `contentType`.
3. `toMsg` MUST accept a narrow structural type (the fields it reads), so tests can pass plain objects.
4. `isMissingContent(msg)` MUST return true when content is empty and there are no attachments.

### Bot

5. `startDiscord(deps)` MUST take `token`, `channelId` and `publish` as arguments, plus an optional `onWatchdogExpired` callback.
6. The client MUST request the `Guilds`, `GuildMessages` and `MessageContent` intents.
7. After the client is ready, it MUST fetch the latest 100 messages from the channel and publish them oldest first. A fetch error MUST be logged, and the bot MUST keep running.
8. On `messageCreate`, it MUST publish messages from the configured channel only.
9. When `isMissingContent` is true for a published message, it MUST log a warning that names the MessageContent intent.
10. It MUST return `{ isConnected, stop }`. `isConnected()` is true after ready or resume, and false after a disconnect or while reconnecting.

### Watchdog

11. `createWatchdog({ limitMs, onExpire, setTimer, clearTimer })` MUST call `onExpire` once the Gateway has been disconnected for `limitMs` without reconnecting. `setTimer` and `clearTimer` default to `setTimeout` and `clearTimeout` and are passed in so tests can control time.
12. Reconnecting before `limitMs` MUST cancel the pending expiry.
13. The bot MUST use a 5-minute limit.

### Wiring

14. `main()` in `backend/server.ts` MUST start the Discord source with `hub.publish`, pass its `isConnected` to the server, log and exit with code 1 when the watchdog expires or login fails, and call its `stop()` on SIGTERM.
15. Every exported function MUST have a comment saying what it does.

## Technical notes

- discord.js emits `ShardReady`, `ShardResume`, `ShardDisconnect` and `ShardReconnecting`. Use these for connection state.
- `channel.messages.fetch({ limit: 100 })` returns newest first.
- Tests never call Discord. Login, history fetch and event handling are verified by running locally against a test channel.
- Enable the MessageContent intent for the bot in the Discord developer portal before running locally.

## TDD plan

### RED

Tests in `backend/sources/discord.test.ts`.

| # | Test | Asserts |
|---|---|---|
| 1 | toMsg: when the author has a global name, should use it | `author.name` |
| 2 | toMsg: when the author has no global name, should use the username | `author.name` |
| 3 | toMsg: when a message has attachments, should keep url, name and content type | `attachments` |
| 4 | toMsg: when a message was edited, should set editedAt | ISO string |
| 5 | isMissingContent: when content and attachments are empty, should return true | `true` |
| 6 | isMissingContent: when there is an attachment, should return false | `false` |
| 7 | watchdog: when disconnected longer than the limit, should call onExpire once | called once |
| 8 | watchdog: when reconnected before the limit, should not call onExpire | not called |
| 9 | watchdog: when disconnect is reported twice, should keep the first deadline | one timer |

### GREEN

1. Add `discord.js`
2. `toMsg` and `isMissingContent` (tests 1 to 6)
3. `createWatchdog` (tests 7 to 9)
4. `startDiscord`
5. Wire into `main()`

### REFACTOR

None expected.

## Dependencies

- TASK-002: the hub and `Msg`.
- TASK-003: `main()` and `/health`.

## Files to create or modify

- `package.json`, `bun.lock` (modify: add `discord.js`)
- `backend/sources/discord.ts` (create)
- `backend/sources/discord.test.ts` (create)
- `backend/server.ts` (modify: wiring)

## Acceptance criteria

- [ ] Tests 1 to 9 were written first and failed for the right reason
- [ ] All tests pass and `bun run typecheck` is clean
- [ ] Running locally with `<DISCORD_TOKEN>` and `<CHANNEL_ID>` shows history and new messages on `curl -N localhost:3000/events`, and `/health` returns 200
- [ ] Every exported function has a comment

## Spec updates

None.
