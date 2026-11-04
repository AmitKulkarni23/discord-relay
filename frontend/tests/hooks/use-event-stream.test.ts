import { setupDom } from '../dom.ts'
import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
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

    it('should ignore a payload that is not a message', () => {
      const { result } = renderHook(() => useEventStream(CHANNEL))

      act(() => FakeEventSource.latest().sendRaw('{"id":42}'))

      expect(result.current.messages).toHaveLength(0)
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
