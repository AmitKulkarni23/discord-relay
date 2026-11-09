---
paths:
  - "**/*.test.{ts,tsx}"
---

# Testing Rules

## Runner and location

- Tests MUST use `bun:test`. Vitest and Jest MUST NOT be added.
- Backend tests MUST live in `backend/tests/`, mirroring the source tree: `backend/core/hub.ts` is tested by `backend/tests/core/hub.test.ts`, and `backend/sources/discord.ts` by `backend/tests/sources/discord.test.ts`.
- Frontend tests MUST live in `frontend/tests/`, mirroring the source tree: `frontend/lib/markup.ts` is tested by `frontend/tests/lib/markup.test.ts`.
- Component and hook tests MUST use React Testing Library with happy-dom, by calling `setupDom()` from `frontend/tests/dom.ts`. A preload MUST NOT be used, because it would replace `fetch` for the backend's tests.
- Layout cannot be tested in happy-dom: tests MUST state heights explicitly, and real scrolling and clipping belong in a browser.
- Load harness tests MUST live in `load-tests/tests/` and cover its pure logic. The rest of the harness is checked by running it.
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
- MUST test in components and hooks: URL and link safety, spoiler gating, stream states and reconnects, stick-to-bottom decisions.
- MUST NOT test: discord.js or MUI internals, styling, pure display components.
