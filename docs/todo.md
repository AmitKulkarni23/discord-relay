# To do

Open questions and planned work. Each item says where the code stands today, what the change involves, and what to watch for. Turn an item into a task spec in `docs/task-specs/` before building it.

## 1. Images, video and other non-text messages

**Today.** The bot already captures attachments: every `Msg` carries `attachments[]` with `url`, `name` and `contentType` (see `docs/system-specs/message-shape.md`). The page does not render them. A message with only an attachment shows a grey "Attachment" note, and its text, if any, shows as usual. The `FEATURE_ATTACHMENTS` flag exists but nothing reads it yet.

What a Discord message can carry, and whether we capture it:

| Content | Captured? | Notes |
|---|---|---|
| Images, video, audio, other files | Yes, as `attachments[]` | URLs are signed and expire after about 24 hours. |
| Embeds (link previews, bot cards) | No | `message.embeds`; link previews also arrive late, as an edit. |
| Stickers | No | `message.stickers`; some are Lottie JSON, not images. |
| Custom emoji, user/channel mentions | Raw text only | `<:name:id>`, `<@id>`, `<#id>` pass through unchanged. |
| Replies, threads, polls, reactions | No | Each is its own feature. |

**Plan (behind `FEATURE_ATTACHMENTS`).**

- Images inline, `loading="lazy"`, sized from the attachment's width and height so the feed does not jump when they load (add `width`/`height` to `Attachment` in `toMsg`).
- Video with controls, never autoplay. Audio with controls. Anything else as a file link with name and size.
- Only load URLs on `cdn.discordapp.com` or `media.discordapp.net`. `isDiscordCdn` in `frontend/feed.ts` already does this check.
- Load the attachment component only when the flag is on (`react.rules.md`).

**Watch for.**

- Expired URLs: a buffered message older than a day has dead links. Either show a "no longer available" state on image error, or refresh URLs server-side (Discord has an attachment-refresh endpoint).
- Spoilers (`SPOILER_` filename prefix) should stay hidden until clicked.
- Large files: never proxy them through our server; the browser loads them straight from Discord's CDN.

## 2. Ring buffer size as a Railway variable

**Today.** The server buffer is fixed at 100 messages per channel (`createHub(capacity = 100)` in `backend/hub.ts`). The startup history fetch is also 100, which is the most Discord returns in one request. The browser holds up to 500.

**Change.** Add `BUFFER_SIZE`, read and validated once in `loadConfig`, passed to `createHub`, and set in `.railway/railway.ts`. Small diff, test first.

**Watch for.**

- Above 100, the history fetch needs pagination (`before: <oldest id>` in a loop), or the buffer only fills up over time.
- `hub.ts` evicts with `shift()`, which is O(n) (its `ponytail:` comment). Fine to about 1,000; past that use a circular array.
- Every reconnect resends the full buffer, so a bigger buffer means a bigger burst per browser on every redeploy.
- Keep it at or below the browser cap of 500, or the browser drops what the server just sent.
- Changing a Railway variable redeploys the service, which empties the buffer and refills it from history.

Suggested bounds: 1 to 500, default 100.

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

Do not load test production: it costs egress, and real reviewers share the one replica. Use a separate Railway environment (or local) with a fake source.

- A small Bun script that opens N `/events` streams (`fetch` with a reader per stream) and records, for each message, the time from publish to receipt on every stream. Report p50/p99 latency and how many streams dropped.
- A fake source that calls `hub.publish` at a fixed rate instead of Discord. The integration tests already do this, so the pattern exists.
- Ramp N: 100, 1,000, 5,000, 10,000. Watch memory, CPU and `/health` `clients` on Railway's metrics tab.

### What Railway can and cannot do here

- **Connections:** Railway's proxy caps a service at about 10,000 concurrent connections, and cuts any request at 15 minutes (`EventSource` reconnects, and the browser dedupes by ID). See `interview_talking_points.md` for the memory and bandwidth math.
- **Vertical scaling:** Railway grows CPU and memory up to the plan's limit with no config. That covers the 10k-connection range.
- **Horizontal scaling:** adding replicas does not work as-is, because every replica would start its own bot with its own buffer (decision D6). Past one replica, split the design: one bot service publishes to Redis or NATS, and N fan-out replicas subscribe and serve SSE. Or buy fan-out from a push service.

## 4. Multiple channels

**Today.** One `CHANNEL_ID`. The hub is already keyed by `channelId` (buffers and subscribers), so most of the plumbing exists.

**What changes in code.**

- **Config:** `CHANNEL_IDS` as a comma-separated list (keep accepting `CHANNEL_ID` for one release), validated in `loadConfig`.
- **Bot (`discord.ts`):** filter `messageCreate` against a `Set` of IDs, fetch history for each channel at startup, and keep a map of channel ID → name.
- **`/events?channel=<id>`:** the query param is untrusted input, so allow only IDs in the configured set; return 404 for others. Default to the first channel.
- **`/config`:** return `channels: [{ id, name }]` instead of one `channelName`.
- **Frontend:** a channel switcher (tabs, or a list on wide screens), one message map per channel, and the `EventSource` effect keyed on the selected channel so switching closes one stream and opens the next. Put the channel in the URL (`?channel=`) so a link opens the right one.
- **Tests:** config parsing, the allowlist on `/events`, and history per channel.

**Does it need another deployment?** No new service. One bot connection can listen to any number of channels, in any server the bot has joined. Adding a channel means adding its ID to the Railway variable, which redeploys the same service. A second service would be wrong: two bots, two Gateway connections and two buffers for the same data.

**In Discord:** the bot needs View Channel and Read Message History on the new channel. If the channel is in another server, invite the bot there first.

**Watch for:** memory grows with channels × buffer size, and each open tab still holds one SSE connection (switching channels does not add connections if the old one closes first).
