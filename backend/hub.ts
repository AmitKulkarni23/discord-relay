import { compareIds, type Msg } from './types.ts'
import { log } from './log.ts'

/** Receives each new message for the channel it subscribed to. */
export type Subscriber = (m: Msg) => void

/** Told the ID of each message deleted from the channel it subscribed to. */
export type RemoveSubscriber = (id: string) => void

/** Deleted IDs remembered per channel, as many as a browser can hold. */
const MAX_REMOVED = 500

type Channel = {
  buffer: Msg[]
  subscribers: Set<{ onMessage: Subscriber; onRemove: RemoveSubscriber }>
  /** Recently deleted IDs, oldest first: replayed to reconnecting browsers, and never published again. */
  removed: Set<string>
}

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
      c = { buffer: [], subscribers: new Set(), removed: new Set() }
      channels.set(channelId, c)
    }
    return c
  }

  /** Calls every subscriber; one that throws does not affect the others. */
  function notify(c: Channel, channelId: string, call: (subscriber: { onMessage: Subscriber; onRemove: RemoveSubscriber }) => void): void {
    for (const subscriber of c.subscribers) {
      try {
        call(subscriber)
      } catch (err) {
        log.warn('subscriber_failed', { channelId, error: String(err) })
      }
    }
  }

  return {
    /**
     * Stores a message in ID order and sends it to every subscriber of its channel. Ignores a
     * message whose ID is already buffered, so history and live events can overlap safely, and one
     * older than a full buffer, which would be evicted at once, or one already deleted, which a history
     * fetch that started earlier can still return. Eviction always removes the oldest ID.
     */
    publish(msg: Msg): void {
      const c = channel(msg.channelId)
      if (c.removed.has(msg.id)) return
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

      notify(c, msg.channelId, s => s.onMessage(msg))
    },

    /**
     * Deletes a message from the buffer and tells every subscriber of its channel. They hear about it
     * even if it has left the buffer, because an open page holds more than the server does.
     */
    remove(channelId: string, id: string): void {
      const c = channel(channelId)
      if (c.removed.has(id)) return
      c.removed.add(id)
      for (const oldest of c.removed) {
        if (c.removed.size <= MAX_REMOVED) break
        c.removed.delete(oldest)
      }
      const at = c.buffer.findIndex(m => m.id === id)
      if (at !== -1) c.buffer.splice(at, 1)
      notify(c, channelId, s => s.onRemove(id))
    },

    /** Returns the channel's recently deleted IDs, oldest first. */
    removed(channelId: string): string[] {
      return [...(channels.get(channelId)?.removed ?? [])]
    },

    /**
     * Registers `fn` for new messages on a channel and `onRemove` for deleted ones. Returns a
     * function that removes them; calling that more than once is harmless.
     */
    subscribe(channelId: string, fn: Subscriber, onRemove: RemoveSubscriber = () => {}): () => void {
      // A new object each time, so the same function can subscribe twice and still be removed one at a time.
      const entry = { onMessage: fn, onRemove }
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
