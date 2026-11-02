# Failure modes

Each row lists what can break, what a user would report, how we notice, and what handles it. Mitigated means the code or config handles it. Accepted means it is a known limit that the README explains.

## Browser to server (SSE)

| # | Failure | User sees | Detection | Handling | Status |
|---|---|---|---|---|---|
| 1 | Railway proxy ends the request at 15 min | A brief "Reconnecting…" | `EventSource` `error` event | `EventSource` reconnects on its own, the server resends the buffer, and the browser dedupes by ID | Mitigated |
| 2 | Proxy closes a stream with no data for 5 min | Same as 1 | Same as 1 | `: ping` every 25 s | Mitigated |
| 3 | Browser loses its network | "Reconnecting…" until it is back | `EventSource` `error` event | Reconnect and full buffer. Messages older than the buffer are skipped | Mitigated |
| 4a | A write to a stream that already closed | Nothing | Write throws before `abort` fires | The write is caught and treated as a disconnect, so a dead tab cannot crash the server | Mitigated |
| 4 | A slow client cannot keep up | That client lags | Server memory grows | Nothing yet | Accepted. At scale, drop clients whose write queue grows too large |
| 5 | A tab stays open for days | The page slows down | None | The browser keeps at most 500 messages | Mitigated |
| 6 | More than 10,000 open connections | New visitors cannot connect | Railway limit | Nothing yet | Accepted. Confirm with Railway whether the limit is per domain or per replica, then add replicas or a push service |

## Discord to server (Gateway)

| # | Failure | User sees | Detection | Handling | Status |
|---|---|---|---|---|---|
| 7 | Gateway drops because Discord restarts or the network blips | Nothing, or a short gap | `shardDisconnect` and `shardReconnecting` events | discord.js reconnects and resumes | Mitigated |
| 8 | Gateway stays down while the process is alive | The page goes quiet but looks healthy | Watchdog fires after 5 min disconnected; `/health` returns 503; debug panel | `process.exit(1)`, then Railway restarts the process | Mitigated |
| 9 | MessageContent intent is not enabled | Messages with empty text | Empty content with no attachments | A warning log names the intent. The fix is in the Discord developer portal | Detected |
| 10 | Token is invalid or revoked | Empty page, and the deploy never goes live | Login error at startup | Exit 1 with a clear log. After 10 restarts Railway marks the deployment `Crashed` and emails project members | Detected |
| 11 | Discord outage, or a rate limit on the history fetch | Empty or partial history | Fetch error in the logs | Start with an empty buffer. Live messages flow once the Gateway is up | Mitigated |
| 12 | Attachment URLs expire after about 24 h | Broken images in a long-open tab | None | Restarts and page reloads get fresh URLs | Accepted |

## Process and Railway

| # | Failure | User sees | Detection | Handling | Status |
|---|---|---|---|---|---|
| 13 | Process crashes | "Reconnecting…" for a few seconds | An `unhandled_error` log line (`@level:error`) for any uncaught exception or rejection | Restart policy (on failure), and history is fetched again at startup | Mitigated |
| 14 | An env var is missing | The deploy never goes live | Startup validation | Exit 1 with a log naming the variable | Mitigated |
| 15 | A deploy kills the old process at once (Railway's default drain is 0 s) | Every client drops at the same moment | None | SIGTERM handler, 30 s of overlap and draining, and a start command of `bun run` instead of a package script | Mitigated |
| 16 | Two bots run during the deploy overlap | Nothing | None | Harmless because the bot only reads. It would post duplicate replies if it ever wrote | Accepted |
| 17 | A restart empties the in-memory buffer | An empty page for a moment | None | Fetch the latest `BUFFER_SIZE` messages at startup | Mitigated |
| 18 | The buffer grows without limit | A crash from running out of memory | None | Fixed-size ring buffer of `BUFFER_SIZE` messages, at most 500 | Mitigated |
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

1. Check the Railway deployment status. If it says `Crashed`, read the last logs for a bad token or a missing env var.
2. Open `/health`. A 503 means the Gateway is down; look in the logs for `gateway_disconnected` and whether the watchdog fired.
3. Turn on the `debug-panel` flag and look at Gateway status, client count and the last event time.
4. If messages arrive with no text, the MessageContent intent is off in the Discord developer portal.
5. Compare `CHANNEL_ID` with the channel's ID (Discord developer mode, then Copy Channel ID).
6. Confirm the bot has View Channel and Read Message History in that channel.
7. If only some users are affected, look at their side: network, browser extensions, or a tab that has been open for days.
