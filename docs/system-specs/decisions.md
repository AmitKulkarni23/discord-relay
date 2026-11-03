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

Each channel has an in-memory ring buffer of `BUFFER_SIZE` messages (default 100, at most 500), refilled from Discord at startup. Discord already stores every message, and a second copy would add a service and sync problems without helping users.

Postgres would give durable history and search. SQLite on a Railway volume was ruled out because volumes can't be used with replicas.

Revisit for search, history beyond 500 messages, many channels, or many replicas all fetching from Discord at startup.

## D6. One replica

The service runs one replica, and the restart policy handles crashes. Each extra replica would run its own bot with its own buffer.

Option A gives every replica its own bot. That works because the bot only reads, and Railway routes requests randomly with no sticky sessions. Option B runs one bot in its own one-replica service, publishing to Redis, with any number of web replicas subscribing.

Revisit if a few seconds of downtime on a crash is unacceptable, or if connections approach Railway's 10,000 limit.

## D7. Reconnects get only newer messages

A new page receives the full buffer. A reconnecting browser passes the newest ID it holds as `?since=` and receives only newer messages, including any that arrive live while a restarted server refills its buffer. Without this, every 15-minute cut resends the whole buffer to every client: about 58 KB each, or about 56 GB a day at 10,000 clients.

We use a query parameter instead of the `Last-Event-ID` header because the browser's own reconnect is what sends that header, and the page replaces it with its own loop (D7a). Messages older than the buffer are still skipped.

## D7a. The browser reconnects itself, with jitter

`EventSource` retries a dropped stream after a fixed delay of about 3 seconds and stops for good on an HTTP error. So every error closes it and the page reconnects after a random delay, up to 1 s and doubling per attempt to 30 s. Backoff starts over only after a stream has stayed open 30 s, so a server that accepts connections and then dies keeps pushing browsers further apart.

Revisit if the load test in `todo.md` shows a one-second spread is too narrow for a deploy. The next step is having the server close streams at random times across the 30 s draining window. Streams dropped together also reach the 15-minute cut together, which `?since=` makes cheap but does not spread.

## D8. Feature flags in Railway Feature Flags

Flags live in Railway's Feature Flags (project settings) and the server reads them with the `railway` SDK, which keeps them in memory and polls Railway. `/config` reads them on every request, so a change reaches the next page load in seconds with no redeploy.

The first version used Railway service variables read at startup. Those are versioned in `railway.ts` and need no token, but every change redeploys. Railway's flags cost a project token (`RAILWAY_TOKEN`) and a runtime dependency, and they are not in IaC yet. If Railway is unreachable or the token is missing, every flag reads as off and the app keeps running.

Revisit if Railway IaC adds flags (move them into `railway.ts`), or if flag reads must not depend on Railway's API.

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

The hub is the Observer pattern, keyed by `channelId`, with one `publish`/`subscribe` seam. More channels become a config change, and Redis can replace the hub behind the same two functions. We did not add source or plugin interfaces, because they would each have one implementation.

Revisit when a second source exists.
