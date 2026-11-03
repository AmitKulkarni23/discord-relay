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

/** Open /events streams allowed per client IP; past this, /events returns 429. */
export const MAX_CONNECTIONS_PER_IP = 20

/** Bytes a stream may have queued before its client counts as stalled and is dropped. */
const MAX_QUEUED_BYTES = 1024 * 1024

/** Formats a message as one SSE event whose `id:` is the Discord message ID. */
export function formatEvent(msg: Msg): string {
  return `id: ${msg.id}\ndata: ${JSON.stringify(msg)}\n\n`
}

const encoder = new TextEncoder()
const CONNECTED = encoder.encode(': connected\n\n')
const PING = encoder.encode(': ping\n\n')
/** Keyed by object, so a message's bytes are freed once it leaves the buffer and every queue. */
const encodedEvents = new WeakMap<Msg, Uint8Array>()

/**
 * Returns a message's SSE bytes, serializing it only the first time. Every stream
 * enqueues the same array, which is safe because default streams do not detach chunks.
 */
export function encodeEvent(msg: Msg): Uint8Array {
  let bytes = encodedEvents.get(msg)
  if (!bytes) {
    bytes = encoder.encode(formatEvent(msg))
    encodedEvents.set(msg, bytes)
  }
  return bytes
}

/**
 * Returns the IP to count a connection against. On Railway the socket address is the proxy's,
 * so the client comes from X-Real-IP, the header Railway documents for it. That is trustworthy
 * because Railway's proxy is the only ingress (this service has no TCP proxy). Without it
 * (local runs) the socket address is used.
 */
function clientIp(req: Request, server: Bun.Server<undefined>): string {
  return req.headers.get('x-real-ip') || (server.requestIP(req)?.address ?? 'unknown')
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
  /** Every open /events stream: pinged by the one timer below, closed by `stop`. */
  const openStreams = new Set<{ ping: () => void; close: () => void }>()
  /** Open /events streams per client IP. An entry is removed at zero, so this stays bounded by open streams. */
  const connectionsByIp = new Map<string, number>()
  const pingTimer = setInterval(() => {
    for (const stream of openStreams) stream.ping()
  }, pingMs)

  /**
   * Streams one channel's buffered messages, then each new one, with a ping
   * every `pingMs`. The channel comes from `?channel=` (untrusted, so only a
   * configured ID is accepted) or defaults to the first configured channel.
   * Unsubscribes when the browser disconnects or the server stops. Returns 429
   * past the per-IP cap, and drops a client that stops reading.
   */
  function events(req: Request, server: Bun.Server<undefined>): Response {
    const channelId = new URL(req.url).searchParams.get('channel') ?? defaultChannel
    if (!channelIds.includes(channelId)) return new Response('Unknown channel', { status: 404 })
    const ip = clientIp(req, server)
    const connections = connectionsByIp.get(ip) ?? 0
    if (connections >= MAX_CONNECTIONS_PER_IP) {
      log.debug('client_rejected', { reason: 'too many connections from one IP' })
      return new Response('Too many connections', { status: 429, headers: { 'Retry-After': '30' } })
    }
    connectionsByIp.set(ip, connections + 1)
    // Bun closes connections idle for 10 s by default; this stream must stay open.
    server.timeout(req, 0)
    let cleanup = () => {}

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // A write can throw if the browser went away before abort fired; treat that as a disconnect.
        const send = (bytes: Uint8Array) => {
          try {
            controller.enqueue(bytes)
          } catch {
            cleanup()
          }
        }
        // Live writes only: the replay is already bounded by the buffer and can exceed the limit on its own.
        const write = (bytes: Uint8Array) => {
          if ((controller.desiredSize ?? 0) >= 0) return send(bytes)
          log.warn('client_dropped', { reason: 'stopped reading', limitBytes: MAX_QUEUED_BYTES })
          cleanup()
          // error() frees the queue, where close() would keep it until the client read it all.
          controller.error(new Error('client stopped reading'))
          // Bun keeps the socket open for a client that is not reading until it times out.
          server.timeout(req, 1)
        }
        // Send something at once so headers flush even when the buffer is empty.
        send(CONNECTED)
        for (const m of hub.recent(channelId)) send(encodeEvent(m))
        const unsubscribe = hub.subscribe(channelId, m => write(encodeEvent(m)))

        let closed = false
        cleanup = () => {
          if (closed) return
          closed = true
          unsubscribe()
          openStreams.delete(open)
          const left = (connectionsByIp.get(ip) ?? 1) - 1
          if (left > 0) connectionsByIp.set(ip, left)
          else connectionsByIp.delete(ip)
          log.debug('client_disconnected', { clients: hub.subscriberCount() })
        }
        const close = () => {
          cleanup()
          controller.close()
        }

        const open = { ping: () => write(PING), close }
        openStreams.add(open)
        req.signal.addEventListener('abort', cleanup)
        log.debug('client_connected', { clients: hub.subscriberCount() })
      },
      cancel() {
        cleanup()
      },
    }, new ByteLengthQueuingStrategy({ highWaterMark: MAX_QUEUED_BYTES }))

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
      clearInterval(pingTimer)
      for (const stream of [...openStreams]) stream.close()
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
