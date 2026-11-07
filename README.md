# DiscordRelay

A Discord bot that streams messages from one or more Discord channels into a web page in real time. 

Link: discord-relay-production-262e.up.railway.app


## Acronyms and Terminology

| Term | Meaning |
| --- | --- |
| Bun | JavaScript runtime with a built-in HTTP server, bundler and test runner. Runs the server, bundles the React page and runs the tests. |
| Gateway | Discord's real-time WebSocket API. The bot gets new and deleted messages through it. |
| Snowflake | Discord's message ID: unique and time-ordered. Used for ordering and dedupe. |
| MessageContent intent | Discord permission the bot needs to read message text. Without it, Discord closes the Gateway (code 4014). |
| SSE | Server-Sent Events: a one-way server-to-browser stream over plain HTTP, read with `EventSource`. Served on `GET /events`. |
| Pub/Sub | Publish/subscribe (Observer pattern): publishers send messages without knowing who receives them; subscribers get every message published. |
| Hub | The in-memory core (`backend/hub.ts`): the latest messages per channel plus Pub/Sub. The bot publishes, each open browser stream subscribes. |
| Edge | Railway's public proxy. Cuts requests at 15 min and caps in-flight requests per domain. |
| SIGTERM | The signal Railway sends to stop the process. The server closes open streams and the Discord client, then exits. |


## High Level Design

### How it works
One Railway service, with one replica, runs three components in a single Bun process:

- **Discord ingestion**: connects to Discord as a read-only bot, loads recent history over Discord's REST API at startup, and receives new messages live over the gateway, Discord's real-time WebSocket
- **Hub**: keeps the latest messages per channel in memory. Each open browser stream registers a callback; when a message arrives, the hub calls every callback for that channel
- **HTTP Server**: serves the web page, streams messages to browsers over SSE
