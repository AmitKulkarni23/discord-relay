# Task 002: Message types and the hub

## Summary

Add the shared `Msg` type and the hub: a per-channel ring buffer of the latest 100 messages with publish/subscribe. The hub is the Observer pattern. Sources publish into it, and each open browser stream subscribes to it. It has no knowledge of Discord or HTTP, so it is tested on its own. See "Components", "Patterns" and "Message shape" in `docs/system-specs/architecture.md`.

## Conventions

Read these before writing code:

- `CLAUDE.md`
- `docs/system-specs/architecture.md`: Components, Patterns, Message shape, Limits
- `.claude/rules/typescript.rules.md`
- `.claude/rules/backend.rules.md`
- `.claude/rules/testing.rules.md`

## Requirements

### Types

1. `backend/types.ts` MUST export `Msg` and `Attachment` exactly as defined in "Message shape".

### Hub

2. `backend/hub.ts` MUST export `createHub(capacity = 100)` and a `Hub` type derived from its return value. It MUST NOT export a module-level hub instance.
3. `publish(msg)` MUST store the message in the buffer for `msg.channelId` and then call every subscriber of that channel with it.
4. `publish` MUST ignore a message whose ID is already in that channel's buffer, and MUST NOT notify subscribers for it.
5. When a channel's buffer exceeds `capacity`, the oldest message MUST be dropped.
6. `subscribe(channelId, fn)` MUST return a function that removes the subscriber. Calling it twice MUST be harmless.
7. A subscriber that throws MUST NOT stop the other subscribers from receiving the message.
8. `recent(channelId)` MUST return that channel's buffered messages, oldest first. Changing the returned array MUST NOT change the buffer.
9. `subscriberCount()` MUST return the number of subscribers across all channels.
10. Messages and subscribers for one channel MUST NOT reach another channel.
11. Every exported function MUST have a comment saying what it does.

## Technical notes

- `Array.shift()` is fine at 100 messages. Mark it with a comment naming the ceiling.
- Dedupe only checks the buffer, so a message evicted long ago could be published again. That cannot happen with live Discord events, and a restart starts with an empty hub.
- Edits and deletes are out of scope until `FEATURE_EDITS_DELETES` is planned.

## TDD plan

### RED

All tests live in `backend/hub.test.ts` under `describe('hub')`.

| # | Test | Asserts |
|---|---|---|
| 1 | when a message is published, should deliver it to subscribers of its channel | subscriber called once with the message |
| 2 | when a message is published, should add it to the channel's recent messages | `recent()` contains it |
| 3 | when the same ID is published twice, should keep one copy | `recent()` length 1 |
| 4 | when the same ID is published twice, should notify subscribers once | subscriber called once |
| 5 | when the buffer is full, should drop the oldest message on the next publish | capacity 3, publish 4, oldest gone, order kept |
| 6 | when a subscriber unsubscribes, should stop receiving messages | not called after unsubscribe |
| 7 | when unsubscribe is called twice, should not throw or remove others | other subscriber still called |
| 8 | when a subscriber throws, should still deliver to the other subscribers | second subscriber called |
| 9 | when messages belong to different channels, should keep them apart | each channel's subscribers and buffer see only their own |
| 10 | when recent messages are read, should return a copy | mutating the result leaves the buffer intact |
| 11 | when subscribers come and go, should report the current count | `subscriberCount()` matches |

### GREEN

1. `backend/types.ts`
2. `backend/hub.ts` until tests 1 to 11 pass

### REFACTOR

None expected.

## Dependencies

- TASK-001: project and test runner.

## Files to create or modify

- `backend/types.ts` (create)
- `backend/hub.ts` (create)
- `backend/hub.test.ts` (create)

## Acceptance criteria

- [ ] Tests 1 to 11 were written first and failed for the right reason
- [ ] All tests pass and `bun run typecheck` is clean
- [ ] The hub imports nothing from Discord or HTTP code
- [ ] Every exported function has a comment

## Spec updates

None.
