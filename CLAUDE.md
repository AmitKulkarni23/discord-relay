# DiscordRelay

A Discord bot that streams messages from a Discord channel into a web front-end, live. Built as the take-home project for Railway's Senior Software Engineer, Support interview and deployed on Railway.

## What It Does

A bot connects to the Discord Gateway and listens to one channel. Every new message is normalized, kept in a small in-memory buffer and pushed to every open browser over Server-Sent Events (SSE). Opening the page shows the latest messages immediately, then new ones as they are posted. Discord is the source of truth; the app is a live relay, not an archive.

## Design Principles

- **Laziest correct solution**: one service, one replica, no database until a real need shows up.
- **Push end to end**: Discord Gateway → server → SSE → browser. No polling.
- **Bounded everything**: fixed-size ring buffer on the server, capped message list in the browser.
- **Fail loudly, recover on its own**: clear logs, `/health` tied to the Discord connection, browsers reconnect automatically.
- **Honest README**: how it works, alternatives considered, known problems.

## Tech Stack

- **Runtime**: Bun (install, scripts, server, frontend bundling)
- **Backend**: `Bun.serve` HTTP server + discord.js bot, TypeScript
- **Frontend**: React + Material UI, bundled by Bun's HTML imports (no Vite, no Next.js)
- **Realtime to browser**: Server-Sent Events (`EventSource`)
- **Hosting**: Railway, one service, one replica, app sleeping off
- **Infrastructure as Code**: Railway IaC in `.railway/railway.ts` (not the deprecated `railway.json`)

## Folder Structure

```
discord-relay/
├── .railway/
│   └── railway.ts         # Railway IaC (service, healthcheck, start command, non-secret vars)
├── backend/
│   ├── server.ts          # Bun.serve: /, /events (SSE), /health, /config
│   ├── discord.ts         # discord.js client → normalized messages
│   ├── hub.ts             # ring buffer + publish/subscribe, keyed by channelId
│   └── types.ts           # Msg type shared with the frontend
├── frontend/
│   ├── index.html
│   └── app.tsx            # React + MUI
├── docs/
│   ├── system-specs/      # architecture, failure modes, decisions
│   └── task-specs/        # one spec per task, TASK_INDEX.md lists them in order
├── package.json           # one, at the root
├── .gitignore
├── CLAUDE.md
└── README.md
```

## Key Behaviors

- One Discord gateway connection. Needs the `Guilds`, `GuildMessages` and `MessageContent` intents (MessageContent is privileged: enable it in the Discord developer portal).
- On startup the server fetches the latest 100 messages from Discord to fill the ring buffer. The buffer holds 100; the oldest falls off.
- `GET /events` sends the buffer, then each new message. Every event has `id:` set to the Discord message ID.
- Heartbeat comment (`: ping`) every 25 seconds so Railway's proxy does not close idle streams. Railway caps HTTP requests at 15 minutes; `EventSource` reconnects on its own.
- Dedupe by Discord message ID on the server and in the browser; rendering is idempotent.
- Browser keeps at most 500 messages; oldest are removed.
- Everything is keyed by `channelId` so more channels are a config change.

## Feature Flags

Railway service variables, read once in `backend/server.ts` and exposed to the browser via `GET /config`. Changing one redeploys the service.

- `FEATURE_ATTACHMENTS`: render images, video and file links (Discord CDN URLs only).
- `FEATURE_EDITS_DELETES`: live-update edited and deleted messages.
- `DEBUG_PANEL`: show connection status, client count and last event time.

## Environment Variables

- `DISCORD_TOKEN`: bot token. Secret: set as a sealed Railway variable, never in Git, `.railway/railway.ts` or chat.
- `CHANNEL_ID`: the Discord channel to relay.
- `PORT`: injected by Railway.

## Commands

```bash
bun install
bun run dev        # local server with hot reload
bun run typecheck
bun test
```

```bash
railway config pull    # generate .railway/railway.ts from the dashboard
railway config plan    # preview infra changes
railway config apply   # apply them
```

## Security Model

- The bot token lives only on the server. The browser never talks to Discord.
- Message content is rendered as text (React escaping). Never use `dangerouslySetInnerHTML`.
- Attachment URLs are rendered only if their host is `cdn.discordapp.com` or `media.discordapp.net`.
- The page is public: anyone with the URL can read the channel.

## Reliability

- Start command is `bun run backend/server.ts` (not `bun run start`) so SIGTERM reaches the app.
- SIGTERM handler closes SSE streams and destroys the Discord client.
- Deployment overlap and draining seconds are set so deploys do not cut clients instantly.
- `/health` returns 200 only when the Discord gateway is connected. Railway only checks it at deploy time, so the app exits with code 1 if the gateway stays disconnected for more than 5 minutes; the restart policy brings it back.
- Validate env vars at startup and fail with a clear log line.

## Infrastructure as Code

All Railway configuration lives in `.railway/railway.ts` — no ClickOps after the first setup.

- **Deploy**: `railway config plan` before every `railway config apply`.
- **Never** change service settings in the Railway dashboard without updating `.railway/railway.ts`.

## Browser Automation

**Do not run any browser automation (playwright-cli or claude-in-chrome) unless the user explicitly asks for it.** Verify changes with type-check and tests, and let the user check the UI.

When the user does ask, use the `/playwright-cli` skill (screenshots, clicking, form filling). Never use claude-in-chrome MCP tools.

## Specs and Tasks

- **Architecture**: `docs/system-specs/`. Read before any backend or infra change and keep it current.
- **Tasks**: `docs/task-specs/TASK_INDEX.md` lists every task in order. Work on the first task that is not struck through and whose dependencies are done; follow its spec exactly.
- **When a task is done** (all acceptance criteria met), strike its line through in `docs/task-specs/TASK_INDEX.md` (`~~...~~`) and commit that with the task's last change.
- Steps marked **asks the user** / **requires user approval** in a spec are hard stops: ask and wait.

## Git Conventions

- Commit messages must be at most 2 sentences/phrases long.
- Commit and push to GitHub after each meaningful file or logical unit of work is complete.
