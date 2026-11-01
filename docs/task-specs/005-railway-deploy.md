# Task 005: Railway deployment as code

## Summary

Describe the Railway service in `.railway/railway.ts` with the settings from "Railway deployment" in `docs/system-specs/architecture.md`: GitHub source on `main` with Wait for CI, start command, healthcheck, restart policy, sleeping off, one replica, overlap and draining. Values that only the user can provide are placeholders. See D9 and D10 in `docs/system-specs/decisions.md`.

## Conventions

Read these before writing code:

- `CLAUDE.md`: Infrastructure as Code, Environment variables
- `docs/system-specs/architecture.md`: Railway deployment, Configuration
- `.claude/rules/typescript.rules.md`

## Requirements

1. `.railway/railway.ts` MUST define one project with one service using `defineRailway`, `project` and `service` from `railway/iac`.
2. The service source MUST be `github('AmitKulkarni23/discord-relay', { branch: 'main', checkSuites: true })`. `checkSuites` is Railway's "Wait for CI".
3. Deploy settings MUST be: start command `bun run backend/server.ts`, healthcheck path `/health`, 1 replica, restart policy `ON_FAILURE` with 10 retries, `sleepApplication: false`, `overlapSeconds: 30`, `drainingSeconds: 30`.
4. `DISCORD_TOKEN` MUST use `preserve()`, so its value is set once as a sealed variable in Railway and never appears in the repo.
5. `CHANNEL_ID` MUST also use `preserve()`, so the channel ID stays out of the repo. The three feature flags MUST be `"false"`.
6. The project name MUST be `DiscordRelay`.
7. `railway` MUST be a dev dependency so the file typechecks, and `tsconfig.json` MUST include `.railway/**/*.ts`.
8. `.railway/README.md` from `railway config init` MAY be kept.

## Technical notes

- The SDK types come from the `railway` npm package (`railway/iac`). `DeployConfig` holds `startCommand`, `healthcheckPath`, `numReplicas`, `restartPolicyType`, `restartPolicyMaxRetries`, `sleepApplication`, `overlapSeconds` and `drainingSeconds`.
- Railway does not read `.railway/` during deploys. Changes reach Railway only through `railway config plan` and `railway config apply`.
- A whole-project apply can delete resources missing from the file. Generate the public domain in the dashboard, then run `railway config pull` and compare before the next apply.
- The user fills in the placeholders and runs these steps (no code changes):
  1. Create the Discord application and bot, enable the MessageContent intent, invite the bot to the test server, and copy the channel ID.
  2. Create the Railway project, link it with `railway link`, set `DISCORD_TOKEN` as a sealed variable and set `CHANNEL_ID`.
  3. Run `railway config plan` and `railway config apply`.
  4. Generate a Railway domain for the service.
  5. Turn off PR environments in project settings.

## TDD plan

### RED

No unit tests: this task is configuration. `bun run typecheck` checks the file against the SDK types.

### GREEN

1. Add `railway` as a dev dependency and include `.railway` in `tsconfig.json`
2. `.railway/railway.ts`

### REFACTOR

None expected.

## Dependencies

- TASK-004: a deployable server with a working `/health`.

## Files to create or modify

- `package.json`, `bun.lock` (modify: add `railway`)
- `tsconfig.json` (modify: include `.railway`)
- `.railway/railway.ts` (create)
- `.railway/README.md` (create, optional)

## Acceptance criteria

- [ ] `bun run typecheck` passes with `.railway/railway.ts` included
- [ ] All settings in requirement 3 match "Railway deployment" in `architecture.md`
- [ ] No secret values in the file

## Spec updates

None.
