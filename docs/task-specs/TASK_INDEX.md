# Task index

Work through the tasks in order. Pick the first task that is not struck through and whose dependencies are struck through, read its spec, and follow it. When every acceptance criterion is met, strike the line through here (`~~...~~`) in the same commit as the task's last change.

System context lives in `docs/system-specs/` (`architecture.md`, `failure-modes.md`, `decisions.md`). Coding rules live in `.claude/rules/`.

- ~~[TASK-001: Scaffold the project and add CI](001-scaffold-and-ci.md) · depends on: none~~
- ~~[TASK-002: Message types and the hub](002-types-and-hub.md) · depends on: 001~~
- ~~[TASK-003: HTTP server and SSE stream](003-http-server.md) · depends on: 002~~
- ~~[TASK-004: Discord bot source](004-discord-source.md) · depends on: 002, 003~~
- ~~[TASK-005: Railway deployment as code](005-railway-deploy.md) · depends on: 004~~
- ~~[TASK-006: React + MUI live feed page](006-frontend.md) · depends on: 003~~
- ~~[TASK-007: Buffer size as a Railway variable](007-buffer-size.md) · depends on: 004~~
- [TASK-008: Multiple channels](008-multiple-channels.md) · depends on: 006, 007
- ~~[TASK-009: Attachments](009-attachments.md) · depends on: 006~~

Not planned yet: everything in `docs/todo.md` (attachment follow-ups, live edits behind the `edits-deletes` flag, load testing, dashboards and alarms).
