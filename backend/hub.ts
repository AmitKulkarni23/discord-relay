import type { Msg } from './types.ts'
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
     * Stores a message and sends it to every subscriber of its channel.
     * Ignores a message whose ID is already buffered, so history and live
     * events can overlap safely. A throwing subscriber does not affect the others.
     */
    publish(msg: Msg): void {
      const c = channel(msg.channelId)
      if (c.buffer.some(m => m.id === msg.id)) return

      c.buffer.push(msg)
      // ponytail: shift() is O(n), fine at 100; use a circular array if capacity grows to thousands
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
