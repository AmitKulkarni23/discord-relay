import type { ChannelInfo } from '../../backend/types.ts'
import { isRecord } from './messages.ts'

/** The browser's view of the /events stream and, once it is open, of the bot's Discord connection. */
export type Status = 'connecting' | 'live' | 'reconnecting' | 'discord' | 'channel' | 'full' | 'failed'

/** How long to wait after a 429 that does not say; matches what the server sends. */
const LIMIT_WAIT_MS = 30_000

/** Longest wait between reconnects. */
export const MAX_RETRY_MS = 30_000

/**
 * Returns how long to wait before a reconnect: a random point in a window that
 * doubles per attempt, so browsers dropped together do not come back together.
 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  return random() * Math.min(1000 * 2 ** attempt, MAX_RETRY_MS)
}

/** What the status chip says just after a reconnect: that the stream is back, and what `?since=` recovered. */
export function recoveredLabel(caughtUp: number): string {
  return caughtUp === 0 ? 'Back live' : `Back · ${caughtUp} caught up`
}

/**
 * Asks /events why a stream keeps failing, because EventSource hides the status code. Returns how long
 * to wait if the server is refusing this client's connection, or null for any other answer or failure.
 * A successful answer has opened a stream, so it is closed straight away.
 */
export async function limitWaitMs(
  url: string,
  signal: AbortSignal,
  get: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<number | null> {
  const probe = new AbortController()
  try {
    const res = await get(url, { signal: AbortSignal.any([signal, probe.signal]) })
    if (res.status !== 429) return null
    return Number(res.headers.get('Retry-After')) * 1000 || LIMIT_WAIT_MS
  } catch {
    return null
  } finally {
    probe.abort()
  }
}

/** Builds the /events URL. `since` is the newest ID held, so a reconnect gets only newer messages. */
export function eventsUrl(channel: string | null, since: string | null): string {
  const params = new URLSearchParams()
  if (channel) params.set('channel', channel)
  if (since) params.set('since', since)
  const query = params.toString()
  return query ? `/events?${query}` : '/events'
}

/** What the page needs from GET /config. */
export type PageConfig = { attachments: boolean; channels: ChannelInfo[] }

/**
 * Narrows the untrusted GET /config body. Anything unexpected falls back to
 * attachments off and no channels, and malformed channel entries are dropped.
 */
export function parseConfig(value: unknown): PageConfig {
  if (!isRecord(value)) return { attachments: false, channels: [] }
  const channels = Array.isArray(value.channels)
    ? value.channels.filter(
        (channel): channel is ChannelInfo => isRecord(channel) && typeof channel.id === 'string' && (channel.name === null || typeof channel.name === 'string'),
      )
    : []
  return { attachments: value.attachments === true, channels: channels.map(channel => ({ id: channel.id, name: channel.name })) }
}

/**
 * Reads GET /config, retrying with the stream's backoff until it answers: a 502 mid-deploy must not
 * leave the page without tabs, or stuck retrying a `?channel=` the server would answer 404 to.
 * Returns null once `signal` aborts.
 */
export async function fetchConfig(
  signal: AbortSignal,
  get: (url: string, init: RequestInit) => Promise<Response> = fetch,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<PageConfig | null> {
  for (let attempt = 0; !signal.aborted; attempt++) {
    try {
      const res = await get('/config', { signal })
      if (res.ok) return parseConfig(await res.json())
    } catch {
      // A network failure or a body that is not JSON: retry like any other failure.
    }
    await wait(retryDelay(attempt))
  }
  return null
}
