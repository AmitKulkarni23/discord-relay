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

The harness is in `load/`. Commands and results are in [docs/load_test_results.md](docs/load_test_results.md).
