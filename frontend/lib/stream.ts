import type { ChannelInfo } from '../../backend/types.ts'
import { isRecord } from './messages.ts'

/** The browser's view of the /events stream and, once it is open, of the bot's Discord connection. */
export type Status = 'connecting' | 'live' | 'reconnecting' | 'discord'

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
export function parseConfig(v: unknown): PageConfig {
  if (!isRecord(v)) return { attachments: false, channels: [] }
  const channels = Array.isArray(v.channels)
    ? v.channels.filter((c): c is ChannelInfo => isRecord(c) && typeof c.id === 'string' && (c.name === null || typeof c.name === 'string'))
    : []
  return { attachments: v.attachments === true, channels: channels.map(c => ({ id: c.id, name: c.name })) }
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
