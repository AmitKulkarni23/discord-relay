/** GET /config: the page's one-time read of the channel list and feature flags. */
import type { ChannelInfo } from '../../backend/core/types.ts'
import { isRecord } from './messages.ts'
import { retryDelay } from './stream.ts'

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
