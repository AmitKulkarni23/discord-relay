# Load test results

`load/` runs the real hub and server with a fake producer, and opens raw TCP connections to `/events`. It ramps client counts and stops at the first step that fails. A step passes when every client gets every message, none drop, and p99 delivery is at most 1 s.

```bash
bun load/run.ts --consumer machines 1000,5000,10000 --rate 5 --hold 45
```

Knobs, which can be combined. The results below predate them and used the defaults, and they also predate the verdicts and multi-machine coordination in `docs/load_test_plan.md`: each machine ran its own ramp.

| Knob | What it tests | Example |
|---|---|---|
| `--msgBytes` | Bandwidth and egress with large messages. About 10000 is the realistic top | `--msgBytes 4000` |
| `--channels` | The per-channel hub and subscriptions. Clients spread evenly, and `--rate` is per channel | `--channels 4` |
| `--slowPct`, `--slowMode` | The 1 MiB drop. `stop` never reads, `crawl` takes one read per second. They are left out of delivery, and `slow gone` counts the drops | `--slowPct 10 --slowMode stop --rate 50 --msgBytes 10000 --hold 25` |
| `--burst`, `--burstEverySec` | Many messages in one go, then silence, instead of `--rate` | `--burst 200 --burstEverySec 5 --hold 21` |
| `--churnPerSec` | Clients closing and reconnecting with `?since=` all the time. A 15 minute cut of N clients is N / 900 per second | `--churnPerSec 11` |
| `--storm`, `--stormJitterMs` | Every client cut at once halfway through the hold, as a deploy does. The server stays up, so unlike a real restart its buffer survives | `--storm --maxP99Ms 2000` |

A message held up by a reconnect counts towards p99, so raise `--maxP99Ms` for `--churnPerSec` and `--storm`.

## Clean run through the public URL (2026-11-03 11:07 PST)

One unattended run with no other load test nearby, against the live `discord-relay` service and its real bot. It used the same temporary build as the runs below, 3 consumer machines in a separate Railway environment, 5 msg/s and a 45 s hold per step. Latency cells show the highest consumer.

| Clients | Delivered | p50 | p99 | Slowest | CPU avg, one core | Memory | Refused | Result |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 5,001 | 100.00% | 53 ms | 87 ms | 0.9 s | 29-33% | 419 MB | 0 | Pass |
| 7,500 | 100.00% | 73 ms | 120 ms | 1.0 s | 41-100% | 583 MB | 0 | Pass |
| 10,002 | 100.00% | 88 ms | 160 ms | 0.7 s | 36-68% | 677 MB | 0 | Pass |
| 12,000 | 100.00% | 101 ms | 348 ms | 0.8 s | 63-74% | 811 MB | 0 | Pass |
| 15,000 | 100.00% | 121 ms | 420 ms | 5.9 s | 65-83% | 872 MB | 0 | Pass |

Railway metrics for `discord-relay` during the run:

```
current            avg             max             limit
  CPU       0 vCPU (0%)        0.33 vCPU       1.2 vCPU        8.0 vCPU
  Memory    1.02 GB (13%)      508 MB          1.02 GB         8.00 GB

  Public Network Traffic
  ──────────────────────────────────────────────
  Egress       0 MB                    avg: 419 MB           max: 1.42 GB
  Ingress      0 MB                    avg: 50 MB            max: 174 MB
```

Edge errors during the run:

```
0 5xx log lines retrieved (limit 5000)
After restore: streams 1-20 ok: 20, stream 21 status: 429
```


## Live service through the public URL (2026-11-03)

This is the `discord-relay` production service with its real Discord bot, reached through Railway's edge as a browser would. The test used a temporary, uncommitted build: the 20-stream-per-IP cap raised, a simulated producer added, and a stats route added. Consumer machines ran as a Railway service in a separate environment. Messages were about 470 bytes, `BUFFER_SIZE` was 100, and each step was held for 45 s.

These runs happened back to back, so treat CPU and latency as approximate. With several consumer machines, each one also read and reset the server's stats, so their CPU figures are a range across consumer machines, and the memory figure is the highest any of them saw.

| Clients | Consumer machines | Msg/s | Delivered | p50 | p99 | Slowest | CPU (one core) | Memory | Result |
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

- **12,000 clients at 5 msg/s passed, and the attempt at 15,000 failed at the edge.** Later steps in the same run, attempting 20,000 and 25,000, also failed. These bracket the limit but do not pin it to a number.
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

### One consumer machine stops at 6,000

One consumer machine could not hold more than 6,000 connections through the public URL: at 7,500, 10,000 and 12,000 it stayed at 6,000 and its extra connections failed with no HTTP response. Railway also logged a high ephemeral port warning for the consumer. A separate consumer on a laptop then held 7,000 clients with 100% delivery (1 msg/s, p99 492 ms, 15 s hold), so 6,000 is a limit of one consumer machine's outbound path, not of the service or the edge. That laptop run is a diagnostic only.

## True max of the service over the private network (2026-11-03)

This measures the live `discord-relay` service and its real bot with Railway's edge out of the path. It used the same temporary build, with 5 consumer machines in the production environment connecting over the private network and 8 vCPU and 8 GB limits on the service. The server was restarted with zero clients before each ramp. Each step was held for 45 s. A step passes only if every consumer gets 100% delivery with no drops and a p99 of at most 1 s, so "consumer machines passing" counts how many of the 5 met that.

| Clients | Msg/s | Delivered | p50 (worst consumer machine) | p99 (range across consumer machines) | Slowest | Memory (process) | Consumer machines passing |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 12,500 | 5 | 100% | 201 ms | 129-417 ms | 0.8 s | 824 MB | 5 of 5 |
| 15,000 | 5 | 100% | 223 ms | 197-406 ms | 0.5 s | 971 MB | 5 of 5 |
| 17,500 | 5 | 100% | 268 ms | 306-524 ms | 0.7 s | 1.08 GB | 5 of 5 |
| 20,000 | 5 | 100% | 290 ms | 375-542 ms | 0.6 s | 1.22 GB | 5 of 5 |
| 25,000 | 5 | 100% | 339 ms | 711-998 ms | 1.2 s | 1.39 GB | 5 of 5 |
| 20,000 | 1 | 100% | 368 ms | 695-1,115 ms | 1.2 s | 1.48 GB | 2 of 5 |
| 30,000 | 1 | 100% | 512 ms | 758-1,132 ms | 1.4 s | 1.87 GB | 2 of 5 |
| 40,000 | 1 | 100% | 573 ms | 844-1,185 ms | 1.3 s | 2.42 GB | 2 of 5 |
| 50,000 | 1 | 100% | 695 ms | 1,146-1,447 ms | 1.7 s | 2.88 GB | 0 of 5 |
| 57,500 | 1 | 100% | 728 ms | 1,205-1,518 ms | 1.8 s | 3.12 GB | 0 of 5 |

Railway's own metrics peaked at 1.0 vCPU and 1.64 GB in the 5 msg/s ramp, and 1.0 vCPU and 3.58 GB in the 1 msg/s ramp. Per-step CPU is left out: 5 consumer machines each read and reset the same counter, which made the figures unreliable.

What this means:

- **At 5 msg/s the server held 25,000 clients within the pass criteria.** That was the top of the ramp, and with a worst p99 of 998 ms it is at the edge of the 1 s limit.
- **The hard ceiling was not found.** At 57,500 clients every message still reached every client, with no refusals, drops, gaps or duplicates. Delivery only got slower.
- **The server has about 5 times the capacity of the public path.** Through the public URL, 12,000 passed and 15,000 was refused at the edge.
- **One core is the likely bottleneck, and memory is not.** Railway's metrics peaked at 1.0 of 8 vCPU, and 57,500 clients used 3.58 GB of 8 GB.

Limits of this result:

- **1 msg/s looks slower than 5 msg/s at the same client count, and that is unexplained.** At 20,000 clients the p99 was up to 1,115 ms at 1 msg/s and up to 542 ms at 5 msg/s. So do not read the 1 msg/s pass counts as a precise limit.
- **This is not what visitors can reach.** Real traffic goes through the edge, and these clients were raw sockets, not browsers.
- **It covers short holds only.** Each step ran for 45 s.

### Dead connections linger

Consumer machines that stop without closing their sockets stay counted on the server. After one ramp ended, `/health` still reported 25,896 clients more than 5 minutes later. An earlier, discarded ramp reached 75,896 subscribers because of this, with about 50,000 of them live, and Railway's memory peaked at 7.04 GB of 8 GB. The process did not crash. Real clients that disappear without closing, such as a phone losing signal, would behave the same way.

## Separate server over the private network (2026-11-03)

This earlier run used the same hub and server code with a simulated producer and no Discord bot, on its own Railway service. Consumer machines connected over Railway's private network, which bypasses the edge. It is kept for comparison: it used one consumer machine per run, while the later run with 5 consumer machines on the live service held 25,000 clients at 5 msg/s.

One Railway replica (8 vCPU, 8 GB limit), consumer machine in a second service, messages of about 470 bytes, `BUFFER_SIZE` 100, each step held for 45 s:

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
- **Sustained load:** steps are held for 45 s, so this is not a leak test.
- **Egress:** 10,000 clients at 5 msg/s is about 24 MB/s of data, and that traffic would be billed on the public domain.

One unexplained result: on a laptop at 50 msg/s, where the server was saturated, the Bun consumer program saw 995 repeated messages. A separate Python client with stalled reads saw none in 52,065 messages at 300 msg/s, so the source is unknown. Browsers dedupe by message ID, so a repeat would not show on the page.
