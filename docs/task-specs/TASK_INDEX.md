# Task index

Work through the tasks in order. Pick the first task that is not struck through and whose dependencies are struck through, read its spec, and follow it. When every acceptance criterion is met, strike the line through here (`~~...~~`) in the same commit as the task's last change.

System context lives in `docs/system-specs/` (`architecture.md`, `failure-modes.md`, `decisions.md`). Coding rules live in `.claude/rules/`.

- ~~[TASK-001: Scaffold the project and add CI](001-scaffold-and-ci.md) · depends on: none~~
- ~~[TASK-002: Message types and the hub](002-types-and-hub.md) · depends on: 001~~
- ~~[TASK-003: HTTP server and SSE stream](003-http-server.md) · depends on: 002~~
- ~~[TASK-004: Discord bot source](004-discord-source.md) · depends on: 002, 003~~
- [TASK-005: Railway deployment as code](005-railway-deploy.md) · depends on: 004

Not planned yet: the React + MUI frontend (designed separately with the impeccable skill), and the `FEATURE_ATTACHMENTS`, `FEATURE_EDITS_DELETES` and `DEBUG_PANEL` flags. Until the frontend exists, `GET /` returns a short plain-text page.
