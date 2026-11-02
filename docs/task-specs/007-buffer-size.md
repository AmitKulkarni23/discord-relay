# TASK-007: Buffer size as a Railway variable

Depends on: 004

## Goal

Make the server's per-channel buffer configurable with `BUFFER_SIZE` instead of the fixed 100, and fill it at startup even when it is larger than one Discord history page.

## Requirements

1. `loadConfig` MUST read `BUFFER_SIZE`: unset means 100; otherwise an integer from 1 to 500, or exit naming the variable. 500 matches the browser cap.
2. `main` MUST pass it to `createHub(bufferSize)` and to the Discord source as the history limit.
3. History MUST be fetched in pages of at most 100 (Discord's limit), walking back with `before: <oldest id>` until the limit is reached or a page comes back short. Paging logic lives in a pure function with a fake page fetcher in tests.
4. `.railway/railway.ts` MUST set `BUFFER_SIZE: '100'`.

## Acceptance criteria

- [x] Tests cover the default, a valid value, and invalid values (0, 501, `abc`, `1.5`).
- [x] Tests cover paging: under one page, exactly several pages, and a short last page.
- [x] `architecture.md` limits, `backend.rules.md` and `CLAUDE.md` env vars updated.
- [x] Typecheck and `bun test` pass.
