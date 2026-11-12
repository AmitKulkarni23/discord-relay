import type { Hub } from '../core/hub.ts'
import { log } from '../platform/log.ts'
import type { Msg } from '../core/types.ts'

/** What `createEventStreams` needs; passed in so tests can supply their own. */
export type EventStreamDeps = {
  hub: Hub
  /** The channels this server relays; the first is the default for /events. */
  channelIds: string[]
  isDiscordConnected: () => boolean
  /** True after a login that needs a person to fix it, such as a revoked token. */
  isLoginFailed: () => boolean
  /** False while the bot cannot load a channel, usually for lack of access. */
  isChannelAvailable: (channelId: string) => boolean
  /** Heartbeat interval. Railway closes streams idle for 5 minutes. */
  pingMs?: number
}

/** Every open /events stream, as `createEventStreams` returns it. */
export type EventStreams = {
  /** Answers one GET /events. */
  handle(req: Request, server: Bun.Server<undefined>): Response
  /** Closes every open stream and stops the timers. */
  stop(): void
}

/** Open /events streams allowed per client IP; past this, /events returns 429. */
export const MAX_CONNECTIONS_PER_IP = 20

/** How long a refused client should wait before trying again. */
const RETRY_AFTER_SEC = 30

/**
 * Bytes a stream may have queued before its client counts as stalled and is dropped.
 *
 * A stream's queue holds bytes enqueued but not yet sent to the browser. ByteLengthQueuingStrategy
 * measures it in bytes; CountQueuingStrategy, the other built-in one, counts chunks, so a ping and a
 * 50 KB message would weigh the same, and memory is about bytes. This limit is its highWaterMark,
 * and the stream reports `desiredSize = highWaterMark - bytes queued`:
 *
 *   queued 0       -> desiredSize 1 MiB      the browser is keeping up
 *   queued 600 KB  -> desiredSize ~400 KB    some backlog
 *   queued 1.2 MB  -> desiredSize negative   past the mark
 *
 * enqueue() never refuses data: the mark is only a hint. So a live write checks desiredSize itself
 * and drops the client once it is negative, instead of letting one stalled browser grow memory forever.
 */
const MAX_QUEUED_BYTES = 1024 * 1024

/** Formats a message as one SSE event whose `id:` is the Discord message ID. */
export function formatEvent(msg: Msg): string {
  return `id: ${msg.id}\ndata: ${JSON.stringify(msg)}\n\n`
}

const encoder = new TextEncoder()
const CONNECTED = encoder.encode(': connected\n\n')
// A named event, not a comment: EventSource hides comments, and the page needs to see these to notice a dead stream.
const PING = encoder.encode('event: ping\ndata: 1\n\n')
type DiscordState = 'connected' | 'disconnected' | 'unavailable' | 'failed'
const DISCORD_EVENTS: Record<DiscordState, Uint8Array> = {
  connected: encoder.encode('event: discord\ndata: connected\n\n'),
  disconnected: encoder.encode('event: discord\ndata: disconnected\n\n'),
  unavailable: encoder.encode('event: discord\ndata: unavailable\n\n'),
  failed: encoder.encode('event: discord\ndata: failed\n\n'),
}
/** How often the server checks the Gateway and each channel, to tell open pages when one changes. */
const DISCORD_CHECK_MS = 1000
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

/** Formats a deletion as a named SSE event. It has no `id:`, because a deletion is not a position in the stream. */
function deleteEvent(id: string, channelId: string): Uint8Array {
  return encoder.encode(`event: delete\ndata: ${JSON.stringify({ id, channelId })}\n\n`)
}

/** Reads ?since=, an untrusted message ID. Anything else is 0, which every ID is newer than, so the full buffer is sent. */
function parseSince(value: string | null): bigint {
  return value && /^\d{1,20}$/.test(value) ? BigInt(value) : 0n
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

/** One accepted client of GET /events. */
type StreamClient = {
  req: Request
  server: Bun.Server<undefined>
  channelId: string
  /** Only messages newer than this ID are sent; 0 means all of them. */
  since: bigint
  ip: string
  /** Railway's ID for this request, also in its network logs. Null on local runs. */
  requestId: string | null
}

/**
 * Owns GET /events: one SSE stream per browser, its limits, and the timers that keep them all informed.
 */
export function createEventStreams(deps: EventStreamDeps): EventStreams {
  const { hub, channelIds, isDiscordConnected, isLoginFailed, isChannelAvailable, pingMs = 25_000 } = deps
  const defaultChannel = channelIds[0]
  if (defaultChannel === undefined) throw new Error('startServer needs at least one channel')
  /** Every open /events stream: pinged by the one timer below, closed by `stop`. */
  const openStreams = new Set<{ channelId: string; write: (bytes: Uint8Array) => void; close: () => void }>()
  /** Open /events streams per client IP. An entry is removed at zero, so this stays bounded by open streams. */
  const connectionsByIp = new Map<string, number>()
  const pingTimer = setInterval(() => {
    for (const stream of openStreams) stream.write(PING)
  }, pingMs)
  /** What a page on this channel should say. A lost Gateway comes first, because it explains everything else. */
  const discordState = (channelId: string): DiscordState => {
    if (!isDiscordConnected()) return isLoginFailed() ? 'failed' : 'disconnected'
    return isChannelAvailable(channelId) ? 'connected' : 'unavailable'
  }
  const lastState = new Map(channelIds.map(id => [id, discordState(id)]))
  const discordTimer = setInterval(() => {
    for (const id of channelIds) {
      const state = discordState(id)
      if (state === lastState.get(id)) continue
      lastState.set(id, state)
      for (const stream of openStreams) if (stream.channelId === id) stream.write(DISCORD_EVENTS[state])
    }
  }, DISCORD_CHECK_MS)

  /** Builds the response for one accepted client: its replay, then live events until it leaves or falls too far behind. */
  const openStream = ({ req, server, channelId, since, ip, requestId }: StreamClient): Response => {
    // Newer than the newest message the browser already holds (?since=); every message when since is 0. BigInt, because IDs pass 2^53.
    const isNew = (m: Msg) => BigInt(m.id) > since
    let cleanup = () => {}

    const stream = new ReadableStream<Uint8Array>(
      {
        // `controller` is the ReadableStream's handle for this one response, made by the constructor and passed in
        // here (a ReadableStreamDefaultController): enqueue() adds bytes to the queue, close() and error() end the stream.
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
            log.warn('client_dropped', { requestId, reason: 'stopped reading', limitBytes: MAX_QUEUED_BYTES })
            cleanup()
            // error() frees the queue, where close() would keep it until the client read it all.
            controller.error(new Error('client stopped reading'))
            // Bun keeps the socket open for a client that is not reading until it times out.
            server.timeout(req, 1)
          }
          // Send something at once so headers flush even when the buffer is empty.
          send(CONNECTED)
          send(DISCORD_EVENTS[discordState(channelId)])
          // A reconnecting page may still show messages deleted while it was offline: it missed those delete
          // events, so they are replayed before the messages. A brand-new page (no since) holds nothing, so it is skipped.
          if (since > 0n) for (const id of hub.removed(channelId)) send(deleteEvent(id, channelId))
          // A new page needs something to show: replay the buffer (only messages newer than ?since= when
          // reconnecting), then go live. Without it, a new visitor would see an empty page until someone posted.
          for (const msg of hub.recent(channelId).filter(isNew)) send(encodeEvent(msg))
          // Registers this stream for the channel's live messages and deletes. `unsubscribe` removes it again; cleanup
          // calls it when the browser leaves, or the hub would keep writing to a dead stream and over-count clients.
          // A restarted server refills its buffer through publish, so a live message can be one the browser holds.
          const unsubscribe = hub.subscribe(
            channelId,
            msg => {
              if (isNew(msg)) write(encodeEvent(msg))
            },
            id => write(deleteEvent(id, channelId)),
          )

          let closed = false
          cleanup = () => {
            if (closed) return
            closed = true
            unsubscribe()
            openStreams.delete(open)
            const left = (connectionsByIp.get(ip) ?? 1) - 1
            if (left > 0) connectionsByIp.set(ip, left)
            else connectionsByIp.delete(ip)
            log.debug('client_disconnected', { requestId, clients: hub.subscriberCount() })
          }
          const close = () => {
            cleanup()
            controller.close()
          }

          const open = { channelId, write, close }
          openStreams.add(open)
          req.signal.addEventListener('abort', cleanup)
          log.debug('client_connected', { requestId, clients: hub.subscriberCount() })
        },
        cancel() {
          cleanup()
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: MAX_QUEUED_BYTES }),
    )

    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    })
  }

  /**
   * Streams one channel's buffered messages, then each new one, with a ping
   * every `pingMs`. The channel comes from `?channel=` (untrusted, so only a
   * configured ID is accepted) or defaults to the first configured channel.
   * A reconnecting browser passes `?since=` with the newest ID it holds and gets only newer messages.
   * Unsubscribes when the browser disconnects or the server stops. Returns 429
   * past the per-IP cap, and drops a client that stops reading.
   */
  const handle = (req: Request, server: Bun.Server<undefined>): Response => {
    // Railway's ID for this request, also in its network logs. Null on local runs.
    const requestId = req.headers.get('x-railway-request-id')
    const params = new URL(req.url).searchParams
    const channelId = params.get('channel') ?? defaultChannel
    if (!channelIds.includes(channelId)) return new Response('Unknown channel', { status: 404 })
    const since = parseSince(params.get('since'))
    const ip = clientIp(req, server)
    const connections = connectionsByIp.get(ip) ?? 0
    if (connections >= MAX_CONNECTIONS_PER_IP) {
      log.debug('client_rejected', { requestId, reason: 'too many connections from one IP' })
      return new Response('Too many connections', { status: 429, headers: { 'Retry-After': String(RETRY_AFTER_SEC) } })
    }
    connectionsByIp.set(ip, connections + 1)
    // Bun closes connections idle for 10 s by default; this stream must stay open.
    server.timeout(req, 0)
    return openStream({ req, server, channelId, since, ip, requestId })
  }

  return {
    handle,
    stop() {
      clearInterval(pingTimer)
      clearInterval(discordTimer)
      for (const stream of [...openStreams]) stream.close()
    },
  }
}
