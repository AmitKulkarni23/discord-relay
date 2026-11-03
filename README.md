# DiscordRelay

A Discord bot that streams messages from a Discord channel into a web page in real time, deployed on Railway.

**Status:** work in progress.

## How it works

```
Discord ──gateway WebSocket──▶ Bun server (bot + ring buffer) ──SSE──▶ browsers (React + MUI)
```

## Run locally

```bash
bun install
DISCORD_TOKEN=... CHANNEL_ID=... bun run dev
```

Overview, alternatives considered and known problems: coming soon.

## Load test

`load/` runs the real hub and server with a fake producer, and opens raw TCP connections to `/events`. It ramps client counts and stops at the first level that fails. A level passes when every client gets every message, none drop, and p99 delivery is at most 1 s.

```bash
bun load/run.ts --levels 1000,5000,10000 --rate 5 --hold 45
```

Results from 2026-11-03, one Railway replica (8 vCPU, 8 GB limit), generator in a second service over the private network, messages of about 470 bytes, `BUFFER_SIZE` 100, each level held for 45 s:

| Clients | Msg/s | Delivered | p50 | p99 | Slowest | CPU (one core) | Memory | Result |
|---|---|---:|---:|---:|---:|---:|---:|---|
| 5,000 | 5 | 100% | 43 ms | 282 ms | 0.7 s | 31-36% | 344 MB | Pass |
| 10,000 | 5 | 100% | 101 ms | 795 ms | 12.5 s | 58-66% | 627 MB | Pass |
| 10,000, connecting at once | 5 | 100% | 51 ms | 111 ms | 0.5 s | 47-53% | 622 MB | Pass |
| 12,500 | 5 | 99.78% | 111 ms | 3.0 s | 29 s | 42-48% | 763 MB | Fail |
| 20,000 | 5 | 91.47% | 280 ms | 18.4 s | 52 s | 80-85% | 1.29 GB | Fail |
| 20,000 | 1 | 100% | 179 ms | 503 ms | 22.6 s | 24-30% | 1.18 GB | Pass |
| 30,000 | 1 | 99.95% | 285 ms | 1.3 s | 46 s | 38-48% | 1.75 GB | Fail |

What this means:

- **Supported:** about 10,000 clients at 5 msg/s, or 20,000 at 1 msg/s. Above 10,000 on a public domain, Railway's edge limit applies first (below).
- **Memory is not the limit:** about 58 KB per client, so 10,000 clients use about 630 MB of the 8 GB.
- **CPU is not what failed first:** the 12,500 and 30,000 runs failed at under 50% of one core. The median stayed low while a few connections (71 and 15) stalled for up to 46 s. The cause is unknown, and it did not happen on a laptop at 15,000.
- **More CPU would not help much:** Bun runs this on one thread, so the server peaked at about 1.1 of 8 vCPU.
- **Results vary between runs:** 10,000 clients gave a p99 of 795 ms in one run and 111 ms in another.

What this does not cover:

- **Railway's public edge:** the test bypasses it, because the 20-stream-per-IP cap needs a different `X-Real-IP` per connection. Railway says the edge counts in-flight requests per domain, separately on each edge node, with a limit of 10,000 that replicas and plan upgrades do not raise. An open SSE stream should hold a slot the way a long poll does, so 10,000 per edge node is the public ceiling. Established WebSockets give their slot back.
- **Real browsers:** page loads, rendering and attachments are not part of the test.
- **Sustained load:** levels are held for 45 s, so this is not a leak test.
- **Egress:** 10,000 clients at 5 msg/s is about 24 MB/s of data, and that traffic would be billed on the public domain.

One unexplained result: on a laptop at 50 msg/s, where the server was saturated, the Bun generator saw 995 repeated messages. A separate Python client with stalled reads saw none in 52,065 messages at 300 msg/s, so the source is unknown. Browsers dedupe by message ID, so a repeat would not show on the page.
