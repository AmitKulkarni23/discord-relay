import { compareIds, type Msg } from './types.ts'
import { log } from './log.ts'

/** Receives each new message for the channel it subscribed to. */
export type Subscriber = (m: Msg) => void

type Channel = { buffer: Msg[]; subscribers: Set<Subscriber> }

/** The hub returned by `createHub`. */
export type Hub = ReturnType<typeof createHub>

/**
 * Creates a hub: a per-channel buffer of the latest `capacity` messages plus
 * publish/subscribe (the Observer pattern). Sources call `publish`; each open
 * browser stream calls `subscribe`. Create one per process, and a fresh one per test.
 */
export function createHub(capacity = 100) {
  const channels = new Map<string, Channel>()

  /** Returns the channel's state, creating it on first use. */
  function channel(channelId: string): Channel {
    let c = channels.get(channelId)
    if (!c) {
      c = { buffer: [], subscribers: new Set() }
      channels.set(channelId, c)
    }
    return c
  }

  return {
    /**
     * Stores a message in ID order and sends it to every subscriber of its channel. Ignores a
     * message whose ID is already buffered, so history and live events can overlap safely, and one
     * older than a full buffer, which would be evicted at once. Eviction always removes the oldest ID.
     * A throwing subscriber does not affect the others.
     */
    publish(msg: Msg): void {
      const c = channel(msg.channelId)
      // Walk back from the newest: a live message stops at the first comparison.
      let at = c.buffer.length
      for (; at > 0; at--) {
        const order = compareIds((c.buffer[at - 1] as Msg).id, msg.id)
        if (order === 0) return
        if (order < 0) break
      }
      if (at === 0 && c.buffer.length >= capacity) return

      c.buffer.splice(at, 0, msg)
      // shift() is O(n), fine at the 500 maximum; use a circular array if capacity grows to thousands
      if (c.buffer.length > capacity) c.buffer.shift()

      for (const fn of c.subscribers) {
        try {
          fn(msg)
        } catch (err) {
          log.warn('subscriber_failed', { channelId: msg.channelId, error: String(err) })
        }
      }
    },

    /**
     * Registers `fn` for new messages on a channel. Returns a function that
     * removes it; calling that more than once is harmless.
     */
    subscribe(channelId: string, fn: Subscriber): () => void {
      // Wrap so the same function can subscribe twice and still be removed one at a time.
      const entry: Subscriber = m => fn(m)
      const c = channel(channelId)
      c.subscribers.add(entry)
      return () => {
        c.subscribers.delete(entry)
      }
    },

    /** Returns a copy of the channel's buffered messages, oldest first. */
    recent(channelId: string): Msg[] {
      return [...(channels.get(channelId)?.buffer ?? [])]
    },

    /** Returns the number of subscribers across all channels. */
    subscriberCount(): number {
      let n = 0
      for (const c of channels.values()) n += c.subscribers.size
      return n
    },
  }
}
