# TASK-008: Multiple channels

Depends on: 006, 007

## Goal

Relay several Discord channels from the one bot and service, with a channel switcher on the page. No new Railway service.

## Requirements

1. `CHANNEL_ID` MUST accept one or more channel IDs, comma-separated (`123,456`). Each MUST be a 17 to 20 digit snowflake; duplicates are dropped; an empty or invalid entry exits naming `CHANNEL_ID`. One variable, so existing deploys keep working unchanged.
2. The Discord source MUST filter live messages against the configured set, load history for every channel, and expose each channel's name once loaded.
3. `GET /events?channel=<id>` MUST stream that channel. No `channel` means the first configured one. An ID not in the configured set MUST return 404 (the query param is untrusted input).
4. `GET /config` MUST return `channels: [{ id, name }]` (name null until loaded) in place of `channelName`.
5. `/health` `buffered` MUST be the total across channels and `lastEventAt` the newest across channels.
6. The page MUST show tabs when there is more than one channel, keep the selection in the URL (`?channel=`), and on switch close the old stream, clear the list and open the new one. With one channel it looks as before.

## Acceptance criteria

- [ ] Tests: config parsing (one, several, duplicates, invalid), `/events` default channel, explicit channel, unknown channel 404, `/config` shape, `/health` totals.
- [ ] `architecture.md`, `message-shape.md` (if touched), `CLAUDE.md` env vars updated.
- [ ] Typecheck and `bun test` pass.
- [ ] User adds the second channel ID in Railway and checks the switcher (**asks the user**).
