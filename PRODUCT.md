# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Railway interviewers evaluating this take-home for the Senior Software Engineer, Support role. They open the public URL, post in the Discord channel, and watch the message appear on the page. They judge craft, reliability and how honestly the system explains itself.

## Product Purpose

DiscordRelay streams one Discord channel into a public web page, live. A bot holds the Discord Gateway connection, keeps the latest 100 messages in memory and pushes each new one to every open browser over Server-Sent Events. Opening the page shows recent messages at once, then new ones as they are posted. Discord is the source of truth; the page is a read-only live relay, not an archive or a chat client.

Success: within seconds a viewer can tell that the page is live (messages arrive without refresh, connection state is visible), reliable (disconnects, reconnects and empty states are shown honestly), readable (the conversation scans like a calm transcript), and at home next to Railway's own product.

## Positioning

Push end to end with no polling, in one small service: Discord Gateway → Bun server → SSE → browser. The design is deliberately the laziest correct one (one replica, no database, bounded buffers) and the README is honest about alternatives and known problems.

## Operating Context

- Reviewers typically have Discord open in one window and the page in another, posting and watching.
- The page may sit open for a long time; Railway's proxy cuts streams at 15 minutes and deploys restart the server, so the browser reconnects on its own and dedupes by message ID.
- Deployed on Railway, one service, one replica, autodeploy from `main` after CI.

## Capabilities and Constraints

- Message fields available: author name, avatar URL, bot flag, content (raw text, Discord markdown not rendered, mention syntax like `<@id>` passed through), created/edited timestamps, attachments. See `docs/system-specs/message-shape.md`.
- `GET /config` exposes feature flags: `FEATURE_ATTACHMENTS` (images, video, file links; Discord CDN hosts only), `FEATURE_EDITS_DELETES` (live edit/delete updates), `DEBUG_PANEL` (connection status, client count, last event time). Flags are off unless set.
- `GET /health` reports Discord connection, client count, buffer size, last event time, uptime.
- Browser keeps at most 500 messages keyed by ID; server buffers 100.
- Read-only: no posting, no login. The page is public; anyone with the URL can read the channel.
- Stack is fixed by the repo: React + Material UI bundled by Bun HTML imports, MUI `sx` styling only, colors from `frontend/theme.ts` (see `.claude/rules/react.rules.md`).
- Undecided: whether to render Discord markdown or resolve mentions.

## Brand Commitments

- The name is **DiscordRelay** and stays fixed.
- Do not clone Discord's branding or UI. It is a relay, not a Discord client.

## Evidence on Hand

- Architecture, failure modes and decisions: `docs/system-specs/`.
- An anonymized real event: `docs/system-specs/message-shape.md`.
- No screenshots, testimonials or usage numbers exist; do not invent any.

## Product Principles

1. Show the truth about the connection. Live, reconnecting and disconnected states are visible, never hidden behind a spinner.
2. The messages are the product. Chrome stays out of the way of reading.
3. Bounded and calm. Fixed caps, no infinite growth, no attention-grabbing churn when a message lands.
4. Honest over impressive. Nothing on the page claims more than the system does.
