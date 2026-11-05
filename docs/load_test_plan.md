# Load test plan: finding the true max

The question: **how many viewers can one server hold for one busy channel?**

The answer is a list, one row per channel speed, because busier channels leave room for fewer viewers. Each message goes to every viewer, so the server's work is rate × viewers.

| Rate | Consumers to try (starting guess) | Usable max | Hard max | What ran out |
|---:|---|---|---|---|
| 1 msg/s | 10k, 20k, 40k, 60k, 80k, 100k | | | |
| 10 msg/s | 5k, 10k, 20k, 30k, 40k, 60k | | | |
| 50 msg/s | 1k, 2.5k, 5k, 10k, 20k, 30k | | | |
| 200 msg/s | 500, 1k, 2.5k, 5k, 10k, 20k | | | |

## Terms

- **Consumer:** one open `/events` connection, standing in for one browser.
- **Process:** a running copy of the code that holds consumers. It belongs to the test rig, and the server does not know about it.
- **Machine:** one Railway service running those processes.
- **Producer:** the simulated source of messages, standing in for the bot.
- **Rate:** messages per second.
- **Step:** one consumer count, held for a while and then judged.

## Results of a step

| Result | Rule |
|---|---|
| PASS | Every message reached every consumer, no connection closed, no gaps, every consumer still connected, p99 of 1 s or less, and the slowest delivery 5 s or less |
| SLOW | Nothing was lost, but it missed the p99 or slowest delivery bar |
| BROKEN | A message was lost, or a consumer was dropped or refused |
| INVALID | It did not pass and a process was over 80% of its core, or over 200 ms behind, so the test rig may be the cause. Re-run with more processes or machines |

A step that passes with a busy process still counts as PASS, because an overloaded rig can only make delivery look worse.

- **Usable max:** the highest count that passes, in 3 out of 3 repeats. This is the capacity figure.
- **Hard max:** the highest count before a step is BROKEN. This is the margin.

The 1 s and 5 s bars and the 80% and 200 ms limits are judgement calls, not standards.

## Fixed settings

One channel, messages of about 470 bytes, a 60 s hold per step, `BUFFER_SIZE` 100.

## Steps

1. **Harness (local, `load/` only). Done.** The results above and the busiest process are in `load/run.ts`. Several machines are coordinated through `load/agent.ts`, so `--consumers` is the total and only the runner reads the server's stats. `load/max.ts` searches for the limit, and `load/railway-metrics.ts` reads server CPU and memory from `railway metrics`.
2. **Railway (needs approval).** A separate server service with no Discord bot, and enough consumer machines for the count being tested. Check the cost first, and tear it all down afterwards.
3. **Find the limits.** Run each rate from no open connections, narrow down between the last pass and the first failure, and repeat the limit 3 times.
4. **Confirm it holds.** About 70% of the usable max at 10 msg/s for 30 minutes, watching for memory growth.
5. **Stress one thing at a time.** At 10 msg/s with half the usable max: 4,000-byte messages, slow clients, reconnect churn, a reconnect storm, and bursts.
6. **The real page (needs approval for Playwright).** Open it in a browser at each rate, because the page may struggle before the server does.

The live service is only tested with a temporary build, on your approval, while it has no real viewers. It adds one private port, and redeploying from `main` removes it.

## Reading the results

| What we see | What it means |
|---|---|
| Server lag high, server CPU near 1 vCPU | The server's one thread is the limit. Try batching writes next |
| Server lag low, delivery still failing | Something else is the limit, such as the network |
| INVALID | Add processes or machines and re-run |

## What this does not tell us

- **What visitors can reach:** the private network skips Railway's edge, and public runs reached about 15,000 clients. Report both.
- **The bot's cost:** Discord and discord.js are not in the path, so real limits could be somewhat lower.
- **Real browsers:** consumers do not render anything, which is why step 6 exists.

## Running it

On each consumer machine, and once on the load server:

```bash
PORT=4000 bun load/agent.ts
PORT=3100 CHANNELS=1 bun load/server.ts
```

From one machine that can reach them all, which on Railway means one inside the private network:

```bash
bun load/max.ts --host <server> --machines http://<consumer-1>:4000,http://<consumer-2>:4000 \
  --rate 10 --consumers 5000,10000,20000,30000,40000,60000 --hold 60 --maxSec 3600 | tee results.jsonl
```

Then, from anywhere the Railway CLI is logged in:

```bash
bun load/railway-metrics.ts results.jsonl --service <server service>
```
