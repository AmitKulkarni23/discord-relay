# DiscordRelay

A Discord bot that streams messages from one or more Discord channels into a web page in real time. 

Link: discord-relay-production-262e.up.railway.app


## Acronyms and Terminology

| Term | Meaning |
| --- | --- |
| Bun | JavaScript runtime with a built-in HTTP server, bundler and test runner. Runs the server, bundles the React page and runs the tests. |
| Gateway | Discord's real-time WebSocket API. The bot gets new and deleted messages through it. |
| Snowflake | Discord's message ID: unique and time-ordered. Used for ordering and dedupe. |
| MessageContent intent | Discord permission the bot needs to read message text. Without it, Discord closes the Gateway (code 4014). |
| SSE | Server-Sent Events: a one-way server-to-browser stream over plain HTTP, read with `EventSource`. Served on `GET /events`. |
| Pub/Sub | Publish/subscribe (Observer pattern): publishers send messages without knowing who receives them; subscribers get every message published. |
| Hub | The in-memory core (`backend/hub.ts`): a buffer of messages per channel plus Pub/Sub. The bot publishes, each open browser stream subscribes. |
| Edge | Railway's public proxy. Cuts requests at 15 min and caps in-flight requests per domain. |
| SIGTERM | The signal Railway sends to stop the process. The server closes open streams and the Discord client, then exits. |


## High Level Design

### How it works
One Railway service, with one replica, runs three components in a single Bun process:

- **Discord ingestion**: connects to Discord as a read-only bot, loads recent history over Discord's REST API at startup, and receives new messages live over the gateway, Discord's real-time WebSocket
- **Hub**: keeps an in-memory buffer of messages per channel, sized by `BUFFER_SIZE`. Each open browser stream registers a callback; when a message arrives, the hub calls every callback for that channel
- **HTTP Server**: serves the web page, streams messages to browsers over SSE


![High-level design](docs/system-diagram.png)

### Components

| Component | What it does |
| --- | --- |
| Discord ingestion | Connects to the Gateway, loads recent history at startup, converts each Discord message to a plain object and publishes it to the hub. Replaces the client if the Gateway stays down for 5 minutes. |
| Hub | An in-memory buffer per channel. Its size is set by the `BUFFER_SIZE` env var (default 100, max 500); when it is full, the oldest message is dropped. Messages are sorted by ID and duplicates are dropped. Calls each subscriber's callback when a message arrives or is deleted. |
| HTTP server | Serves the page, the SSE streams, `/health` and `/config`. Allows at most 20 open browser connections per IP address; the 21st gets a 429 Too Many Requests with a `Retry-After` header. Drops clients that stop reading and closes streams on SIGTERM. |

### HTTP API

| Route | Returns |
| --- | --- |
| `GET /` | The React page, bundled by Bun. |
| `GET /events?channel=<id>&since=<id>` | An SSE stream: the Discord connection status, then the buffered messages (only those newer than `since`, if given), then live messages, deletes and a ping every 25 s. |
| `GET /config` | The feature flags and the list of channels with their names. |
| `GET /health` | 200 when the Gateway is connected, 503 otherwise. The body has `discord`, `clients`, `buffered`, `lastEventAt`, `unavailableChannels` and `uptimeSec`. |


## System

### How one message flows from Discord to a browser

![How one message flows from Discord to a browser](docs/message-flow.png)

1. **Discord to bot.** A user posts. Discord sends `messageCreate` over the Gateway WebSocket the bot holds open.
2. **Normalize.** The bot ignores channels not in `CHANNEL_ID` and converts the discord.js object to a plain object (`id`, `channelId`, `author`, `content`, `note`, `createdAt`, `editedAt`, `attachments`).
3. **Hub.** `publish(msg)` inserts it into that channel's buffer, drops it if the ID is already there, and evicts the oldest message past `BUFFER_SIZE`. Then it calls every subscriber callback for that channel.
4. **SSE write.** Each open `/events` stream is one subscriber. It writes `id: <snowflake>` and `data: <JSON>`. A stream more than 1 MiB behind is dropped, so one slow client cannot grow server memory.
5. **Edge to browser.** The bytes go through Railway's proxy to the browser's `EventSource`.
6. **Render.** The page drops duplicate IDs, keeps the newest 500 messages and renders content as text, so message content cannot inject HTML.


## Failure Modes

### Discord to bot (Gateway)

![Discord to bot hop](docs/failure-flow-0.png)

| Failure | User sees | Detection | Handling |
| --- | --- | --- | --- |
| Gateway drops (Discord restart, network blip) | Nothing, or a short gap | `shardDisconnect` / `shardReconnecting` | discord.js reconnects. A resume replays missed events; a fresh session reloads the buffer from REST |
| Gateway stays down while the process is alive | The page goes quiet, amber chip "Waiting for Discord" | `watchdog_expired` log every 5 min; `/health` returns 503 | The watchdog builds a fresh client every 5 min and keeps the buffer |
| MessageContent intent off | Empty page; the deploy never goes live | Gateway close 4014, `Used disallowed intents` | Exit 1. Fix it in the Discord developer portal |
| Token invalid or revoked | Empty page; the deploy never goes live | `discord_login_failed` at startup | Exit 1. After 10 restarts Railway marks the deployment `Crashed` and emails project members |
| Discord outage at startup, history rate-limited, or no channel permission | Empty or partial history, chip "Channel unavailable" | `history_failed`; `unavailableChannels` in `/health` | Retry each channel with backoff, up to every 5 min |
| Message deleted while the `edits-deletes` flag is off | It stays on the page | Compare the page with Discord | It ages out of the buffer, or turn the flag on |

### Bot to hub (in process)

![Bot to hub hop](docs/failure-flow-1.png)

| Failure | User sees | Detection | Handling |
| --- | --- | --- | --- |
| A message cannot be converted | That message is missing | `message_skipped` error log | Skip it and keep relaying |
| History overlaps live events and repeats a message | Nothing | None | Duplicate IDs are dropped in the hub and in the browser |
| The buffer grows without limit | A crash from running out of memory | None | Fixed-size buffer, at most 500 messages per channel |
| One subscriber throws | Nothing for the other browsers | `subscriber_failed` log | Each subscriber call is caught on its own |

### Hub to SSE stream to edge to browser

![Hub to browser hops](docs/failure-flow-2.png)

| Failure | User sees | Detection | Handling |
| --- | --- | --- | --- |
| The edge cuts the request at 15 min | A brief "Reconnecting…" | `EventSource` error | Reconnect after a random delay with `?since=` |
| The edge closes a stream idle for 5 min | Same | Same | `event: ping` every 25 s |
| The browser loses its network or the laptop sleeps | "Reconnecting…" | Error event, or 60 s of silence | Reconnect with backoff and `?since=`. Messages older than the buffer are skipped |
| A client stops reading or falls too far behind | That client reconnects | `client_dropped` warn log | Drop the stream once it has 1 MiB queued |
| One machine opens many streams | "Connection limit" on that machine | HTTP 429 in Railway's logs | 20 streams per IP. Many IPs (a botnet, an IPv6 range) get past it |
| More than 10,000 in-flight requests per edge node | New visitors cannot connect (502 `too many upstream connections for host`) | Railway HTTP logs | Nothing yet. Replicas do not raise this limit |
| Dead clients that never close | Nothing, but they hold server memory | `clients` in `/health` stays high | Freed when a write fails |
| Script injection in message content | Nothing | None | React renders text; `dangerouslySetInnerHTML` is never used |
| Malicious attachment URL | Nothing | None | Only Discord CDN hosts are rendered |
| Attachment URLs expire after about 24 h | Broken images in a long-open tab | None | A reload fetches fresh URLs |

### Process and Railway

| Failure | User sees | Detection | Handling |
| --- | --- | --- | --- |
| The process crashes | "Reconnecting…" for a few seconds | `unhandled_error` log | Restart on failure; history is fetched again at startup |
| An env var is missing or invalid | The deploy never goes live | `config_invalid` | Exit 1 with a log naming the variable |
| A deploy drops every client at once | Up to about 1 s of "Reconnecting…" | `clients` on `/health` | SIGTERM handler, 30 s of overlap and draining, reconnects with jitter |
| Two bots run during the deploy overlap | Nothing | None | Harmless, because the bot only reads |
| Healthchecks only run at deploy time | A broken but running app keeps serving | None | The Gateway watchdog |
| Railway drops logs above 500 lines/s | Missing logs | None | Per-client logs are `debug`, off by default |
| Railway Feature Flags are unreachable | Flagged features are off | `flags_unavailable` | Every flag falls back to off |


## Alternatives Considered

Both alternatives solve the same problem: running more than one web replica. In the current design, every extra replica would start its own bot with its own buffer.

### A. Bot service, Redis Pub/Sub and web replicas

![Alternative A: bot service, Redis Pub/Sub and web replicas](docs/alt-a-redis.png)

One bot publishes each message to Redis. Every web replica subscribes and fans messages out to its own SSE clients. The buffer for new visitors lives in Redis (a capped list or a Stream) or is rebuilt in each replica. `publish` and `subscribe` keep their signatures, so only `hub.ts` changes.

Why it isn't built yet:

- More replicas would not let more people in. Railway's edge caps a domain at 10,000 in-flight requests per edge node, counted across all replicas, and each SSE stream is a long-lived request. The public load test hit that cap at about 15,000 clients, while one replica held 16,300 clients at 10 msg/s over the private network.
- One replica covers the load we expect. It held 55,000 clients at 1 msg/s over the private network.
- Redis adds a service, a bill, a network hop and a new way to fail: if Redis is down, no messages get through. Pub/Sub also drops messages for a subscriber that is disconnected, so the replicas would need their own reconnect and replay logic.
- A crash already recovers in a few seconds, through restart on failure and a history refetch. At this size that is enough for the single point of failure.

Build it when a few seconds of downtime on a crash stops being acceptable, when one CPU core becomes the limit, or once WebSockets or a push service get past the edge cap.

### B. Postgres for storage, Redis for fan-out

![Alternative B: Postgres for storage, Redis for fan-out, web replicas](docs/alt-b-postgres-redis.png)

The bot writes every message to Postgres and publishes it to Redis. Web replicas read history and `?since=` replays from Postgres, and live messages from Redis.

Why it wasn't chosen:

- Discord already stores every message. A second copy brings sync problems (edits, deletes, events missed during downtime) and does nothing for someone watching live.
- Nothing in the product needs search or history beyond 500 messages yet.
- It costs the most of the three options and takes the most work to run: two stateful services, migrations and backups.
- SQLite on a Railway volume was ruled out separately, because volumes cannot be used with replicas.

Build it for search, history beyond 500 messages, many channels, or many replicas all calling Discord's REST API at startup.

### Other options

| Option | Why not |
| --- | --- |
| A bot in every replica, no Redis | It works because the bot only reads, but each replica keeps its own buffer and its own Gateway session |
| WebSockets instead of SSE | Two-way, which we don't need. They are exempt from the 15-minute cut, so they are worth another look for the edge cap |
| Polling | More lag and more requests |
| Next.js or a separate frontend service | A long-lived bot fits badly, and it means two deploys and CORS |
| A managed push service (Pusher, Ably) | The way past the edge cap, at the cost of a bill and a vendor |
