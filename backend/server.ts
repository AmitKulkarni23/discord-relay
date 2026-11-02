import index from '../frontend/index.html'
import { loadConfig, type Config } from './config.ts'
import { DEFAULT_FLAGS, startFlags, type Flags } from './flags.ts'
import { createHub, type Hub } from './hub.ts'
import { log } from './log.ts'
import { startDiscord } from './sources/discord.ts'
import type { ChannelInfo, Msg } from './types.ts'

/** What `startServer` needs; passed in so tests can supply their own. */
export type ServerDeps = {
  port: number
  hub: Hub
  /** The channels this server relays; the first is the default for /events. */
  channelIds: string[]
  /** Current feature flags; read on every /config request so a change in Railway applies without a redeploy. */
  flags: () => Flags
  isDiscordConnected: () => boolean
  /** Every relayed channel with its display name once loaded. */
  channels: () => ChannelInfo[]
  /** Heartbeat interval for /events. Railway closes streams idle for 5 minutes. */
  pingMs?: number
}

/** Formats a message as one SSE event whose `id:` is the Discord message ID. */
export function formatEvent(msg: Msg): string {
  return `id: ${msg.id}\ndata: ${JSON.stringify(msg)}\n\n`
}

/**
 * Starts the HTTP server: `/` (the React page), `/events` (SSE stream),
 * `/health` and `/config`. Returns the server URL and a `stop` function that
 * closes every open stream and stops listening.
 */
export function startServer(deps: ServerDeps): { url: URL; stop: () => void } {
  const { hub, channelIds, flags, isDiscordConnected, channels, pingMs = 25_000 } = deps
  const first = channelIds[0]
  if (first === undefined) throw new Error('startServer needs at least one channel')
  const defaultChannel: string = first
  const startedAt = Date.now()
  const encoder = new TextEncoder()
  /** One close function per open /events stream, used by `stop`. */
  const openStreams = new Set<() => void>()

  /**
   * Streams one channel's buffered messages, then each new one, with a ping
   * every `pingMs`. The channel comes from `?channel=` (untrusted, so only a
   * configured ID is accepted) or defaults to the first configured channel.
   * Unsubscribes when the browser disconnects or the server stops.
   */
  function events(req: Request, server: Bun.Server<undefined>): Response {
    const channelId = new URL(req.url).searchParams.get('channel') ?? defaultChannel
    if (!channelIds.includes(channelId)) return new Response('Unknown channel', { status: 404 })
    // Bun closes connections idle for 10 s by default; this stream must stay open.
    server.timeout(req, 0)
    let cleanup = () => {}

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // A write can throw if the browser went away before abort fired; treat that as a disconnect.
        const write = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text))
          } catch {
            cleanup()
          }
        }
        // Send something at once so headers flush even when the buffer is empty.
        write(': connected\n\n')
        for (const m of hub.recent(channelId)) write(formatEvent(m))
        const unsubscribe = hub.subscribe(channelId, m => write(formatEvent(m)))
        const ping = setInterval(() => write(': ping\n\n'), pingMs)

        let closed = false
        cleanup = () => {
          if (closed) return
          closed = true
          unsubscribe()
          clearInterval(ping)
          openStreams.delete(close)
          log.debug('client_disconnected', { clients: hub.subscriberCount() })
        }
        const close = () => {
          cleanup()
          controller.close()
        }

        openStreams.add(close)
        req.signal.addEventListener('abort', cleanup)
        log.debug('client_connected', { clients: hub.subscriberCount() })
      },
      cancel() {
        cleanup()
      },
    })

    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    })
  }

  /** Reports Discord status and stream stats across channels; 503 when Discord is disconnected. */
  function health(): Response {
    const connected = isDiscordConnected()
    const buffered = channelIds.flatMap(id => hub.recent(id))
    const lastEventAt = buffered.reduce<string | null>((max, m) => (max === null || m.createdAt > max ? m.createdAt : max), null)
    return Response.json(
      {
        discord: connected ? 'connected' : 'disconnected',
        clients: hub.subscriberCount(),
        buffered: buffered.length,
        lastEventAt,
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
      '/events': (req, srv) => events(req, srv),
      '/health': () => health(),
      '/config': () => Response.json({ ...flags(), channels: channels() }),
    },
    fetch: () => new Response('Not found', { status: 404 }),
  })

  return {
    url: server.url,
    stop() {
      for (const close of [...openStreams]) close()
      server.stop()
    },
  }
}

/**
 * Entry point and the only place dependencies are wired: validates config,
 * creates the hub, starts the HTTP server and the Discord source, and shuts
 * down cleanly on SIGTERM. Exits with code 1 on invalid config, a failed
 * login, or a Gateway that stays down past the watchdog limit.
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
    onWatchdogExpired: () => {
      log.error('watchdog_expired', { reason: 'Gateway disconnected for more than 5 minutes; exiting so Railway restarts us' })
      process.exit(1)
    },
  })
  const server = startServer({
    port: config.port,
    hub,
    channelIds: config.channelIds,
    // Flags start at their defaults and switch to Railway's values once the SDK syncs, so startup never waits on it.
    flags: () => readFlags(),
    isDiscordConnected: discord.isConnected,
    channels: discord.channels,
  })
  log.info('server_started', { url: server.url.href })

  discord.login.catch(err => {
    log.error('discord_login_failed', { error: errorMessage(err) })
    process.exit(1)
  })

  process.on('SIGTERM', async () => {
    log.info('shutdown', { signal: 'SIGTERM' })
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

/** Returns an error's message, or the value as a string. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

if (import.meta.main) main()
