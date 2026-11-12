import { compareIds, type Msg } from './types.ts'
import { errorMessage, log } from '../platform/log.ts'

/** Receives each new message for the channel it subscribed to. */
export type Subscriber = (msg: Msg) => void

/** Told the ID of each message deleted from the channel it subscribed to. */
export type RemoveSubscriber = (id: string) => void

/** One open stream's callbacks. */
type Subscription = { onMessage: Subscriber; onRemove: RemoveSubscriber }

/** Deleted IDs remembered per channel, as many as a browser can hold. */
const MAX_REMOVED = 500

type ChannelState = {
  buffer: Msg[]
  subscribers: Set<Subscription>
  /** Recently deleted IDs, oldest first: replayed to reconnecting browsers, and never published again. */
  removed: Set<string>
}

/** Holds each channel's latest messages and passes changes to its open streams. */
export type Hub = {
  /** Stores a message and sends it to every subscriber of its channel, unless it is a duplicate, too old or deleted. */
  publish(msg: Msg): void
  /** Deletes a message and tells every subscriber of its channel. */
  remove(channelId: string, id: string): void
  /** Returns the channel's recently deleted IDs, oldest first. */
  removed(channelId: string): string[]
  /** Registers callbacks for a channel. Returns a function that removes them; calling that more than once is harmless. */
  subscribe(channelId: string, fn: Subscriber, onRemove?: RemoveSubscriber): () => void
  /** Returns a copy of the channel's buffered messages, oldest first. */
  recent(channelId: string): Msg[]
  /** Returns the number of subscribers across all channels. */
  subscriberCount(): number
  /** Returns how many new messages were stored since the hub was created, history included; duplicates do not count. */
  publishedTotal(): number
}

/**
 * Creates a hub: a per-channel buffer of the latest `capacity` messages plus
 * publish/subscribe (the Observer pattern). Sources call `publish`; each open
 * browser stream calls `subscribe`. Create one per process, and a fresh one per test.
 */
export function createHub(capacity = 100): Hub {
  const channels = new Map<string, ChannelState>()
  let published = 0

  /** Returns the channel's state, creating it on first use. */
  function getChannelState(channelId: string): ChannelState {
    let channel = channels.get(channelId)
    if (!channel) {
      channel = { buffer: [], subscribers: new Set(), removed: new Set() }
      channels.set(channelId, channel)
    }
    return channel
  }

  /** Calls every subscriber; one that throws does not affect the others. */
  function notify(channel: ChannelState, channelId: string, call: (subscriber: Subscription) => void): void {
    for (const subscriber of channel.subscribers) {
      try {
        call(subscriber)
      } catch (err) {
        log.warn('subscriber_failed', { channelId, error: errorMessage(err) })
      }
    }
  }

  return {
    /** Stores a message in ID order and sends it to every subscriber of its channel. Eviction always removes the oldest ID. */
    publish(msg) {
      const channel = getChannelState(msg.channelId)
      // Already deleted: a history fetch that started before the delete can still return it.
      if (channel.removed.has(msg.id)) return
      // Walk back from the newest: a live message stops at the first comparison.
      let at = channel.buffer.length
      for (; at > 0; at--) {
        const existing = channel.buffer[at - 1]
        if (!existing) break
        const cmp = compareIds(existing.id, msg.id)
        // Already buffered: a history reload after a reconnect overlaps the live events, so duplicates are normal.
        if (cmp === 0) return
        if (cmp < 0) break
      }
      // Older than everything in a full buffer: it would be evicted the moment it was stored.
      if (at === 0 && channel.buffer.length >= capacity) return

      channel.buffer.splice(at, 0, msg)
      // Over capacity: evict the oldest, at index 0. splice and shift are both O(n), microseconds at the
      // 500 maximum. A ring buffer would make eviction O(1), but an out-of-order insert would stay O(n).
      if (channel.buffer.length > capacity) channel.buffer.shift()
      published++

      notify(channel, msg.channelId, subscriber => subscriber.onMessage(msg))
    },

    /**
     * Deletes a message from the buffer and tells every subscriber of its channel. They hear about it
     * even if it has left the buffer, because an open page holds more than the server does.
     */
    remove(channelId, id) {
      const channel = getChannelState(channelId)
      if (channel.removed.has(id)) return
      channel.removed.add(id)
      for (const oldest of channel.removed) {
        if (channel.removed.size <= MAX_REMOVED) break
        channel.removed.delete(oldest)
      }
      // Found by ID, since the buffer is an array. -1 means it has already been evicted, and subscribers are still
      // told below: a page keeps up to 500 messages, more than the server's buffer.
      const at = channel.buffer.findIndex(held => held.id === id)
      if (at !== -1) channel.buffer.splice(at, 1)
      notify(channel, channelId, subscriber => subscriber.onRemove(id))
    },

    removed(channelId) {
      return [...(channels.get(channelId)?.removed ?? [])]
    },

    subscribe(channelId, fn, onRemove = () => {}) {
      // A new object each time, so the same function can subscribe twice and still be removed one at a time.
      const entry = { onMessage: fn, onRemove }
      const channel = getChannelState(channelId)
      channel.subscribers.add(entry)
      return () => {
        channel.subscribers.delete(entry)
      }
    },

    recent(channelId) {
      return [...(channels.get(channelId)?.buffer ?? [])]
    },

    subscriberCount() {
      let total = 0
      for (const channel of channels.values()) total += channel.subscribers.size
      return total
    },

    publishedTotal() {
      return published
    },
  }
}
