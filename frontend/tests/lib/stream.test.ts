import { describe, expect, it } from 'bun:test'
import { eventsUrl, MAX_RETRY_MS, limitWaitMs, recoveredLabel, retryDelay } from '../../lib/stream.ts'

const CHANNEL = '1566584977829900002'

describe('recoveredLabel', () => {
  it('should say only that the stream is back when nothing was missed', () => {
    expect(recoveredLabel(0)).toBe('Back live')
  })

  it('should say how many missed messages were caught up', () => {
    expect(recoveredLabel(1)).toBe('Back · 1 caught up')
    expect(recoveredLabel(12)).toBe('Back · 12 caught up')
  })
})

describe('retryDelay', () => {
  describe('when retries keep failing', () => {
    it('should double the ceiling until the maximum when the random draw is at its top', () => {
      const top = () => 1
      expect([0, 1, 2, 3, 4, 5, 6, 99].map(attempt => retryDelay(attempt, top))).toEqual([
        1000,
        2000,
        4000,
        8000,
        16_000,
        MAX_RETRY_MS,
        MAX_RETRY_MS,
        MAX_RETRY_MS,
      ])
    })

    it('should spread the wait across the whole window when the random draw varies', () => {
      expect(retryDelay(2, () => 0)).toBe(0)
      expect(retryDelay(2, () => 0.5)).toBe(2000)
    })
  })
})

describe('eventsUrl', () => {
  describe('when connecting for the first time', () => {
    it('should omit since when no message has been seen', () => {
      expect(eventsUrl(null, null)).toBe('/events')
      expect(eventsUrl(CHANNEL, null)).toBe(`/events?channel=${CHANNEL}`)
    })
  })

  describe('when reconnecting', () => {
    it('should send the newest seen ID when one is held', () => {
      expect(eventsUrl(null, '1566588496691400002')).toBe('/events?since=1566588496691400002')
      expect(eventsUrl(CHANNEL, '1566588496691400002')).toBe(`/events?channel=${CHANNEL}&since=1566588496691400002`)
    })
  })
})

describe('limitWaitMs', () => {
  const answer =
    (status: number, retryAfter?: string, seen: Array<AbortSignal | null | undefined> = []) =>
    async (_url: string, init: RequestInit): Promise<Response> => {
      seen.push(init.signal)
      return new Response(null, { status, headers: retryAfter ? { 'Retry-After': retryAfter } : undefined })
    }
  const live = new AbortController().signal

  describe('when the server refuses with 429', () => {
    it('should wait as long as Retry-After says', async () => {
      expect(await limitWaitMs('/events', live, answer(429, '45'))).toBe(45_000)
    })

    it('should wait 30 seconds when Retry-After is missing or unreadable', async () => {
      expect(await limitWaitMs('/events', live, answer(429))).toBe(30_000)
      expect(await limitWaitMs('/events', live, answer(429, 'soon'))).toBe(30_000)
    })
  })

  describe('when the server answers anything else', () => {
    it('should report no limit and close the stream it just opened', async () => {
      const seen: Array<AbortSignal | null | undefined> = []

      expect(await limitWaitMs('/events', live, answer(200, undefined, seen))).toBeNull()
      expect(seen[0]?.aborted).toBe(true)
    })

    it('should report no limit when the request fails', async () => {
      const failing = async (): Promise<Response> => {
        throw new Error('network down')
      }

      expect(await limitWaitMs('/events', live, failing)).toBeNull()
    })
  })

  describe('when the caller gives up first', () => {
    it('should pass that on to the request', async () => {
      const page = new AbortController()
      const seen: Array<AbortSignal | null | undefined> = []
      const hanging = async (_url: string, init: RequestInit): Promise<Response> => {
        seen.push(init.signal)
        page.abort()
        expect(init.signal?.aborted).toBe(true)
        return new Response(null, { status: 200 })
      }

      await limitWaitMs('/events', page.signal, hanging)

      expect(seen).toHaveLength(1)
    })
  })
})
