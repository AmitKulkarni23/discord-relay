/**
 * Railway infrastructure for DiscordRelay: one project, one service.
 * Railway does not read this file on deploy; apply changes with
 * `railway config plan` then `railway config apply`.
 *
 * DISCORD_TOKEN and CHANNEL_ID are set once in Railway, not in this file.
 * preserve() keeps their existing values; DISCORD_TOKEN should be a sealed variable.
 */
import { defineRailway, github, preserve, project, service } from 'railway/iac'

export default defineRailway(() => {
  const relay = service('discord-relay', {
    // checkSuites is Railway's "Wait for CI": deploys wait for GitHub Actions to pass.
    source: github('AmitKulkarni23/discord-relay', { branch: 'main', checkSuites: true }),
    build: {
      // Deploy only when runtime files change; docs, specs, rules and CI edits skip the deploy.
      watchPatterns: ['backend/**', 'frontend/**', 'package.json', 'bun.lock'],
    },
    deploy: {
      // Run the file directly so SIGTERM reaches the app (a package script would swallow it).
      startCommand: 'bun run backend/server.ts',
      // Returns 200 only once the Discord Gateway is connected.
      healthcheckPath: '/health',
      // One replica: each replica would run its own bot with its own buffer (decisions.md, D6).
      numReplicas: 1,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 10,
      // The bot must stay connected to Discord, so the service never sleeps.
      sleepApplication: false,
      // Keep the old deployment up while the new one starts, and give it time to close streams.
      overlapSeconds: 30,
      drainingSeconds: 30,
    },
    env: {
      DISCORD_TOKEN: preserve(),
      CHANNEL_ID: preserve(),
      // Messages kept per channel and loaded at startup, 1 to 500 (TASK-007).
      BUFFER_SIZE: '100',
      // Project token for reading Railway Feature Flags at runtime (backend/platform/flags.ts). Sealed; set once in Railway.
      // The flags themselves (attachments, edits-deletes) live in Project Settings → Feature Flags.
      RAILWAY_TOKEN: preserve(),
      // Bun.serve bundles the page in development mode (no minify, hot reload) unless this is set.
      NODE_ENV: 'production',
    },
  })

  return project('DiscordRelay', { resources: [relay] })
})
