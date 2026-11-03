# Load test results

`load/` runs the real hub and server with a fake producer, and opens raw TCP connections to `/events`. It ramps client counts and stops at the first level that fails. A level passes when every client gets every message, none drop, and p99 delivery is at most 1 s.

```bash
bun load/run.ts --levels 1000,5000,10000 --rate 5 --hold 45
```

## Live service through the public URL (2026-11-03)

This is the `discord-relay` production service with its real Discord bot, reached through Railway's edge as a browser would. The test used a temporary, uncommitted build: the 20-stream-per-IP cap raised, a simulated producer added, and a stats route added. Generators ran as a Railway service in a separate environment. Messages were about 470 bytes, `BUFFER_SIZE` was 100, and each level was held for 45 s.

These runs happened back to back, so treat CPU and latency as approximate. With several generators, each one also read and reset the server's stats, so their CPU figures are a range across generators, and the memory figure is the highest any of them saw.

| Clients | Generators | Msg/s | Delivered | p50 | p99 | Slowest | CPU (one core) | Memory | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 2,500 | 1 | 5 | 100% | 36 ms | 106 ms | 1.6 s | 18-21% | 199 MB | Pass |
| 3,000 | 1 | 5 | 100% | 41 ms | 118 ms | 0.8 s | 23-26% | 234 MB | Pass |
| 5,000 | 1 | 5 | 100% | 73 ms | 194 ms | 1.1 s | 43-45% | 333 MB | Pass |
| 5,000 (repeat) | 1 | 5 | 100% | 68 ms | 219 ms | 1.0 s | 37-45% | 347 MB | Pass |
| 7,500 | 3 | 5 | 100% | up to 147 ms | up to 429 ms | 1.4 s | 60-68% avg | 551 MB | Pass |
| 10,002 | 3 | 5 | 100% | up to 171 ms | up to 470 ms | 1.4 s | 68-71% avg | 663 MB | Pass |
| 12,000 | 3 | 5 | 100% | up to 188 ms | up to 431 ms | 1.1 s | 65-74% avg | 705 MB | Pass |
| 15,000 attempted | 5 | 5 | n/a | n/a | n/a | n/a | n/a | n/a | Fail: 5,500 attempts got a 502, then 9,500 streams held |

What this means:

- **12,000 clients at 5 msg/s passed, and the attempt at 15,000 failed at the edge.** Later levels in the same run, attempting 20,000 and 25,000, also failed. These bracket the limit but do not pin it to a number.
- **The server was not what failed.** Railway's HTTP logs show `too many upstream connections for host` on all 5,000 of the 502 entries retrieved, with no upstream address and about 1 ms duration, so those requests never reached the app. The process did not restart, and peak memory in that run was 1.39 GB of 8 GB.
- **The cap affects page loads too.** `/health` and the stats route also got 502s while the edge was refusing connections.
- **The first 502 was at 14:41:17 UTC, and the burst lasted about 9 s.**

The exact error, from one of the 5,000 entries retrieved from Railway's HTTP logs. The retrieval was capped at 5,000 lines, every entry had this error, and a search for status 529 returned nothing:

```json
{
  "timestamp": "2026-11-03T14:41:17.320165542Z",
  "method": "GET",
  "path": "/events",
  "httpStatus": 502,
  "totalDuration": 1,
  "edgeRegion": "us-west2",
  "upstreamAddress": "",
  "upstreamProto": "",
  "upstreamErrors": "[{\"deploymentInstanceID\":\"542a648e-3e53-4acb-8488-7e87ef2e0ba9\",\"error\":\"too many upstream connections for host\",\"duration\":0}]",
  "deploymentInstanceId": "00000000-0000-0000-0000-000000000000"
}
```

Open questions:

- Why 12,000 passed when Railway documents 10,000 per domain per edge node. Traffic spread across edge nodes is one possibility, not confirmed; every 502 entry retrieved came from edge region `us-west2`.
- Why `/health` briefly reported 17,686 clients in the 15,000 run, and why about 2,500 established streams were dropped in that run.

### One generator stops at 6,000

One generator could not hold more than 6,000 connections through the public URL: at 7,500, 10,000 and 12,000 it stayed at 6,000 and its extra connections failed with no HTTP response. Railway also logged a high ephemeral port warning for the generator. A separate generator on a laptop then held 7,000 clients with 100% delivery (1 msg/s, p99 492 ms, 15 s hold), so 6,000 is a limit of one generator's outbound path, not of the service or the edge. That laptop run is a diagnostic only.

## Separate server over the private network (2026-11-03)

This earlier run used the same hub and server code with a simulated producer and no Discord bot, on its own Railway service. Generators connected over Railway's private network, which bypasses the edge. It shows what the server does without the edge, on a different deployment from the run above.

One Railway replica (8 vCPU, 8 GB limit), generator in a second service, messages of about 470 bytes, `BUFFER_SIZE` 100, each level held for 45 s:

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

- **Passed:** about 10,000 clients at 5 msg/s, or 20,000 at 1 msg/s. This run bypassed Railway's edge; the public results are above.
- **Memory is not the limit:** about 58 KB per client, so 10,000 clients use about 630 MB of the 8 GB.
- **CPU is not what failed first:** the 12,500 and 30,000 runs failed at under 50% of one core. The median stayed low while a few connections (71 and 15) stalled for up to 46 s. The cause is unknown, and it did not happen on a laptop at 15,000.
- **More CPU would not help much:** Bun runs this on one thread, so the server peaked at about 1.1 of 8 vCPU.
- **Results vary between runs:** 10,000 clients gave a p99 of 795 ms in one run and 111 ms in another.

What this does not cover:

- **Railway's public edge:** the private network bypasses it, because the 20-stream-per-IP cap needs a different `X-Real-IP` per connection.
- **Real browsers:** page loads, rendering and attachments are not part of the test.
- **Sustained load:** levels are held for 45 s, so this is not a leak test.
- **Egress:** 10,000 clients at 5 msg/s is about 24 MB/s of data, and that traffic would be billed on the public domain.

One unexplained result: on a laptop at 50 msg/s, where the server was saturated, the Bun generator saw 995 repeated messages. A separate Python client with stalled reads saw none in 52,065 messages at 300 msg/s, so the source is unknown. Browsers dedupe by message ID, so a repeat would not show on the page.
