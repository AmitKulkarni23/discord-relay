# Load test results: Nov 4, 2026

## Pass/fail criteria

**PASS: all of these are true**

- Every message reached every consumer, with no gaps.
- No consumer was dropped or refused.
- p99 delivery time is 1 s or less.
- The slowest single delivery is 5 s or less.
- The generator had no failed sends.

**SLOW: nothing was lost, but it was too late**

- p99 is over 1 s, or the slowest delivery is over 5 s.

**BROKEN: something was lost or failed**

- A message had not arrived 10 s after the step ended.
- A consumer was dropped or refused.
- The generator had a failed send.

**INVALID: the test rig may be the cause, so re-run with more capacity**

- The step did not pass, and a consumer process was over 80% of its core or over 200 ms behind.
- The step did not pass, and the generator was over 200 ms behind.

**Not built yet**

- A crash or restart of the app counting as BROKEN. Today it stops the run with no result.
- A slow generator send counting as SLOW.
- Holding a Hard Max candidate for about 10 minutes.

The 1 s, 5 s, 80% and 200 ms limits are judgement calls, not standards.

**Message size: 456 bytes**

This stands in for a typical short chat message. Most of a real message is metadata, such as IDs, author details and a timestamp, so even a short one is about 400 bytes. It is a rough estimate, not sampled from real traffic. It stays fixed so runs can be compared, and larger messages are tested separately.

## Setup

```
┌────────────────┐      ┌─────────────────┐      ┌────────────────┐
│ Load generator │ ───→ │       App       │ ───→ │   Consumers    │
│ load-generator │      │  discord-relay  │      │ load-consumers │
└────────────────┘      └─────────────────┘      └────────────────┘
  fake messages          hub + /events            fake browsers
```

All three run on Railway and talk over the private network.

- **Load generator:** stands in for messages arriving from Discord. It sends fake messages to the app at a fixed rate.
- **App:** the real `discord-relay` service with its real bot, running a temporary build. The build adds one private port, so the generator can send messages and the test can read stats.
- **Consumers:** stand in for browsers. Each consumer is one open `/events` connection that checks every message arrived and how long it took.

Each test started with an app restart and a 2-minute wait, so CPU and memory could not carry over from the test before. Tests ran one at a time. Result 1 and Result 2 used 1 consumer service, and the rest used 5.

## Summary

| Rate | Usable Max | First SLOW | Hard Max |
|---:|---:|---:|---|
| 1 msg/s | At least 55,000 (top of the test, 1 run) | Not reached | Not reached |
| 10 msg/s | **16,300** (confirmed, 3 of 3 repeats) | 17,500 | Not reached by 20,000 |
| 50 msg/s | At least 5,000 (1 run, not narrowed) | 7,500 | Not reached by 7,500 |
| 200 msg/s | 2,000 (passed 2 of 2 runs, not narrowed) | 2,500 | **Between 3,000 and 4,000** |

- **Nothing was lost below the Hard Max.** Every step up to 3,000 at 200 msg/s, and every other rate, had 100% delivery. Delivery only got slower.
- **The limit is not a fixed number of writes per second.** Rate x viewers at the highest pass was 163,000 at 10 msg/s, 250,000 at 50 and 400,000 at 200. Why it rises with the rate is unknown. Writes combining under load is a guess, not a finding.
- **CPU stops being useful near the limit.** It reached about 92% of one core at 10,000 consumers at 10 msg/s and stayed there through 20,000, while p99 went from 326 ms to 1.3 s. Railway peaked at 1.2 of 8 vCPU.
- **Memory was not the limit.** About 60 KB per consumer, and 3.1 GB of 8 GB at 55,000.

## Result 1: 1,000 consumers at 10 msg/s

10 msg/s, 1,000 consumers, 60 s hold, 1 consumer replica, messages of 456 bytes.

| Check | Result |
|---|---:|
| Result | **PASS** |
| Delivered | 100% |
| Dropped | 0 |
| p50 | 7.5 ms |
| p99 | 14.5 ms |
| Slowest | 20.5 ms |
| Messages measured | 580 |
| Generator failed sends | 0 |
| App CPU | About 10% of one core |
| App memory | 153 MB |
| Event-loop lag | 6 ms at most |
| Busiest consumer process | About 6% CPU |

This shows the setup works and gives a baseline. It does not show a max.

## Result 2: 10 msg/s, 1 consumer service

| Consumers | Result | Delivered | p50 | p99 | Slowest | CPU | Memory |
|---:|---|---:|---:|---:|---:|---:|---:|
| 5,000 | PASS | 100% | 34 ms | 63 ms | 135 ms | 48% | 334 MB |
| 10,000 | PASS | 100% | 239 ms | 366 ms | 560 ms | 91% | 604 MB |
| 15,000 | Not counted | 80% | 273 ms | 458 ms | 628 ms | 92% | 724 MB |

The 15,000 step was marked BROKEN, but the test rig caused it. Connections stopped at about 12,000, and Railway logged high ephemeral port usage on the consumer service. So later tests used 5 consumer services.

## Result 3: 10 msg/s, 5 consumer services

| Consumers | Result | Delivered | p50 | p99 | Slowest | CPU | Memory |
|---:|---|---:|---:|---:|---:|---:|---:|
| 10,000 | PASS | 100% | 221 ms | 327 ms | 427 ms | 92% | 617 MB |
| 12,500 | PASS | 100% | 285 ms | 451 ms | 626 ms | 92% | 754 MB |
| 15,000 | PASS | 100% | 365 ms | 585 ms | 794 ms | 92% | 888 MB |
| 20,000 | SLOW | 100% | 840 ms | 1,315 ms | 1,575 ms | 92% | 1,188 MB |

## Result 4: Narrowing the Usable Max at 10 msg/s

| Consumers | Result | Delivered | p50 | p99 | Slowest | CPU | Memory |
|---:|---|---:|---:|---:|---:|---:|---:|
| 15,000 | PASS | 100% | 417 ms | 757 ms | 925 ms | 92% | 889 MB |
| 20,000 | SLOW | 100% | 813 ms | 1,183 ms | 1,513 ms | 93% | 1,189 MB |
| 17,500 | SLOW | 100% | 722 ms | 1,094 ms | 1,396 ms | 92% | 1,082 MB |
| 16,300 | PASS | 100% | 623 ms | 909 ms | 1,138 ms | 92% | 983 MB |
| 16,300, repeat 1 | PASS | 100% | 596 ms | 923 ms | 1,161 ms | 92% | 987 MB |
| 16,300, repeat 2 | PASS | 100% | 595 ms | 894 ms | 1,064 ms | 93% | 988 MB |
| 16,300, repeat 3 | PASS | 100% | 644 ms | 948 ms | 1,152 ms | 92% | 1,005 MB |

## Result 5: 50 msg/s

| Consumers | Result | Delivered | p50 | p99 | Slowest | CPU | Memory |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1,000 | PASS | 100% | 8 ms | 20 ms | 211 ms | 49% | 117 MB |
| 2,500 | PASS | 100% | 48 ms | 78 ms | 263 ms | 92% | 202 MB |
| 3,000 | PASS | 100% | 58 ms | 110 ms | 256 ms | 94% | 230 MB |
| 4,000 | PASS | 100% | 126 ms | 187 ms | 232 ms | 95% | 286 MB |
| 5,000 | PASS | 100% | 185 ms | 307 ms | 388 ms | 95% | 347 MB |
| 7,500 | SLOW | 100% | 1,141 ms | 1,613 ms | 1,812 ms | 95% | 509 MB |

## Result 6: 200 msg/s

| Consumers | Result | Delivered | p50 | p99 | Slowest | CPU | Memory |
|---:|---|---:|---:|---:|---:|---:|---:|
| 250 | PASS | 100% | 5 ms | 16 ms | 50 ms | 40% | 61 MB |
| 500 | PASS | 100% | 7 ms | 19 ms | 128 ms | 78% | 73 MB |
| 750 | PASS | 100% | 14 ms | 28 ms | 106 ms | 92% | 89 MB |
| 1,000 | PASS | 100% | 22 ms | 44 ms | 109 ms | 91% | 108 MB |
| 1,500 | PASS | 100% | 71 ms | 125 ms | 184 ms | 93% | 132 MB |
| 2,000 | PASS | 100% | 548 ms | 766 ms | 864 ms | 93% | 167 MB |

## Result 7: 200 msg/s, past the limit

| Consumers | Result | Delivered | p50 | p99 | Slowest | CPU | Memory |
|---:|---|---:|---:|---:|---:|---:|---:|
| 2,000 | PASS | 100% | 577 ms | 840 ms | 986 ms | 93% | 185 MB |
| 2,500 | SLOW | 100% | 825 ms | 1,134 ms | 1,640 ms | 92% | 211 MB |
| 3,000 | SLOW | 100% | 875 ms | 1,226 ms | 1,484 ms | 90% | 242 MB |
| 4,000 | BROKEN | Not measured | Not measured | Not measured | Not measured | 96% | 1,384 MB |

This is the only real break in these tests. At 4,000 consumers:

- The app's event loop stalled for up to 33.6 s, and memory jumped from 242 MB to 1,384 MB.
- The app dropped about 2,370 of the 4,000 consumers, over about 13 s, for falling 1 MiB behind. That is the app's own safety limit working. Its logs show 2,068 drops, and Railway discarded 304 more log lines.
- The app did not crash, and the bot stayed connected.
- The step's delivery figures are not usable, because of a harness bug: a dropped connection sends an extra reply, which the runner reads in place of the consumer's report.

## Result 8: 1 msg/s

| Consumers | Result | Delivered | p50 | p99 | Slowest | CPU | Memory |
|---:|---|---:|---:|---:|---:|---:|---:|
| 10,000 | PASS | 100% | 67 ms | 123 ms | 138 ms | 11% | 629 MB |
| 30,000 | PASS | 100% | 194 ms | 367 ms | 423 ms | 34% | 1,743 MB |
| 55,000 | PASS | 100% | 369 ms | 789 ms | 975 ms | 61% | 3,122 MB |

55,000 was the top of the test. Each consumer service held about 12,000 connections at most, so going higher needs more of them.

## What these results do not show

- **Long-running behavior:** each step held for 60 s, so slow overload may not have shown yet. A Hard Max candidate still needs a hold of about 10 minutes.
- **What visitors can reach:** these tests skip Railway's public edge. Earlier public runs hit its limit at around 15,000 connections.
- **Real browsers and real message sizes:** consumers do not render anything, and messages stayed at 456 bytes.
- **Discord's own traffic path:** the bot was connected but idle, so it did not process these messages.
