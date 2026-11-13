/**
 * The browser side of /events. Opens an EventSource for the selected channel, holds the
 * messages, and reconnects on its own with backoff and ?since= so nothing is missed. Produces the Status
 * the chip shows.
 */
import { useEffect, useMemo, useState } from 'react'
import { compareIds, type Msg } from '../../backend/core/types.ts'
import { addMsg, parseDeletedId, parseMsg, removeMsg, sortMsgs } from '../lib/messages.ts'
import { eventsUrl, limitWaitMs, retryDelay, type Status } from '../lib/stream.ts'

// Timings for the reconnect loop. Example: the reader's Wi-Fi drops for 10 s.
//   1. The stream errors; the chip says Reconnecting and the page retries after retryDelay (random, window doubling to 30 s).
//   2. The stream reopens with ?since=, so the server sends only the messages missed while it was down.
//   3. Messages arriving within CATCH_UP_WINDOW_MS of reopening are counted: the chip says "Back · 3 caught up".
//   4. RECOVERED_CHIP_MS later the chip returns to Live.

/**
 * A stream that stayed open this long counts as healthy, so its next drop retries fast again (backoff starts over).
 * Shorter-lived streams keep the backoff growing: a server that accepts connections and then dies at once must
 * not be hammered every second by every open page.
 */
const BACKOFF_RESET_AFTER_MS = 30_000
/** After a reconnect, messages arriving this soon after the stream reopens are the replay of what was missed, and are counted. */
const CATCH_UP_WINDOW_MS = 1_000
/** How long the chip says "Back · N caught up" before returning to Live. */
const RECOVERED_CHIP_MS = 5_000
/**
 * A stream silent this long is dead even without an error event, which laptop sleep or a network change can swallow.
 * The server pings every 25 s, so 60 s means at least two pings went missing.
 */
const DEAD_STREAM_AFTER_MS = 60_000
/**
 * EventSource hides HTTP status codes, so the page cannot tell a 429 (too many streams from this IP) from a 502.
 * After this many failures in a row it spends one fetch on /events to find out, and waits as told if it was a 429.
 */
const PROBE_AFTER_FAILURES = 3

type Connection = 'connecting' | 'live' | 'reconnecting' | 'full'

type EventStream = {
  /** The held messages, oldest first. */
  messages: Msg[]
  status: Status
  /** Messages recovered by the last reconnect, while the chip is saying so; otherwise null. */
  recovered: number | null
}

/**
 * One EventSource for one channel, with up to MAX_MSGS (500) messages keyed by ID. That is more than the
 * server's buffer (BUFFER_SIZE, 100 by default): an open page keeps collecting live messages. Switching channel starts a fresh list.
 */
export function useEventStream(channel: string | null): EventStream {
  const [msgs, setMsgs] = useState<Map<string, Msg>>(() => new Map())
  const [connection, setConnection] = useState<Connection>('connecting')
  /** What the server last said about Discord and this channel; only meaningful while the stream is open. */
  const [discord, setDiscord] = useState<unknown>('connected')
  const [recovered, setRecovered] = useState<number | null>(null)

  // Reset during render, so a switch never paints the old channel's messages under the new tab.
  const [shownChannel, setShownChannel] = useState(channel)
  if (channel !== shownChannel) {
    setShownChannel(channel)
    setMsgs(new Map())
    setConnection('connecting')
    setDiscord('connected')
    setRecovered(null)
  }

  useEffect(() => {
    const controller = new AbortController()
    let source: EventSource | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let recoveredNote: ReturnType<typeof setTimeout> | undefined
    let silence: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    let since: string | null = null
    /** When the current stream opened; null while it is down. */
    let openedAt: number | null = null
    /** False until the first open, so the first load's history is not reported as "caught up". */
    let everOpen = false
    /** Messages with a new ID before this time count towards "caught up". 0 outside a reconnect. */
    let catchUpUntil = 0

    const onDropped = (): void => {
      source?.close()
      clearTimeout(recoveredNote)
      clearTimeout(silence)
      // Checked on the drop, not on open: a server that accepts and then dies must keep backing off.
      if (openedAt !== null && Date.now() - openedAt >= BACKOFF_RESET_AFTER_MS) attempt = 0
      openedAt = null
      catchUpUntil = 0
      setRecovered(null)
      setConnection('reconnecting')
      retry = setTimeout(() => void reconnect(), retryDelay(attempt++))
    }

    /** Laptop sleep or a network change can kill a stream without an error event, leaving the page claiming to be live. */
    const heardFromServer = (): void => {
      clearTimeout(silence)
      silence = setTimeout(onDropped, DEAD_STREAM_AFTER_MS)
    }

    // EventSource's own retry has a fixed delay and stops for good on an HTTP error (e.g. a 502
    // mid-deploy), so every error closes it and this loop reconnects with backoff and jitter.
    const connect = (): void => {
      source = new EventSource(eventsUrl(channel, since))
      source.onopen = () => {
        heardFromServer()
        setConnection('live')
        openedAt = Date.now()
        // Every open after the first follows a drop, so this is a reconnect: show "Back live", then count the replay.
        if (everOpen) {
          // ponytail: a time window, so a slow replay undercounts. A server end-of-replay event would make it exact.
          catchUpUntil = openedAt + CATCH_UP_WINDOW_MS
          setRecovered(0)
          recoveredNote = setTimeout(() => setRecovered(null), RECOVERED_CHIP_MS)
        }
        everOpen = true
      }
      source.addEventListener('ping', heardFromServer)
      source.addEventListener('discord', (event: MessageEvent<unknown>) => {
        heardFromServer()
        setDiscord(event.data)
      })
      source.addEventListener('delete', (event: MessageEvent<unknown>) => {
        heardFromServer()
        const id = parseDeletedId(String(event.data))
        if (id) setMsgs(prev => removeMsg(prev, id))
      })
      source.onmessage = (event: MessageEvent<unknown>) => {
        heardFromServer()
        const msg = parseMsg(String(event.data))
        if (!msg) {
          console.warn('message_dropped', event.data)
          return
        }
        // Track the newest ID seen, sent as ?since= on the next reconnect so the server replays only what was missed.
        // compareIds orders Discord IDs by time; a plain `>` on the strings gets 18- vs 19-digit IDs wrong (see types.ts).
        // Only a newer ID moves it: an older one (an edit to an old message) must not move `since` backwards.
        if (since === null || compareIds(msg.id, since) > 0) {
          since = msg.id
          if (Date.now() < catchUpUntil) setRecovered(count => (count ?? 0) + 1)
        }
        setMsgs(prev => addMsg(prev, msg))
      }
      source.onerror = onDropped
    }

    // A refused client keeps its reason and waits as told, instead of reconnecting forever with no explanation.
    const reconnect = async (): Promise<void> => {
      if (attempt >= PROBE_AFTER_FAILURES) {
        const wait = await limitWaitMs(eventsUrl(channel, since), controller.signal)
        if (controller.signal.aborted) return
        if (wait !== null) {
          setConnection('full')
          retry = setTimeout(() => void reconnect(), wait)
          return
        }
      }
      connect()
    }

    connect()
    return () => {
      controller.abort()
      clearTimeout(silence)
      clearTimeout(retry)
      clearTimeout(recoveredNote)
      source?.close()
    }
  }, [channel])

  const messages = useMemo(() => sortMsgs(msgs), [msgs])
  const status: Status =
    connection !== 'live'
      ? connection
      : discord === 'disconnected'
        ? 'discord'
        : discord === 'unavailable'
          ? 'channel'
          : discord === 'failed'
            ? 'failed'
            : 'live'
  return { messages, status, recovered }
}
