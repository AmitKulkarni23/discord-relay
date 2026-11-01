# Decisions

Each entry gives the choice, the reason, the alternatives we considered, and when to look at it again.

## D1. SSE to the browser

We push messages with Server-Sent Events (`EventSource`). Data only flows from server to browser, so SSE is enough: it runs over plain HTTP, reconnects on its own, and needs no client library.

WebSockets are two-way, which we don't need, but they are exempt from Railway's 15-minute request cap. Polling would add lag and requests.

Revisit if the browser needs to send messages, or if the 15-minute reconnect causes problems.

## D2. Bun runtime

Bun is the runtime, bundler and test runner. `Bun.serve`, frontend bundling and `bun test` are built in, so we need no Express, Vite or Jest. The alternative was Node with Express and Vite.

Revisit if a discord.js feature breaks on Bun.

## D3. One service for backend and frontend

`Bun.serve` serves the React page through an HTML import. That gives one deploy and one domain, and no CORS setup.

Next.js is built around handling requests, so a long-lived bot needs workarounds there, and its dev hot reload can start two bots. Separate frontend and backend services would mean two deploys and CORS.

Revisit if the frontend grows into a multi-page app.

## D4. React and Material UI

React and MUI give a polished, accessible page quickly, and React escapes text, which blocks script injection. One plain HTML file would have been smaller and would meet the requirement.

Revisit if bundle size matters.

## D5. No database

Each channel has an in-memory ring buffer of 100 messages, refilled from Discord at startup. Discord already stores every message, and a second copy would add a service and sync problems without helping users.

Postgres would give durable history and search. SQLite on a Railway volume was ruled out because volumes can't be used with replicas.

Revisit for search, history beyond 100 messages, many channels, or many replicas all fetching from Discord at startup.

## D6. One replica

The service runs one replica, and the restart policy handles crashes. Each extra replica would run its own bot with its own buffer.

Option A gives every replica its own bot. That works because the bot only reads, and Railway routes requests randomly with no sticky sessions. Option B runs one bot in its own one-replica service, publishing to Redis, with any number of web replicas subscribing.

Revisit if a few seconds of downtime on a crash is unacceptable, or if connections approach Railway's 10,000 limit.

## D7. Reconnects resend the full buffer

Every `/events` connection receives the full buffer, and the browser dedupes by message ID. This avoids tracking each client's position, and resending 100 messages every 15 minutes costs almost nothing.

The alternative is `Last-Event-ID` replay of only the missed messages. Every event already carries the message ID, so switching is a small change.

Revisit if the buffer grows large.

## D8. Feature flags as Railway variables

Flags are env vars read at startup and exposed through `/config`. They need no extra service and live with the rest of the config. A flag service or DB-backed flags would allow changes without a redeploy.

Revisit if flags need to change without a redeploy.

## D9. Railway Infrastructure as Code

Service config lives in `.railway/railway.ts`, applied with `railway config plan` and `railway config apply`. Railway has deprecated Config as Code (`railway.json`): new services can't opt in, and existing files stop working on 2026-12-01. The other option was setting everything in the dashboard.

## D10. No staging environment

There is only production, which autodeploys `main` once "Wait for CI" sees typecheck and `bun test` pass. Unit and integration tests cover the logic without Discord, and a staging bot, token and channel would add setup for little gain at this size.

The alternative was a staging environment autodeploying `main`, end-to-end tests that post through a Discord webhook, and promotion by fast-forwarding a `production` branch.

Revisit if more than one person deploys, or if a bad deploy becomes costly.

## D11. Gateway watchdog

The process exits with code 1 if the Gateway stays disconnected for more than 5 minutes. Railway only runs healthchecks at deploy time, so it would never restart a stalled process that is still running.

We could have trusted discord.js reconnects alone, or added an external uptime monitor that hits `/health`.

Revisit if an external monitor is added.

## D12. No moderation filter

The app does not filter content. Discord AutoMod can block messages before they are posted, with no code on our side.

A `filter()` before `hub.publish` is the in-app option. A word list is fast but easy to evade. A moderation API understands context but adds latency and cost, and we would have to decide whether messages pass or wait when the API is down.

Revisit if we need to relay a channel we don't moderate.

## D13. Extensibility through `channelId`

The hub is keyed by `channelId` and exposes one `publish`/`subscribe` seam. More channels become a config change, and Redis can replace the hub behind the same two functions. We did not add source or plugin interfaces, because they would each have one implementation.

Revisit when a second source exists.
