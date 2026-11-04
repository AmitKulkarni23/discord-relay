import { useEffect, useMemo, useState } from 'react'
import { compareIds, type Msg } from '../../backend/types.ts'
import { addMsg, parseMsg, sortMsgs } from '../lib/messages.ts'
import { eventsUrl, limitWaitMs, retryDelay, type Status } from '../lib/stream.ts'

/** How long a stream must stay open before reconnect backoff starts over. */
const STABLE_MS = 30_000
/** After a reconnect, messages this soon after the stream opens count as caught up. */
const CATCH_UP_MS = 1_000
/** How long the chip says what a reconnect recovered before returning to Live. */
const RECOVERED_MS = 5_000

/** Failed attempts in a row before spending a request on asking the server why. */
const PROBE_AFTER = 3

type Connection = 'connecting' | 'live' | 'reconnecting' | 'full'

type EventStream = {
  /** The held messages, oldest first. */
  messages: Msg[]
  status: Status
  /** Messages recovered by the last reconnect, while the chip is saying so; otherwise null. */
  recovered: number | null
}

/** One EventSource for one channel, with up to 500 messages keyed by ID. Switching channel starts a fresh list. */
export function useEventStream(channel: string | null): EventStream {
  const [msgs, setMsgs] = useState<Map<string, Msg>>(() => new Map())
  const [connection, setConnection] = useState<Connection>('connecting')
  const [discordUp, setDiscordUp] = useState(true)
  const [recovered, setRecovered] = useState<number | null>(null)

  // Reset during render, so a switch never paints the old channel's messages under the new tab.
  const [shownChannel, setShownChannel] = useState(channel)
  if (channel !== shownChannel) {
    setShownChannel(channel)
    setMsgs(new Map())
    setConnection('connecting')
    setDiscordUp(true)
    setRecovered(null)
  }

  useEffect(() => {
    const abort = new AbortController()
    let es: EventSource | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let stable: ReturnType<typeof setTimeout> | undefined
    let recoveredNote: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    let since: string | null = null
    let dropped = false
    let everOpen = false
    let catchUpUntil = 0

    // EventSource's own retry has a fixed delay and stops for good on an HTTP error (e.g. a 502
    // mid-deploy), so every error closes it and this loop reconnects with backoff and jitter.
    const connect = (): void => {
      es = new EventSource(eventsUrl(channel, since))
      es.onopen = () => {
        setConnection('live')
        if (everOpen && dropped) {
          // ponytail: a time window, so a slow replay undercounts. A server end-of-replay event would make it exact.
          catchUpUntil = Date.now() + CATCH_UP_MS
          setRecovered(0)
          recoveredNote = setTimeout(() => setRecovered(null), RECOVERED_MS)
        }
        everOpen = true
        dropped = false
        // Not on open alone: a server that accepts and then dies must keep backing off.
        stable = setTimeout(() => {
          attempt = 0
        }, STABLE_MS)
      }
      es.addEventListener('discord', (e: MessageEvent<unknown>) => setDiscordUp(e.data !== 'disconnected'))
      es.onmessage = (e: MessageEvent<unknown>) => {
        const m = parseMsg(String(e.data))
        if (!m) return
        if (since === null || compareIds(m.id, since) > 0) {
          since = m.id
          if (Date.now() < catchUpUntil) setRecovered(n => (n ?? 0) + 1)
        }
        setMsgs(prev => addMsg(prev, m))
      }
      es.onerror = () => {
        es?.close()
        clearTimeout(stable)
        clearTimeout(recoveredNote)
        dropped = true
        catchUpUntil = 0
        setRecovered(null)
        setConnection('reconnecting')
        retry = setTimeout(() => void reconnect(), retryDelay(attempt++))
      }
    }

    // A refused client keeps its reason and waits as told, instead of reconnecting forever with no explanation.
    const reconnect = async (): Promise<void> => {
      if (attempt >= PROBE_AFTER) {
        const wait = await limitWaitMs(eventsUrl(channel, since), abort.signal)
        if (abort.signal.aborted) return
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
      abort.abort()
      clearTimeout(retry)
      clearTimeout(stable)
      clearTimeout(recoveredNote)
      es?.close()
    }
  }, [channel])

  const messages = useMemo(() => sortMsgs(msgs), [msgs])
  const status: Status = connection === 'live' && !discordUp ? 'discord' : connection
  return { messages, status, recovered }
}
