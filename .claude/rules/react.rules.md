---
paths:
  - "frontend/**/*.{ts,tsx}"
---

# React + MUI Rules

Rule names in parentheses are from Vercel's react-best-practices. Next.js, server-rendering and SWR rules from that guide MUST NOT be applied: this is a single client-rendered page.

## State and the stream

- `EventSource` MUST be opened in one `useEffect` and closed in its cleanup. The effect MUST have stable dependencies so it does not reconnect on re-render (`rerender-dependencies`).
- State updates from stream events MUST use the functional form, `setMsgs(prev => …)` (`rerender-functional-setstate`).
- Messages MUST be stored keyed by Discord message ID so a resent message replaces, never duplicates.
- The list MUST hold at most 500 messages; the oldest are removed.
- Derived values (sorted list, counts) MUST be computed during render, not in an effect (`rerender-derived-state-no-effect`).
- Message logic (dedupe, cap) SHOULD live in a pure function so it can be unit-tested without React.

## Components

- Components MUST NOT be defined inside other components (`rerender-no-inline-components`).
- The message row component SHOULD be wrapped in `memo` so a new message does not re-render every row (`rerender-memo`).
- Conditionals MUST use a ternary, not `&&`, when the left side can be a number (`rendering-conditional-render`).
- Attachment rendering MUST only happen when the `attachments` flag is on. Bun's HTML bundler does not code-split, so `lazy()` gains nothing here.

## Security

- Message content MUST be rendered as React text. `dangerouslySetInnerHTML` MUST NOT be used.
- Links in message text MUST only be http or https, opened with `target="_blank"` and `rel="noopener noreferrer"`.
- Attachment `src`/`href` MUST only be set when the URL host is `cdn.discordapp.com` or `media.discordapp.net`.
- Images MUST use `loading="lazy"`. Videos MUST NOT autoplay.

## MUI

- Styling MUST use MUI components with `sx` props. CSS files, CSS Modules and Tailwind MUST NOT be used.
- Colors MUST come from the theme in `frontend/theme.ts`. Hex values MUST NOT appear in components.
- MUI MUST be imported per component (`@mui/material/Button`), not from the `@mui/material` barrel (`bundle-barrel-imports`).
- MUI components MUST be preferred over hand-built equivalents.
