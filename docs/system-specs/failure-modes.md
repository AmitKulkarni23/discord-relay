# Failure modes

Each row lists what can break, what a user would report, how we notice, and what handles it. Mitigated means the code or config handles it. Accepted means it is a known limit that the README explains.

## Browser to server (SSE)

| # | Failure | User sees | Detection | Handling | Status |
|---|---|---|---|---|---|
| 1 | Railway proxy ends the request at 15 min | A brief "Reconnecting…" | `EventSource` `error` event | The page reconnects after a random delay with `?since=`, and the server sends only newer messages | Mitigated |
| 2 | Proxy closes a stream with no data for 5 min | Same as 1 | Same as 1 | `event: ping` every 25 s | Mitigated |
| 3 | Browser loses its network | "Reconnecting…" until it is back | `EventSource` `error` event | Reconnect with backoff and `?since=`. Messages older than the buffer are skipped | Mitigated |
| 3b | A stream dies with no error event, after laptop sleep or a network change | Nothing for up to 60 s, then "Reconnecting…" | The page hears nothing for 60 s; the server pings every 25 s | The page closes the stream and reconnects with `?since=` | Mitigated |
| 4a | A write to a stream that already closed | Nothing | Write throws before `abort` fires | The write is caught and treated as a disconnect, so a dead tab cannot crash the server | Mitigated |
| 4 | A client stops reading, or falls too far behind | That client reconnects and gets what it missed | `client_dropped` log line (`@event:client_dropped`) | Each stream counts queued bytes. Past 1 MiB on a live write, the stream errors, its queue is freed and the socket is closed | Mitigated |
| 4b | One machine opens many streams to exhaust memory | Past the cap, that machine's page shows "Connection limit" | `@httpStatus:429` in Railway's HTTP logs | 20 open streams per IP, then 429. Shared networks share the cap, and many IPs (a botnet, an IPv6 range) get past it | Mitigated for one IP. Many IPs accepted |
| 5 | A tab stays open for days | The page slows down | None | The browser keeps at most 500 messages | Mitigated |
| 6 | More than 10,000 in-flight requests on the domain at one edge node | New visitors cannot connect | Railway limit | Nothing yet | Accepted. Railway counts per domain, per edge node, across all replicas and client IPs, and neither replicas nor a plan upgrade raise it. Past that, use a push service, or WebSockets, whose established connections give their slot back. In the load test the edge answered `too many upstream connections for host` while trying 15,000 clients, on page loads and `/health` too, after 12,000 had passed. The server itself held 57,500 over the private network |

## Discord to server (Gateway)

| # | Failure | User sees | Detection | Handling | Status |
|---|---|---|---|---|---|
| 7 | Gateway drops because Discord restarts or the network blips | Nothing, or a short gap | `shardDisconnect` and `shardReconnecting` events | discord.js reconnects. A resume replays what was missed; a fresh session reloads the latest `BUFFER_SIZE` messages per channel | Mitigated |
| 8 | Gateway stays down while the process is alive | The page goes quiet and its chip turns amber, "Waiting for Discord" | `watchdog_expired` every 5 min; `/health` returns 503 | The bot reconnects with a fresh client every 5 min, keeping the buffer | Mitigated |
| 9 | MessageContent intent is not enabled in the Discord developer portal | "Relay is down" page saying the maintainer was notified; a new deploy fails its healthcheck and never goes live | The bot requests the intent, so Discord closes the Gateway with 4014 and discord.js reports `Used disallowed intents`; the Grafana "Discord Gateway down" alarm | The server stays up and the watchdog retries every 5 min, so fixing it in the portal recovers with no redeploy. `message_content_missing` logs once per process and only suggests the intent: sticker-only and embed-only messages trigger it too | Detected |
| 9b | A message is deleted in Discord with the `edits-deletes` flag off | It stays on the public page | Compare the page with Discord | It leaves when it ages out of the buffer or the server restarts. Turn the flag on to remove deletions live | Accepted until the flag is on |
| 9c | With the flag on, a message is deleted while the server is restarting | The page already open keeps showing it until reloaded | None | A new visitor never sees it, because the restarted server reloads from Discord. An open page keeps it, because the list of recent deletions is in memory and did not survive the restart | Accepted |
| 10 | Token is invalid or revoked | "Relay is down" page saying the maintainer was notified; a new deploy fails its healthcheck and never goes live | `discord_login_failed`; the Grafana "Discord Gateway down" alarm | The server stays up instead of crash-looping and tells open pages (`event: discord`, `data: failed`). Fix `DISCORD_TOKEN` and redeploy | Detected |
| 11 | Discord outage at startup, a rate limit on the history fetch, or a bot that cannot read the channel | Empty or partial history, chip "Channel unavailable" | `history_failed` in the logs; `unavailableChannels` in `/health` | Retries each channel with backoff, up to every 5 min, until it loads. A login failing on the network retries too | Mitigated |
| 12 | Attachment URLs expire after about 24 h | Broken images in a long-open tab | None | Restarts and page reloads get fresh URLs | Accepted |

## Process and Railway

| # | Failure | User sees | Detection | Handling | Status |
|---|---|---|---|---|---|
| 13 | Process crashes | "Reconnecting…" for a few seconds | An `unhandled_error` log line (`@level:error`) for any uncaught exception or rejection | Restart policy (on failure), and history is fetched again at startup | Mitigated |
| 14 | An env var is missing | The deploy never goes live | Startup validation | Exit 1 with a log naming the variable | Mitigated |
| 15 | A deploy or crash drops every client at the same moment | "Reconnecting…" for up to a second on a deploy, longer on a crash | `clients` on `/health` | SIGTERM handler, 30 s of overlap and draining, and a start command of `bun run` so reconnects land on a ready server after a deploy. Browsers reconnect with backoff and jitter and fetch only newer messages. No cap on total connections beyond Railway's 10,000. 10,000 clients connecting at once were load tested over the private network and recovered in about 7 s with a full replay; Railway's public edge was not tested | Reduced |
| 16 | Two bots run during the deploy overlap | Nothing | None | Harmless because the bot only reads. It would post duplicate replies if it ever wrote | Accepted |
| 17 | A restart empties the in-memory buffer | An empty page for a moment | None | Fetch the latest `BUFFER_SIZE` messages at startup | Mitigated |
| 18 | The buffer grows without limit | A crash from running out of memory | None | Fixed-size buffer of `BUFFER_SIZE` messages, at most 500 | Mitigated |
| 19 | App sleeping is turned on | An empty page after idle time | None | Sleeping is off | Mitigated in config |
| 20 | Healthchecks only run at deploy time | A broken but running app keeps serving | None | The watchdog from row 8 | Mitigated |
| 21 | More than one replica | Duplicate bots, each replica with its own buffer | None | Run 1 replica. Option A is a bot per replica; option B is a bot service with Redis and web replicas | Accepted |
| 22 | Railway drops logs above 500 lines/s per replica | Missing logs | None | Log events such as connects and disconnects, not every message | Mitigated |

## Data and security

| # | Failure | User sees | Detection | Handling | Status |
|---|---|---|---|---|---|
| 23 | Duplicate messages from history overlapping live events, or from reconnects | Nothing | None | Dedupe by message ID in the hub and in the browser | Mitigated |
| 24 | Script injection through message content | Nothing | None | React renders content as text, and `dangerouslySetInnerHTML` is never used | Mitigated |
| 25 | A malicious attachment URL | Nothing | None | Only `cdn.discordapp.com` and `media.discordapp.net` URLs are rendered | Mitigated |
| 26 | Token leak | Nothing | None | The token stays on the server as a sealed variable and is never logged | Mitigated |
| 27 | Anyone with the URL can read the channel | Nothing | None | None | Accepted. Add auth if the channel is private |
| 28 | Offensive content appears | The content itself | None | None | Accepted. Discord AutoMod, or a `filter()` before publish if needed |

## Runbook: "messages stopped showing up"

1. Check the Railway deployment status. If it says `Crashed`, read the last logs for a missing env var. If the page says "Relay is down", look for `discord_login_failed`: a bad token or a disallowed intent.
2. Open `/health`. A 503 means the Gateway is down; look in the logs for `gateway_disconnected` and whether the watchdog fired.
3. In the same `/health` response, check `clients`, `lastEventAt` and `unavailableChannels`.
4. If the logs show `Used disallowed intents`, the MessageContent intent is off in the Discord developer portal.
5. Compare `CHANNEL_ID` with the channel's ID (Discord developer mode, then Copy Channel ID).
6. Confirm the bot has View Channel and Read Message History in that channel.
7. If only some users are affected, look at their side: network, browser extensions, or a tab that has been open for days. Filter on `@event:client_dropped` around the time they report. Each `client_*` line has a `requestId` that matches Railway's network logs.
