# To do

Open questions and planned work. Each item says where the code stands today, what the change involves, and what to watch for. Turn an item into a task spec in `docs/task-specs/` before building it.

## 1. Attachment follow-ups

Attachments render behind the `attachments` flag (TASK-009). What is left:

- **Thumbnails for images.** Images load at full resolution, so a 25 MB photo costs every viewer 25 MB even though it shows at 400 px. Load a resized variant from Discord's media proxy (`media.discordapp.net` with a width parameter) and link to the original. Check the URL format against a real attachment first.
- **Size on video and audio.** Show "Video · 480 MB" before play, as file cards already do.
- **Expired links.** Discord's attachment URLs expire after about 24 hours. The page shows "no longer available" when one fails; refreshing URLs server-side (Discord has an attachment-refresh endpoint) would keep old media working.
- **Not captured yet:** link previews and embed images (an embed-only message shows only its title and description), sticker images and poll answers (shown as a note), custom emoji images (shown as `:name:`), headings, quotes, lists and masked links (shown as typed), replies, threads and reactions.

## 2. Edits

The `edits-deletes` flag exists in Railway (see `.railway/flags.sh`) and so far controls deletes only.

- **Edits:** listen for Discord's update event, replace the buffered message, and send the edit under the same ID. The page already replaces a message whose `editedAt` changed. Deletes are built, behind the same flag. An edit made while a browser is away must also get past `?since=`.

## 3. Load testing and scale

Two different loads matter:

1. **Inbound messages** (Discord → server). Discord rate-limits posting, per webhook and per channel, so one channel cannot produce much volume. This is not where the system breaks.
2. **Fan-out** (server → browsers). Every open tab holds one SSE connection, and every message is written once per connection. This is the real scale axis.

### Posting test messages with a webhook

In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL. The URL is a secret (anyone with it can post), so keep it in an env var, not in the repo.

```bash
export WEBHOOK='https://discord.com/api/webhooks/...'
for i in $(seq 1 20); do
  curl -s -H 'Content-Type: application/json' \
    -d "{\"content\": \"load test message $i\", \"username\": \"tester-$((i % 3))\"}" "$WEBHOOK"
  sleep 1   # Discord allows roughly 5 requests per 2 seconds per webhook
done
```

`username` lets one webhook pose as several authors, which exercises grouping. Webhook messages arrive with `author.bot = true`, so they show the BOT badge.

This tests the real path end to end (Discord → bot → hub → SSE → browser), but only at a few messages per second.

### Testing fan-out

Built: `load-tests/`, with results in `docs/load_test_results.md`. Still open:

- Find out why a few connections stalled for up to 46 s in the one-machine private runs. The later five-machine runs did not show this at up to 57,500 clients, so one consumer's network path is a suspect, not confirmed.
- Find out why p99 was higher at 1 msg/s than at 5 msg/s for the same client count over the private network.
- Decide whether to detect dead connections sooner. Streams from clients that vanished stayed counted for more than 5 minutes, using memory and writes (`docs/load_test_results.md`).
- Find out why the Bun consumer program saw repeated messages at 50 msg/s on a saturated local server.
- Run a long soak to look for leaks, since steps are only held for 45 s.

### What Railway can and cannot do here

- **Connections:** Railway's edge caps a domain at 10,000 in-flight requests on each edge node, whatever the replica count or plan, and cuts any request at 15 minutes (`EventSource` reconnects, and the browser dedupes by ID). See `interview_talking_points.md` for the memory and bandwidth math.
- **Vertical scaling:** Railway grows CPU and memory up to the plan's limit with no config. That covers the 10k-connection range.
- **Horizontal scaling:** adding replicas does not work as-is, because every replica would start its own bot with its own buffer (decision D6). Past one replica, split the design: one bot service publishes to Redis or NATS, and N fan-out replicas subscribe and serve SSE. Or buy fan-out from a push service.

## 4. Operational excellence: dashboard metrics and alarms

**Today.** Logs are structured JSON with a `level` field (`log.debug|info|warn|error` in `backend/platform/log.ts`), so Railway's log search can filter `@level:error` or `@event:gateway_disconnected`. There is no dashboard, no alarm, and no metric beyond what Railway collects on its own.

**Plan.** Send metrics to Grafana, build the dashboards and alarms there, and deliver alarm notifications to Discord. The README's Observability section stays empty until this is built.

### What Railway provides

- **Built-in metrics:** CPU, memory, disk and network per service, kept 30 days. Railway collects no application metrics (request latency, error rates).
- **HTTP logs:** every request at the edge, with `@httpStatus`, `@path`, `@totalDuration`, `@responseTime`, `@txBytes` and more. Filters support ranges: `@httpStatus:500..599`, `@totalDuration:>5000`.
- **Dashboard widgets:** built from CPU, memory, network, disk, or a filtered log query. The docs only describe counting matching log lines, not plotting a number inside a line.
- **Monitors (alarms):** Pro plan only, thresholds on CPU, RAM, disk and network egress, delivered by email and in-app. No documented log-based alarms.
- **Webhooks:** per project, for deploy status changes, volume alerts and monitor alerts. Slack and Discord URLs work directly.
- **Custom metrics:** no Prometheus or StatsD ingestion. Application metrics go out over OpenTelemetry to a vendor (Grafana Cloud, Datadog, Honeycomb).

### Dashboard widgets

| Widget | Source | Query or metric |
|---|---|---|
| 5xx responses | HTTP logs | `@httpStatus:500..599` |
| 4xx responses | HTTP logs | `@httpStatus:400..499` |
| Slow requests | HTTP logs | `@totalDuration:>2000 -@path:/events` (SSE streams stay open for up to 15 min, so `/events` must be excluded from latency) |
| Errors | App logs | `@level:error` |
| Gateway drops | App logs | `@event:gateway_disconnected OR @event:gateway_reconnecting` |
| Missing content | App logs | `@event:message_content_missing` (MessageContent intent off) |
| CPU, memory, network out | Built-in | Service metrics |
| Clients connected | App logs | `@event:stats`, read the latest `clients` value (needs the stats line below) |

### Alarms

| Alarm | How | Notes |
|---|---|---|
| Deploy failed or crashed | Project webhook → Slack or Discord | Covers bad token, missing env var, watchdog restarts looping. |
| Memory high | Monitor on RAM | Pro plan. A rising line with flat traffic points to a leak. |
| CPU high | Monitor on CPU | Pro plan. |
| Network egress high | Monitor on egress | Pro plan. Fan-out cost grows with clients × messages. |
| Discord disconnected, 5xx spike | Not possible natively | Railway has no log-based alarms. Options: an external uptime check on `/health` (returns 503 when the Gateway is down), or OpenTelemetry to a vendor with alerting. |

### Code changes

1. **`stats` line every 60 s:** `log.info('stats', { clients, buffered, discord, lastEventAgeSec })`. Gives a current client count in the logs and a heartbeat to watch. About 10 lines plus a test with fake timers.
2. **Page-load metrics:** the browser measures LCP, INP, CLS and TTFB with `web-vitals` (about 2 KB, new dependency), plus time to first message and reconnects per session, and sends them with `navigator.sendBeacon` to `POST /vitals`, which logs `client_vitals`. That endpoint is public input: accept only known numeric fields, cap the body size and rate-limit it.
3. **Later, only if needed:** OpenTelemetry export to Grafana Cloud for real time-series graphs, percentiles and log-based alerts. A vendor account and a new moving part; describe it in the README as the scale-up path rather than build it for the take-home.

### Can this be managed as code?

Mostly no. Checked against Railway's docs:

- `.railway/railway.ts` IaC covers services, databases, volumes, buckets, domains, variables, replicas and groups. Not dashboards, widgets, monitors or webhooks.
- Feature flags are not in IaC either; `.railway/flags.sh` holds their `railway flag set` commands.
- Dashboards, widgets and monitors are created in the UI only. The `observabilityDashboardCreate`/`Update` operations exist in Railway's internal API but are undocumented, so building on them is unsupported.
- Webhooks are the exception: the docs name the public API's `notificationRuleCreate` / `notificationRuleUpdate` and the Railway MCP server's `create-webhook` / `update-webhook` / `test-webhook` tools. The input schema is not documented.

So: create the dashboard and monitors in the UI once, and record every widget query and monitor threshold in `docs/system-specs/` (this section is the draft) so they can be rebuilt. This is the one ClickOps exception, forced by Railway. Revisit when the IaC SDK adds observability resources.

## 5. CodeQL code scanning

Not added: discord-relay is a private repo, and GitHub runs CodeQL on private repos only with a paid GitHub Code Security license (CodeQL's license allows free use on open-source code). Add `.github/workflows/codeql.yml` (language `javascript-typescript`, on push and pull request) when the repo goes public or gets Code Security. Until then, the report-only `bun audit` in CI covers part of it.

## UI changes
- Add a little bit of wow to the UI. It is plain and bland for now
- Should we add a debug panel to show the number of messages flowing in and the number of connections to the application?
- Message grouping: decide whether to keep it. The feed is always in time order; a message drops its avatar and name only when the message directly before it has the same author and is within 5 minutes (`buildRows` in `frontend/lib/messages.ts`). Discord and Slack group the same way, from memory and not checked against their docs: Discord's window is about 7 minutes, and Slack keeps thread replies out of the main timeline. Recommendation: keep it. A header on every message is a one-line change plus test updates.


## Demo changes
- Have a script ready for the interview where you can submit multiple messages to Discord and see that in action. This would mean that you invoke Discord's webhook and post messages to it

