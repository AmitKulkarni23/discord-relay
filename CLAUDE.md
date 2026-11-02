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

- **Runtime**: Bun (install, scripts, server, frontend bundling, tests)
- **Backend**: `Bun.serve` HTTP server + discord.js bot, TypeScript
- **Frontend**: React + Material UI, bundled by Bun's HTML imports (no Vite, no Next.js)
- **Realtime to browser**: Server-Sent Events (`EventSource`)
- **Hosting**: Railway, one service, one replica, app sleeping off
- **Infrastructure as Code**: Railway IaC in `.railway/railway.ts` (not the deprecated `railway.json`)

## Folder Structure

```
discord-relay/
├── .claude/rules/         # coding rules, loaded by path (see Rules below)
├── .railway/
│   └── railway.ts         # Railway IaC (service, healthcheck, start command, non-secret vars)
├── backend/
│   ├── server.ts          # entry point: wiring + Bun.serve (/, /events, /health, /config)
│   ├── hub.ts             # Observer: ring buffer + publish/subscribe, keyed by channelId
│   ├── types.ts           # Msg type shared with the frontend
│   └── sources/
│       └── discord.ts     # discord.js client → normalized messages
├── frontend/
│   ├── index.html
│   ├── feed.ts            # pure message logic: dedupe, cap, grouping (tested)
│   ├── theme.ts           # MUI theme
│   └── app.tsx            # React + MUI
├── docs/
│   ├── system-specs/      # architecture, failure modes, decisions
│   └── task-specs/        # one spec per task, TASK_INDEX.md lists them in order
├── package.json           # one, at the root
├── .gitignore
├── CLAUDE.md
└── README.md
```

## Rules

Coding rules live in `.claude/rules/` and load only when a matching file is touched:

- `typescript.rules.md`: all `.ts`/`.tsx`
- `backend.rules.md`: `backend/` (boundaries, buffer, SSE, reliability, logging)
- `react.rules.md`: `frontend/` (stream state, components, security, MUI)
- `testing.rules.md`: `*.test.ts(x)`

## Feature Flags

Railway service variables, read once in `backend/server.ts` and exposed to the browser via `GET /config`. Changing one redeploys the service.

- `FEATURE_ATTACHMENTS`: render images, video and file links (Discord CDN URLs only).
- `FEATURE_EDITS_DELETES`: live-update edited and deleted messages.
- `DEBUG_PANEL`: show connection status, client count and last event time.

## Environment Variables

- `DISCORD_TOKEN`: bot token. Secret: set as a sealed Railway variable, never in Git, `.railway/railway.ts` or chat.
- `CHANNEL_ID`: the Discord channel to relay.
- `PORT`: injected by Railway.

The MessageContent intent MUST be enabled for the bot in the Discord developer portal, or messages arrive empty.

## Security Model

- The bot token lives only on the server. The browser never talks to Discord.
- The page is public: anyone with the URL can read the channel.

## Commands

```bash
bun install
bun run dev        # local server with hot reload
bun run typecheck
bun test           # unit + integration, no network
```

```bash
railway config pull    # generate .railway/railway.ts from the dashboard
railway config plan    # preview infra changes
railway config apply   # apply them
```

## Testing

- **Unit + integration** (`bun test`): no Discord, no network. Integration tests run the real `Bun.serve` with a fake source publishing to the hub.
- GitHub Actions runs typecheck and `bun test` on every push and PR.
- Write the test first, see it fail, then implement.

## Environments

- **production** only: Railway autodeploys `main` with "Wait for CI" on, so a failing GitHub Actions run skips the deploy.
- PR environments are off for this service (each would start another bot).
- No staging environment. The staging + end-to-end + promotion pipeline is described in the README as the at-scale design, not built.

## Infrastructure as Code

All Railway configuration lives in `.railway/railway.ts` — no ClickOps after the first setup.

- **Deploy**: `railway config plan` before every `railway config apply`.
- **Never** change service settings in the Railway dashboard without updating `.railway/railway.ts`.

## Browser Automation

**Do not run any browser automation (playwright-cli or claude-in-chrome) unless the user explicitly asks for it.** Verify changes with type-check and tests, and let the user check the UI.

When the user does ask, use the `/playwright-cli` skill (screenshots, clicking, form filling). Never use claude-in-chrome MCP tools.

## Specs and Tasks

- **System specs** (`docs/system-specs/`): `architecture.md` (diagrams, components, flows, API, `Msg`, config, limits, Railway settings, scope), `message-shape.md` (an example `/events` message and what each field means), `failure-modes.md` (what breaks, how it is handled, support runbook), `decisions.md` (choices, alternatives, when to revisit). Read before any backend or infra change and keep them current. Diagrams are Mermaid.
- **Tasks**: `docs/task-specs/TASK_INDEX.md` lists every task in order. Work on the first task that is not struck through and whose dependencies are done; follow its spec exactly.
- **When a task is done** (all acceptance criteria met), strike its line through in `docs/task-specs/TASK_INDEX.md` (`~~...~~`) and commit that with the task's last change.
- Steps marked **asks the user** / **requires user approval** in a spec are hard stops: ask and wait.

## Git Conventions

- Commit messages must be at most 2 sentences/phrases long.
- Commit and push to GitHub after each meaningful file or logical unit of work is complete.
