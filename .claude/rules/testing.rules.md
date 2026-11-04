---
paths:
  - "**/*.test.{ts,tsx}"
---

# Testing Rules

## Runner and location

- Tests MUST use `bun:test`. Vitest and Jest MUST NOT be added.
- Backend tests MUST live in `backend/tests/`, mirroring the source tree: `backend/hub.ts` is tested by `backend/tests/hub.test.ts`, and `backend/sources/discord.ts` by `backend/tests/sources/discord.test.ts`.
- Frontend tests MUST live in `frontend/tests/`, mirroring the source tree: `frontend/lib/markup.ts` is tested by `frontend/tests/lib/markup.test.ts`.
- Tests MUST NOT call Discord or any network service. Integration tests MUST replace the bot with a fake source that calls `hub.publish`.

## Structure and naming

- Each file MUST have a top-level `describe` named after the unit under test.
- `it` blocks MUST be grouped under nested `describe("when …")` blocks, never directly under the top level.
- Test names MUST use `should <outcome> when <trigger>`.

```ts
describe('hub', () => {
  describe('when the buffer is full', () => {
    it('should drop the oldest message when a new one is published', () => {})
  })
  describe('when a message is published twice', () => {
    it('should keep one copy when the IDs match', () => {})
  })
})
```

## Assertions and async

- Every test MUST have at least one specific assertion.
- Tests MUST NOT `sleep` or use fixed `setTimeout` waits. Await the event or use fake timers.
- Test data SHOULD look real (realistic Discord IDs, authors, content), not `"test"` or `"abc"`.

## What to test

- MUST test: hub (cap, eviction, dedupe, subscribe/unsubscribe), message normalization, SSE formatting and replay order, env validation, frontend message reducer.
- MUST NOT test: discord.js or MUI internals, styling, pure display components.
