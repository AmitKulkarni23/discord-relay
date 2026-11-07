# DiscordRelay

A Discord bot that streams messages from one or more Discord channels into a web page in real time. 

Link: [discord-relay-production-262e.up.railway.app](https://discord-relay-production-262e.up.railway.app)


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


## Known Problems

Severity is judged for a public page with a live audience. High means users lose the feed or see wrong data, Medium means the service is degraded or cannot grow, and Low is cosmetic or only matters later.

The three that matter most: Railway's edge caps public viewers at about 10,000 to 15,000, and adding replicas does not raise that. There are no alerts, so users notice an outage first. And one replica is a single point of failure, so a crash means a few seconds of outage followed by a reconnect storm.

### Availability

| Problem | Impact | Today | Fix | Severity |
| --- | --- | --- | --- | --- |
| One replica is a single point of failure | A crash or deploy drops every viewer at once, for a few seconds | Restart on failure, history refetched, jittered reconnect | [Alternative A](#a-bot-service-redis-pubsub-and-web-replicas): a bot service, Redis and N web replicas | Medium |
| A deploy or crash causes a reconnect storm | Every client reconnects within seconds. This was never tested through the public edge | 30 s of overlap and draining; jitter up to 1 s, doubling to 30 s; `?since=` keeps replays small | Close streams at random times across the draining window, and load test a storm through the edge | Medium |
| Healthchecks only run at deploy time | A broken but running app keeps serving until someone notices | The Gateway watchdog fixes the one known stall | An external uptime check on `/health` | Medium |

### Scale and performance

| Problem | Impact | Today | Fix | Severity |
| --- | --- | --- | --- | --- |
| Railway's edge caps in-flight requests at 10,000 per domain per edge node | Past about 12,000 to 15,000 viewers, new visitors get 502 `too many upstream connections for host`, page loads included | Nothing. Replicas and plan upgrades do not raise it | WebSockets (exempt once established) or a managed push service such as Pusher or Ably | High at scale |
| One CPU core does all the fan-out | Capacity falls as the message rate rises: 16,300 viewers at 10 msg/s, 2,000 at 200 msg/s. At 4,000 viewers and 200 msg/s the event loop stalled for 33.6 s | Bun runs on one thread; the 1 MiB drop protects memory | Each message is already encoded once; batch writes next, then replicas, which spread fan-out across cores | Medium |
| Dead connections linger | Clients that vanish without closing, such as phones losing signal, stay subscribed for over 5 minutes and use memory and writes. One load test reached 75,896 subscribers, about 50,000 of them live | Freed when a write finally fails | Drop a stream that fails to drain for N seconds, or use a shorter TCP keepalive | Medium |
| Egress cost grows with rate × viewers | 10,000 viewers at 5 msg/s is about 24 MB/s of billed egress | `?since=` avoids resending the buffer on reconnect | Compress the stream, cap the per-channel rate, or move fan-out to a push service | Low until traffic is real |
| Images load at full resolution | A 25 MB photo costs every viewer 25 MB, even though it shows at 400 px | Behind the `attachments` flag | Load a resized variant from Discord's media proxy and link the original | Low |
| A tab open for days can slow down | The page gets heavier over time | The browser keeps at most 500 messages | None needed yet | Low |

### Correctness and data

| Problem | Impact | Today | Fix | Severity |
| --- | --- | --- | --- | --- |
| Edits are not relayed | An edited message keeps its old text, because the hub drops a re-published ID | Not built | An update path in the hub, behind the `edits-deletes` flag | Medium |
| Deletes only reach the page with the `edits-deletes` flag on | With it off, a message deleted in Discord stays on the public page until it ages out or the server restarts | The flag exists and is off by default | Turn the flag on once verified | Medium |
| A delete during a server restart is lost for open pages | A page already open keeps showing the message until reloaded; new visitors never see it | The list of recent deletes is in memory | Persist recent deletes, or have the page re-check the buffer after a reconnect | Low |
| Messages older than the buffer are skipped on reconnect | A browser offline for longer than the buffer covers has a silent gap | Buffer of up to 500 messages per channel | Show a "some messages skipped" marker, or load older history | Low |
| Attachment URLs expire after about 24 h | Broken images in a long-open tab | The page shows "no longer available"; a reload gets fresh URLs | Refresh URLs on the server with Discord's attachment-refresh endpoint | Low |
| Rich content is not captured | Link previews, embed images, stickers, custom emoji images, replies, threads, reactions, headings and lists show partly or as plain text | Shown as a note or as typed | Render them one at a time as needed | Low |

### Security and abuse

| Problem | Impact | Today | Fix | Severity |
| --- | --- | --- | --- | --- |
| The page is public | Anyone with the URL can read the channel | By design, for a public channel | Add auth, for example Discord OAuth and a role check, before relaying a private channel | High if the channel is private |
| No content moderation | Offensive content is relayed live | Discord AutoMod can block it at the source | A `filter()` before `hub.publish`, with a word list or a moderation API | Medium |
| The per-IP cap is blunt | 20 streams per IP blocks large offices or NATs that share one IP, while a botnet or an IPv6 range gets past it | 429 with `Retry-After` | Edge rate limiting or a CDN/WAF in front, plus a global cap on total streams | Low |

### Operability

| Problem | Impact | Today | Fix | Severity |
| --- | --- | --- | --- | --- |
| No metrics, dashboards or alerts | Users notice outages and slowdowns first | `/health`, structured logs and Railway's own metrics, read by hand | Metrics, dashboards and alarms in Grafana, with notifications to Discord | High |
| No staging environment | A bad deploy reaches production directly | CI must pass ("Wait for CI"); unit and integration tests run without Discord | A staging bot and channel, an end-to-end test through a Discord webhook, and promotion by branch | Medium |
| Feature flags live outside IaC | A dashboard change can drift from the repo, and flags depend on `RAILWAY_TOKEN` and Railway's API | `.railway/flags.sh` is the source of truth; every flag falls back to off | Move them into `railway.ts` once Railway IaC supports flags | Low |
| Railway drops logs above 500 lines/s | Logs can be lost during a reconnect storm | Per-client logs are `debug`, off by default | Ship logs to a proper sink, and count with metrics instead of logs | Low |


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
| A managed push service (Pusher, Ably) | The way past the edge cap, at the cost of a bill and a vendor |


## Load Testing

The question was how many viewers one server can hold for one busy channel. Every message is written once per open stream, so the server's work is rate × viewers. Discord rate-limits posting, which keeps inbound volume low, so fan-out to viewers is the axis to test.

![Load test setup](docs/load-test-setup.png)

- **Harness:** `load-tests/` in this repo. `run.ts` ramps consumer counts, `max.ts` narrows down to the limit and repeats it, `verdict.ts` judges each step, `agent.ts` coordinates several consumer machines and `railway-metrics.ts` adds Railway's CPU and memory figures.
- **Setup:** the real `discord-relay` service, in a temporary build with one extra private port for the generator and stats. The consumers and the generator ran on Railway over the private network. The app was restarted, with a 2-minute wait, before each test.
- **Fixed settings:** one channel, 456-byte messages, `BUFFER_SIZE` 100 and a 60 s hold per step.
- **Verdicts:** PASS means every message reached every consumer, none were dropped, p99 was at most 1 s and the slowest delivery at most 5 s. SLOW means nothing was lost but p99 or the slowest delivery was over those limits. BROKEN means a message was lost or a consumer was dropped or refused. INVALID means the test rig itself was saturated, so the step needs re-running with more capacity.
- **Usable Max** is the highest count that passes 3 runs out of 3. **Hard Max** is the highest count before BROKEN.
- A separate run went through the public URL to find the limit of Railway's edge.

The numbers are in [Appendix G: Load test results](#g-load-test-results).


## Observability

Railway's Hobby plan has no custom metrics, dashboards or alerts, so the app sends its own numbers to Grafana Cloud's free tier. Every 60 seconds it pushes one line of metrics over HTTPS. Nothing new is served or shown on the page, and a failed push is logged and does not affect the relay. CPU and memory stay in Railway's own metrics.

### Metrics

| Metric | What it counts |
| --- | --- |
| `relay_gateway_connected` | 1 while the bot is connected to Discord, 0 otherwise |
| `relay_sse_clients` | Open browser streams |
| `relay_messages_total` | Messages relayed |
| `relay_clients_dropped_total` | Clients dropped for falling 1 MiB behind |
| `relay_rejected_total` | Streams refused with 429 by the per-IP cap |
| `relay_watchdog_restarts_total` | Fresh Discord clients started after a long Gateway outage |
| `relay_http_errors_total` | 500s from a route that threw |

Each line carries a `deployment` tag, so the old and new process keep separate totals while they overlap during a deploy.

### Dashboard

One Grafana dashboard with a panel per metric: Gateway status, viewers, messages per second, 500s, clients dropped, 429s and watchdog restarts.

![Grafana dashboard](docs/grafana-dashboard.png)

### Alarms

Alarms post to a private Discord channel.

| Alarm | Fires when |
| --- | --- |
| App down | No metrics arrive for 3 minutes |
| Discord Gateway down | The bot stays disconnected for 2 minutes |
| HTTP 500 errors | Any 500 in 5 minutes |
| Near the edge cap | More than 8,000 open streams for 5 minutes |
| Drop spike | More than 1% of clients dropped in 5 minutes |

The dashboard and alarms are code in `.grafana/apply.ts`. Running it again updates them in place.


## Appendix

### A. Message shape

```json
{
  "id": "1566588496691400001",
  "channelId": "1566584977829900002",
  "author": { "id": "961675715634400003", "name": "relay_tester", "avatarUrl": "https://cdn.discordapp.com/embed/avatars/0.png", "bot": false },
  "content": "Hello from Relay Channel",
  "note": null,
  "createdAt": "2026-11-01T23:03:23.418Z",
  "editedAt": null,
  "attachments": []
}
```

### B. SSE wire format

```txt
: connected

event: discord
data: connected

id: 1301234567890123456
data: {"id":"1301234567890123456","channelId":"…","content":"hello",…}

event: delete
data: {"id":"1301234567890123456","channelId":"…"}

event: ping
data: 1
```

### C. Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | yes | Bot token, as a sealed Railway variable |
| `CHANNEL_ID` | yes | One or more channel IDs, comma-separated |
| `BUFFER_SIZE` | no (100) | Messages kept per channel, 1 to 500 |
| `LOG_LEVEL` | no | `debug` logs every client connect and disconnect |
| `RAILWAY_TOKEN` | no | Reads the feature flags; without it every flag is off |
| `PORT` | injected | Set by Railway |

### D. Limits

| Limit | Value |
| --- | --- |
| Server buffer per channel | `BUFFER_SIZE`, default 100, max 500 |
| Browser message cap | 500 |
| Open streams per IP | 20, then 429 |
| Queued bytes per stream | 1 MiB, then dropped |
| Reconnect delay | Random, up to 1 s, doubling to 30 s |
| SSE heartbeat | 25 s |
| Gateway watchdog | Every 5 min while disconnected |

### E. Decision log

| Decision | Main reason |
| --- | --- |
| SSE to the browser | One-way data, plain HTTP, built-in reconnect |
| Bun | Server, bundler and tests built in |
| One service for backend and frontend | One deploy, one domain, no CORS |
| React + MUI | A fast, accessible UI that escapes text |
| No database | Discord already stores everything |
| One replica | Extra replicas mean extra bots and buffers |
| Reconnect with `?since=` | Avoids resending about 58 KB per client every 15 min |
| Railway Feature Flags | Changes without a redeploy |
| Railway IaC | `railway.json` is deprecated |
| No staging | Tests cover the logic, and the team is small |
| Gateway watchdog | Healthchecks only run at deploy time |
| No moderation filter | Discord AutoMod comes first |
| Extensibility through `channelId` | Redis can replace the hub behind the same two functions |

### F. Repo references

- `docs/system-specs/architecture.md`, `decisions.md`, `failure-modes.md`, `message-shape.md`
- `docs/load_test_plan.md`, `docs/load_test_results.md`, `docs/load_test_results_Nov_04.md`
- `load-tests/` (harness), `.railway/railway.ts` (IaC), `.railway/flags.sh` (flags)

### G. Load test results

**Summary (Nov 4, private network)**

| Rate | Usable Max | First SLOW | Hard Max |
| --- | --- | --- | --- |
| 1 msg/s | ≥ 55,000 (top of the test, 1 run) | Not reached | Not reached |
| 10 msg/s | **16,300** (3 of 3 repeats) | 17,500 | Not reached by 20,000 |
| 50 msg/s | ≥ 5,000 (1 run) | 7,500 | Not reached by 7,500 |
| 200 msg/s | 2,000 (2 of 2 runs) | 2,500 | **Between 3,000 and 4,000** |

**10 msg/s, narrowing the Usable Max**

| Consumers | Result | Delivered | p50 | p99 | Slowest | CPU (one core) | Memory |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 10,000 | PASS | 100% | 221 ms | 327 ms | 427 ms | 92% | 617 MB |
| 15,000 | PASS | 100% | 365 ms | 585 ms | 794 ms | 92% | 888 MB |
| 16,300 (×4) | PASS | 100% | 595–644 ms | 894–948 ms | 1,064–1,161 ms | 92% | about 990 MB |
| 17,500 | SLOW | 100% | 722 ms | 1,094 ms | 1,396 ms | 92% | 1,082 MB |
| 20,000 | SLOW | 100% | 840 ms | 1,315 ms | 1,575 ms | 92% | 1,188 MB |

**50 msg/s**

| Consumers | Result | p50 | p99 | Slowest | CPU | Memory |
| --- | --- | --- | --- | --- | --- | --- |
| 1,000 | PASS | 8 ms | 20 ms | 211 ms | 49% | 117 MB |
| 2,500 | PASS | 48 ms | 78 ms | 263 ms | 92% | 202 MB |
| 5,000 | PASS | 185 ms | 307 ms | 388 ms | 95% | 347 MB |
| 7,500 | SLOW | 1,141 ms | 1,613 ms | 1,812 ms | 95% | 509 MB |

**200 msg/s**

| Consumers | Result | p50 | p99 | Slowest | CPU | Memory |
| --- | --- | --- | --- | --- | --- | --- |
| 500 | PASS | 7 ms | 19 ms | 128 ms | 78% | 73 MB |
| 1,000 | PASS | 22 ms | 44 ms | 109 ms | 91% | 108 MB |
| 2,000 | PASS | 548–577 ms | 766–840 ms | 864–986 ms | 93% | 167–185 MB |
| 2,500 | SLOW | 825 ms | 1,134 ms | 1,640 ms | 92% | 211 MB |
| 3,000 | SLOW | 875 ms | 1,226 ms | 1,484 ms | 90% | 242 MB |
| 4,000 | **BROKEN** | n/a | n/a | n/a | 96% | 1,384 MB |

At 4,000 consumers the event loop stalled for up to 33.6 s, and the app dropped about 2,370 consumers for falling 1 MiB behind, which is the safety limit doing its job. The app did not crash and the bot stayed connected.

**1 msg/s**

| Consumers | Result | p50 | p99 | Slowest | CPU | Memory |
| --- | --- | --- | --- | --- | --- | --- |
| 10,000 | PASS | 67 ms | 123 ms | 138 ms | 11% | 629 MB |
| 30,000 | PASS | 194 ms | 367 ms | 423 ms | 34% | 1,743 MB |
| 55,000 | PASS | 369 ms | 789 ms | 975 ms | 61% | 3,122 MB |

**Public URL, through Railway's edge (Nov 3, 5 msg/s, live bot)**

| Clients | Delivered | p50 | p99 | Slowest | Memory | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 5,001 | 100% | 53 ms | 87 ms | 0.9 s | 419 MB | Pass |
| 10,002 | 100% | 88 ms | 160 ms | 0.7 s | 677 MB | Pass |
| 12,000 | 100% | 101 ms | 348 ms | 0.8 s | 811 MB | Pass |
| 15,000 | 100% | 121 ms | 420 ms | 5.9 s | 872 MB | Pass in one clean run |
| 15,000 (earlier run) | n/a | n/a | n/a | n/a | n/a | Fail: 5,500 attempts got 502 `too many upstream connections for host` from the edge |

**What the numbers say**

- Below the Hard Max nothing was lost. Under load, delivery got slower but stayed complete.
- One CPU core is the bottleneck. Bun runs this on one thread, and CPU sat at about 92% of one core near every limit while Railway showed at most 1.2 of 8 vCPU in use.
- Memory is not the limit: about 60 KB per consumer, or 3.1 GB at 55,000.
- The edge caps public reach at roughly 12,000 to 15,000 connections, well below what the server can hold, and adding replicas would not raise it.
- The tests did not cover long holds (steps were 60 s), real browsers, larger messages or the bot handling real traffic.
