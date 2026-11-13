/**
 * Pure helpers for the /events stream, used by use-event-stream.ts: the Status type, reconnect
 * backoff, the /events URL, and asking the server why a stream keeps failing.
 */
/**
 * The browser's view of the /events stream and, once it is open, of the bot's Discord connection.
 * The status chip and the empty feed both show it.
 *
 * - `connecting`: first page load or a channel switch, before the stream opens.
 * - `live`: the stream is open and the bot is connected to Discord. The normal state.
 * - `reconnecting`: the stream dropped (a deploy, Wi-Fi blip, laptop sleep) and the page is retrying with backoff.
 * - `discord`: the stream is open, but the bot lost its Gateway connection and discord.js is reconnecting.
 * - `channel`: the stream is open, but the bot cannot read this channel (missing permission, channel deleted).
 * - `full`: the server answered 429: more than 20 streams from this IP. The page waits as told by Retry-After.
 * - `failed`: the bot's login was refused (revoked token, missing intent). Retrying cannot fix it; a person must.
 */
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
