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

## Results

10 msg/s, 1,000 consumers, 60 s hold, 1 consumer replica, messages of about 470 bytes.

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
