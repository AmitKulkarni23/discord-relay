---
paths:
  - "**/*.{ts,tsx}"
---

# TypeScript Rules

- `strict` mode MUST be on. `any` MUST NOT be used.
- Data from outside the process (Discord payloads, env vars, request query params) MUST be typed `unknown` and narrowed before use.
- Non-null assertions (`!`) MUST NOT be used. Narrow with a check instead.
- Exported functions MUST have explicit return types.
- The message shape MUST be the single `Msg` type in `backend/types.ts`, imported by both backend and frontend. It MUST NOT be redefined.
- Types SHOULD be `type` aliases; `interface` MAY be used only when declaration merging is needed.
- Code MUST NOT add an interface, class or factory with a single implementation.
- 2-space indentation.

```ts
// Bad
const channelId = process.env.CHANNEL_ID!

// Good
const channelId = process.env.CHANNEL_ID
if (!channelId) throw new Error('CHANNEL_ID is required')
```
