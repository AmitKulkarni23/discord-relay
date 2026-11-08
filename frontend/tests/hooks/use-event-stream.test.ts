import { setupDom } from '../dom.ts'
import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { useEventStream } from '../../hooks/use-event-stream.ts'
import { FakeEventSource, makeMsg } from '../fixtures.ts'

setupDom()

const OLDER = makeMsg({ id: '1566588496691400001' })
const NEWER = makeMsg({ id: '1566588496691400002' })
const CHANNEL = '1566584977829900002'

const open = (es: FakeEventSource): void => act(() => es.onopen?.())
const fail = (es: FakeEventSource): void => act(() => es.onerror?.())
const send = (es: FakeEventSource, ...msgs: Array<typeof OLDER>): void => act(() => msgs.forEach(m => es.sendMessage(m)))
const waitFor = (ms: number): void =>
  act(() => {
    jest.advanceTimersByTime(ms)
  })

describe('useEventStream', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    FakeEventSource.opened = []
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  describe('when the stream opens', () => {
    it('should connect to the channel and go from connecting to live', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))
      expect(result.current.status).toBe('connecting')
      expect(FakeEventSource.latest().url).toBe(`/events?channel=${CHANNEL}`)

      open(FakeEventSource.latest())

      expect(result.current.status).toBe('live')
      expect(result.current.recovered).toBeNull()
    })

    it('should open one stream however often the page re-renders', () => {
      const { rerender } = renderHook(() => useEventStream(CHANNEL))

      rerender()
      rerender()

      expect(FakeEventSource.opened).toHaveLength(1)
    })
  })

  describe('when messages arrive', () => {
    it('should hold them oldest first, whatever order they land in', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))

      send(FakeEventSource.latest(), NEWER, OLDER)

      expect(result.current.messages.map(m => m.id)).toEqual([OLDER.id, NEWER.id])
    })

    it('should keep one copy of a message sent twice', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))

      send(FakeEventSource.latest(), OLDER, OLDER)

      expect(result.current.messages).toHaveLength(1)
    })

    it('should ignore a payload that is not a message, and say so in the console', () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
      const { result } = renderHook(() => useEventStream(CHANNEL))

      act(() => FakeEventSource.latest().sendRaw('{"id":42}'))

      expect(result.current.messages).toHaveLength(0)
      expect(warn).toHaveBeenCalledWith('message_dropped', '{"id":42}')
      warn.mockRestore()
    })
  })

  describe('when an open stream goes silent', () => {
    it('should treat it as dropped after a minute with nothing from the server', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))
      const first = FakeEventSource.latest()
      open(first)

      waitFor(59_999)
      expect(result.current.status).toBe('live')

      waitFor(1)
      expect(first.closed).toBe(true)
      expect(result.current.status).toBe('reconnecting')
    })

    it('should stay live while pings keep arriving', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))
      const es = FakeEventSource.latest()
      open(es)

      for (let i = 0; i < 5; i++) {
        waitFor(25_000)
        act(() => es.sendPing())
      }

      expect(es.closed).toBe(false)
      expect(result.current.status).toBe('live')
    })

    it('should count a message as a sign of life', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))
      const es = FakeEventSource.latest()
      open(es)

      waitFor(50_000)
      send(es, OLDER)
      waitFor(50_000)

      expect(result.current.status).toBe('live')
    })

    it('should reconnect once and not again from a stale timer', () => {
      const random = jest.spyOn(Math, 'random').mockReturnValue(0)
      renderHook(() => useEventStream(CHANNEL))
      open(FakeEventSource.latest())

      waitFor(60_000)
      waitFor(0)

      expect(FakeEventSource.opened).toHaveLength(2)
      random.mockRestore()
    })

    it('should not watch a stream that has been closed by the page', () => {
      const { unmount } = renderHook(() => useEventStream(CHANNEL))
      open(FakeEventSource.latest())

      unmount()
      waitFor(120_000)

      expect(FakeEventSource.opened).toHaveLength(1)
    })
  })

  describe('when a message is deleted', () => {
    it('should drop it from the list', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))
      const es = FakeEventSource.latest()
      send(es, OLDER, NEWER)

      act(() => es.sendDelete(OLDER.id))

      expect(result.current.messages.map(m => m.id)).toEqual([NEWER.id])
    })

    it('should keep asking only for newer messages after the newest is deleted', () => {
      renderHook(() => useEventStream(CHANNEL))
      const es = FakeEventSource.latest()
      send(es, NEWER)
      act(() => es.sendDelete(NEWER.id))

      fail(es)
      waitFor(1000)

      expect(FakeEventSource.latest().url).toBe(`/events?channel=${CHANNEL}&since=${NEWER.id}`)
    })
  })

  describe('when the bot loses Discord', () => {
    it('should wait for Discord while the stream stays open, then go live again', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))
      const es = FakeEventSource.latest()
      open(es)

      act(() => es.sendDiscord('disconnected'))
      expect(result.current.status).toBe('discord')

      act(() => es.sendDiscord('connected'))
      expect(result.current.status).toBe('live')
    })

    it('should say the relay has failed when the bot cannot log in to Discord', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))
      const es = FakeEventSource.latest()
      open(es)

      act(() => es.sendDiscord('failed'))
      expect(result.current.status).toBe('failed')
    })

    it('should say so when the bot cannot read this channel', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))
      const es = FakeEventSource.latest()
      open(es)

      act(() => es.sendDiscord('unavailable'))
      expect(result.current.status).toBe('channel')

      act(() => es.sendDiscord('connected'))
      expect(result.current.status).toBe('live')
    })

    it('should say the stream is reconnecting, not Discord, when both are down', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))
      const es = FakeEventSource.latest()
      open(es)
      act(() => es.sendDiscord('disconnected'))

      fail(es)

      expect(result.current.status).toBe('reconnecting')
    })
  })

  describe('when the stream drops', () => {
    it('should close it and reconnect asking only for newer messages', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))
      const first = FakeEventSource.latest()
      open(first)
      send(first, NEWER)

      fail(first)
      expect(first.closed).toBe(true)
      expect(result.current.status).toBe('reconnecting')

      waitFor(1000)
      expect(FakeEventSource.opened).toHaveLength(2)
      expect(FakeEventSource.latest().url).toBe(`/events?channel=${CHANNEL}&since=${NEWER.id}`)
    })

    it('should keep the messages it holds', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))
      send(FakeEventSource.latest(), OLDER)

      fail(FakeEventSource.latest())

      expect(result.current.messages).toHaveLength(1)
    })

    it('should wait longer after each failed attempt, up to the backoff window', () => {
      const random = jest.spyOn(Math, 'random').mockReturnValue(1)
      renderHook(() => useEventStream(CHANNEL))

      fail(FakeEventSource.latest())
      waitFor(999)
      expect(FakeEventSource.opened).toHaveLength(1)
      waitFor(1)
      expect(FakeEventSource.opened).toHaveLength(2)

      fail(FakeEventSource.latest())
      waitFor(1999)
      expect(FakeEventSource.opened).toHaveLength(2)
      waitFor(1)
      expect(FakeEventSource.opened).toHaveLength(3)
      random.mockRestore()
    })

    it('should start the backoff over once a stream has stayed open', () => {
      const random = jest.spyOn(Math, 'random').mockReturnValue(1)
      renderHook(() => useEventStream(CHANNEL))
      fail(FakeEventSource.latest())
      waitFor(1000)
      open(FakeEventSource.latest())
      waitFor(30_000)

      fail(FakeEventSource.latest())
      waitFor(1000)

      expect(FakeEventSource.opened).toHaveLength(3)
      random.mockRestore()
    })
  })

  describe('when the connection limit is reached', () => {
    /** Answers the probe, and lets the promise chain behind it settle. */
    const serve = (status: number, retryAfter?: string): ReturnType<typeof mock> => {
      const headers = retryAfter ? { 'Retry-After': retryAfter } : undefined
      const fetchMock = mock(async () => new globalThis.Response(null, { status, headers }))
      globalThis.fetch = fetchMock as unknown as typeof fetch
      return fetchMock
    }
    const flush = (ms: number): Promise<void> =>
      act(async () => {
        jest.advanceTimersByTime(ms)
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
    /** Fails enough times in a row for the next retry to ask the server why. */
    const failUntilProbing = async (): Promise<void> => {
      for (let i = 0; i < 3; i++) {
        fail(FakeEventSource.latest())
        await flush(i === 2 ? 0 : 30_000)
      }
    }

    it('should not spend a request asking why until retries have failed a few times', async () => {
      const fetchMock = serve(429, '30')
      renderHook(() => useEventStream(CHANNEL))

      fail(FakeEventSource.latest())
      await flush(30_000)
      fail(FakeEventSource.latest())
      await flush(30_000)

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('should say the limit is reached and wait as long as the server asks', async () => {
      const fetchMock = serve(429, '60')
      const { result } = renderHook(() => useEventStream(CHANNEL))
      await failUntilProbing()
      const opened = FakeEventSource.opened.length

      await flush(30_000)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(result.current.status).toBe('full')
      expect(FakeEventSource.opened).toHaveLength(opened)

      await flush(59_999)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await flush(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('should reconnect and go live once there is room again', async () => {
      serve(429, '30')
      const { result } = renderHook(() => useEventStream(CHANNEL))
      await failUntilProbing()
      await flush(30_000)
      expect(result.current.status).toBe('full')

      serve(200)
      const opened = FakeEventSource.opened.length
      await flush(30_000)
      expect(FakeEventSource.opened).toHaveLength(opened + 1)

      open(FakeEventSource.latest())
      expect(result.current.status).toBe('live')
    })

    it('should reconnect as usual when something else is wrong', async () => {
      globalThis.fetch = mock(async () => {
        throw new Error('network down')
      }) as unknown as typeof fetch
      const { result } = renderHook(() => useEventStream(CHANNEL))
      await failUntilProbing()
      const opened = FakeEventSource.opened.length

      await flush(30_000)

      expect(FakeEventSource.opened).toHaveLength(opened + 1)
      expect(result.current.status).toBe('reconnecting')
    })

    it('should not connect after the page has gone', async () => {
      serve(200)
      const { unmount } = renderHook(() => useEventStream(CHANNEL))
      await failUntilProbing()
      const opened = FakeEventSource.opened.length

      unmount()
      await flush(30_000)

      expect(FakeEventSource.opened).toHaveLength(opened)
    })
  })

  describe('when a reconnect succeeds', () => {
    const reconnect = (): { result: { current: ReturnType<typeof useEventStream> }; es: FakeEventSource } => {
      const { result } = renderHook(() => useEventStream(CHANNEL))
      open(FakeEventSource.latest())
      fail(FakeEventSource.latest())
      waitFor(1000)
      const es = FakeEventSource.latest()
      open(es)
      return { result, es }
    }

    it('should count what it caught up on, for five seconds', () => {
      const { result, es } = reconnect()
      expect(result.current.recovered).toBe(0)

      send(es, OLDER, NEWER)
      expect(result.current.recovered).toBe(2)

      waitFor(5000)
      expect(result.current.recovered).toBeNull()
    })

    it('should not count a live message that lands after the catch-up window', () => {
      const { result, es } = reconnect()

      waitFor(1000)
      send(es, NEWER)

      expect(result.current.recovered).toBe(0)
    })

    it('should not claim a recovery when the first connection only opens late', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))
      fail(FakeEventSource.latest())
      waitFor(1000)

      open(FakeEventSource.latest())

      expect(result.current.recovered).toBeNull()
    })
  })

  describe('when the channel changes', () => {
    it('should close the old stream and start a fresh list', () => {
      const { result, rerender } = renderHook(({ channel }) => useEventStream(channel), { initialProps: { channel: CHANNEL } })
      const first = FakeEventSource.latest()
      open(first)
      send(first, OLDER)
      act(() => first.sendDiscord('disconnected'))

      rerender({ channel: '1566584977829900003' })

      expect(first.closed).toBe(true)
      expect(FakeEventSource.latest().url).toBe('/events?channel=1566584977829900003')
      expect(result.current.messages).toHaveLength(0)
      expect(result.current.status).toBe('connecting')
    })
  })

  describe('when the page unmounts', () => {
    it('should close the stream and stop retrying', () => {
      const { unmount } = renderHook(() => useEventStream(CHANNEL))
      const es = FakeEventSource.latest()
      fail(es)

      unmount()
      waitFor(30_000)

      expect(FakeEventSource.opened).toHaveLength(1)
    })
  })
})
