import index from '../frontend/index.html'
import { loadConfig, type Config } from './config.ts'
import { createEventStreams, type EventStreamDeps } from './events.ts'
import { DEFAULT_FLAGS, startFlags, type Flags } from './flags.ts'
import { createHub } from './hub.ts'
import { errorMessage, log } from './log.ts'
import { startMetrics } from './metrics.ts'
import { startDiscord } from './sources/discord.ts'
import type { ChannelInfo } from './types.ts'

/** What `startServer` needs; passed in so tests can supply their own. */
export type ServerDeps = EventStreamDeps & {
  port: number
  /** Current feature flags; read on every /config request so a change in Railway applies without a redeploy. */
  flags: () => Flags
  /** Every relayed channel with its display name once loaded. */
  channels: () => ChannelInfo[]
}

/**
 * Starts the HTTP server: `/` (the React page), `/events` (SSE stream),
 * `/health` and `/config`. Returns the server URL and a `stop` function that
 * closes every open stream and stops listening.
 */
export function startServer(deps: ServerDeps): { url: URL; stop: () => void } {
  const { hub, channelIds, flags, isDiscordConnected, isChannelAvailable, channels } = deps
  const streams = createEventStreams(deps)
  const startedAt = Date.now()
  /** Reports Discord status and stream stats across channels; 503 when Discord is disconnected. */
  function health(): Response {
    const connected = isDiscordConnected()
    const buffered = channelIds.flatMap(id => hub.recent(id))
    const lastEventAt = buffered.reduce<string | null>((max, msg) => (max === null || msg.createdAt > max ? msg.createdAt : max), null)
    return Response.json(
      {
        discord: connected ? 'connected' : 'disconnected',
        clients: hub.subscriberCount(),
        buffered: buffered.length,
        lastEventAt,
        unavailableChannels: channelIds.filter(id => !isChannelAvailable(id)),
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      },
      { status: connected ? 200 : 503 },
    )
  }

  const server = Bun.serve({
    port: deps.port,
    routes: {
      // Bun bundles frontend/ from the HTML import (React + MUI, no separate build step).
      '/': index,
      '/events': (req, srv) => streams.handle(req, srv),
      '/health': () => health(),
      '/config': () => Response.json({ ...flags(), channels: channels() }),
    },
    fetch: () => new Response('Not found', { status: 404 }),
    // A route that throws is a bug: log it (counted as relay_http_errors_total) and fail only that request.
    error: err => {
      log.error('request_failed', { error: errorMessage(err), stack: err.stack })
      return new Response('Internal error', { status: 500 })
    },
  })

  return {
    url: server.url,
    stop() {
      streams.stop()
      server.stop()
    },
  }
}

/**
 * Entry point and the only place dependencies are wired: validates config,
 * creates the hub, starts the HTTP server and the Discord source, and shuts
 * down cleanly on SIGTERM. Exits with code 1 on invalid config. A login that
 * cannot work, such as a bad token, keeps the server up so the page can say so.
 */
export function main(): void {
  let config: Config
  try {
    config = loadConfig(process.env)
  } catch (err) {
    log.error('config_invalid', { error: errorMessage(err) })
    process.exit(1)
  }

  let readFlags = (): Flags => DEFAULT_FLAGS
  void startFlags(process.env).then(read => {
    readFlags = read
  })

  const hub = createHub(config.bufferSize)
  const discord = startDiscord({
    token: config.token,
    channelIds: config.channelIds,
    historyLimit: config.bufferSize,
    publish: hub.publish,
    remove: hub.remove,
    buffered: channelId => hub.recent(channelId).map(msg => msg.id),
    deletesEnabled: () => readFlags().editsDeletes,
    // Stay up: the page tells viewers the maintainer was notified, and relay_gateway_connected = 0 fires the Grafana alarm.
    onFatal: err => log.error('discord_login_failed', { error: errorMessage(err), hint: 'Check DISCORD_TOKEN and the MessageContent intent' }),
  })
  const server = startServer({
    port: config.port,
    hub,
    channelIds: config.channelIds,
    // Flags start at their defaults and switch to Railway's values once the SDK syncs, so startup never waits on it.
    flags: () => readFlags(),
    isDiscordConnected: discord.isConnected,
    isLoginFailed: discord.loginFailed,
    isChannelAvailable: discord.isChannelAvailable,
    channels: discord.channels,
  })
  log.info('server_started', { url: server.url.href })

  // Developer-only metrics, pushed to Grafana Cloud; nothing is served or shown on the page.
  const deployment = process.env.RAILWAY_DEPLOYMENT_ID ?? 'local'
  const stopMetrics = config.metrics ? startMetrics({ push: config.metrics, deployment, hub, isConnected: discord.isConnected }) : () => {}

  process.on('SIGTERM', async () => {
    log.info('shutdown', { signal: 'SIGTERM' })
    stopMetrics()
    server.stop()
    try {
      await discord.stop()
    } catch (err) {
      log.warn('shutdown_discord_stop_failed', { error: errorMessage(err) })
    }
    process.exit(0)
  })

  // Last resort: log anything nobody caught as one structured line, then exit so Railway restarts us.
  const crash = (kind: string) => (err: unknown) => {
    log.error('unhandled_error', { kind, error: errorMessage(err), stack: err instanceof Error ? err.stack : undefined })
    process.exit(1)
  }
  process.on('uncaughtException', crash('uncaughtException'))
  process.on('unhandledRejection', crash('unhandledRejection'))
}

if (import.meta.main) main()
