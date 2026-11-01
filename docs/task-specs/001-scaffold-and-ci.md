# Task 001: Scaffold the project and add CI

## Summary

Set up the Bun + TypeScript project and a GitHub Actions workflow that typechecks and tests every push and pull request. Railway's "Wait for CI" (task 005) holds each deploy until this workflow passes, so a broken commit never reaches the live URL. See "Railway deployment" in `docs/system-specs/architecture.md`.

## Conventions

Read these before writing code:

- `CLAUDE.md`
- `.claude/rules/typescript.rules.md`
- `.claude/rules/testing.rules.md`

## Requirements

### Project

1. `package.json` MUST be at the repo root, with `"type": "module"` and `"private": true`.
2. It MUST define these scripts:
   - `dev`: `bun --hot backend/server.ts`
   - `start`: `bun run backend/server.ts`
   - `typecheck`: `tsc --noEmit`
   - `test`: `bun test --pass-with-no-tests`
3. `typescript` and `@types/bun` MUST be dev dependencies. No other dependencies are added in this task.
4. `tsconfig.json` MUST enable `strict`, `noUncheckedIndexedAccess` and `noEmit`, target ESNext modules with `"moduleResolution": "bundler"`, and include `backend/**/*.ts`.
5. `bun.lock` MUST be committed so CI and Railway install the same versions.

### CI

6. `.github/workflows/ci.yml` MUST run on every push and pull request.
7. The job MUST check out the code, install Bun with `oven-sh/setup-bun`, run `bun install --frozen-lockfile`, then `bun run typecheck` and `bun run test`.
8. The workflow MUST fail if either step fails.

## Technical notes

- `bun test` exits with an error when there are no test files. `--pass-with-no-tests` keeps CI green until task 002 adds the first test.
- Railway only waits on GitHub Actions check suites, so CI has to live in GitHub Actions.

## TDD plan

### RED

No unit tests: this task adds configuration only. The checks are `bun run typecheck` and `bun run test` passing locally and in CI.

### GREEN

1. `package.json` and `bun.lock`
2. `tsconfig.json`
3. `.github/workflows/ci.yml`

### REFACTOR

None expected.

## Dependencies

None.

## Files to create or modify

- `package.json` (create)
- `bun.lock` (create, generated)
- `tsconfig.json` (create)
- `.github/workflows/ci.yml` (create)

## Acceptance criteria

- [ ] `bun install`, `bun run typecheck` and `bun run test` succeed locally
- [ ] The CI workflow runs on push and passes on GitHub
- [ ] `bun.lock` is committed

## Spec updates

None.
