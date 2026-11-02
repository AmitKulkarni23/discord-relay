import index from '../frontend/index.html'
import { createHub, type Hub } from './hub.ts'
import { log } from './log.ts'
import { startDiscord } from './sources/discord.ts'
import type { Msg } from './types.ts'

/** Feature flags, exposed to the browser through GET /config. */
export type Flags = { attachments: boolean; editsDeletes: boolean; debugPanel: boolean }

/** Everything the process needs from its environment. */
export type Config = { token: string; channelId: string; port: number; flags: Flags }

/** What `startServer` needs; passed in so tests can supply their own. */
export type ServerDeps = {
  port: number
  hub: Hub
  channelId: string
  flags: Flags
  isDiscordConnected: () => boolean
  /** The channel's display name, or null until the bot has loaded the channel. */
  channelName: () => string | null
  /** Heartbeat interval for /events. Railway closes streams idle for 5 minutes. */
  pingMs?: number
}

/**
 * Reads and validates config from an env object (normally `process.env`).
 * Throws an error naming the variable when a required one is missing or invalid.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const token = env.DISCORD_TOKEN
  if (!token) throw new Error('DISCORD_TOKEN is required')
  const channelId = env.CHANNEL_ID
  if (!channelId) throw new Error('CHANNEL_ID is required')

  const port = env.PORT ? Number(env.PORT) : 3000
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a port number, got "${env.PORT}"`)
  }

  return {
    token,
    channelId,
    port,
    flags: {
      attachments: env.FEATURE_ATTACHMENTS === 'true',
      editsDeletes: env.FEATURE_EDITS_DELETES === 'true',
      debugPanel: env.DEBUG_PANEL === 'true',
    },
  }
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
  const { hub, channelId, flags, isDiscordConnected, channelName, pingMs = 25_000 } = deps
  const startedAt = Date.now()
  const encoder = new TextEncoder()
  /** One close function per open /events stream, used by `stop`. */
  const openStreams = new Set<() => void>()

  /**
   * Streams the channel's buffered messages, then each new one, with a ping
   * every `pingMs`. Unsubscribes when the browser disconnects or the server stops.
   */
  function events(req: Request, server: Bun.Server<undefined>): Response {
    // Bun closes connections idle for 10 s by default; this stream must stay open.
    server.timeout(req, 0)
    let cleanup = () => {}

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (text: string) => controller.enqueue(encoder.encode(text))
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

  /** Reports Discord status and stream stats; 503 when Discord is disconnected. */
  function health(): Response {
    const connected = isDiscordConnected()
    const buffered = hub.recent(channelId)
    return Response.json(
      {
        discord: connected ? 'connected' : 'disconnected',
        clients: hub.subscriberCount(),
        buffered: buffered.length,
        lastEventAt: buffered.at(-1)?.createdAt ?? null,
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
      '/config': () => Response.json({ ...flags, channelName: channelName() }),
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

  const hub = createHub()
  const discord = startDiscord({
    token: config.token,
    channelId: config.channelId,
    publish: hub.publish,
    onWatchdogExpired: () => {
      log.error('watchdog_expired', { reason: 'Gateway disconnected for more than 5 minutes; exiting so Railway restarts us' })
      process.exit(1)
    },
  })
  const server = startServer({
    port: config.port,
    hub,
    channelId: config.channelId,
    flags: config.flags,
    isDiscordConnected: discord.isConnected,
    channelName: discord.channelName,
  })
  log.info('server_started', { url: server.url.href })

  discord.login.catch(err => {
    log.error('discord_login_failed', { error: errorMessage(err) })
    process.exit(1)
  })

  process.on('SIGTERM', async () => {
    log.info('shutdown', { signal: 'SIGTERM' })
    server.stop()
    await discord.stop()
    process.exit(0)
  })
}

/** Returns an error's message, or the value as a string. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

if (import.meta.main) main()
