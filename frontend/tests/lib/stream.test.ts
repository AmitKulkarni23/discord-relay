import { describe, expect, it } from 'bun:test'
import { eventsUrl, fetchConfig, MAX_RETRY_MS, parseConfig, recoveredLabel, retryDelay } from '../../lib/stream.ts'

const CHANNEL = '1566584977829900002'

describe('parseConfig', () => {
  describe('when /config returns the expected shape', () => {
    it('should return the channels and the attachments flag when every field is valid', () => {
      const config = parseConfig({
        attachments: true,
        editsDeletes: false,
        debugPanel: false,
        channels: [
          { id: '1566584977829900002', name: 'relay' },
          { id: '1566584977829900003', name: null },
        ],
      })

      expect(config).toEqual({
        attachments: true,
        channels: [
          { id: '1566584977829900002', name: 'relay' },
          { id: '1566584977829900003', name: null },
        ],
      })
    })
  })

  describe('when /config returns something unexpected', () => {
    it('should fall back to no channels and attachments off when the value is not an object', () => {
      expect(parseConfig('<html>502 Bad Gateway</html>')).toEqual({ attachments: false, channels: [] })
    })

    it('should drop channel entries that are malformed when some are valid', () => {
      const config = parseConfig({ attachments: 'yes', channels: [{ id: 42 }, { id: '1566584977829900002', name: 'relay' }, null] })

      expect(config).toEqual({ attachments: false, channels: [{ id: '1566584977829900002', name: 'relay' }] })
    })
  })
})

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

describe('fetchConfig', () => {
  const GOOD = { attachments: true, channels: [{ id: CHANNEL, name: 'general' }] }
  const noWait = async (): Promise<void> => {}

  describe('when /config fails before it answers', () => {
    it('should retry until it succeeds when the server returns a 502', async () => {
      const replies = [new Response('Bad Gateway', { status: 502 }), Response.json(GOOD)]
      const get = async (): Promise<Response> => replies.shift() as Response

      expect(await fetchConfig(new AbortController().signal, get, noWait)).toEqual(GOOD)
      expect(replies).toHaveLength(0)
    })

    it('should retry when the network fails or the body is not JSON', async () => {
      let calls = 0
      const get = async (): Promise<Response> => {
        calls++
        if (calls === 1) throw new TypeError('Failed to fetch')
        return calls === 2 ? new Response('<html>') : Response.json(GOOD)
      }

      expect(await fetchConfig(new AbortController().signal, get, noWait)).toEqual(GOOD)
      expect(calls).toBe(3)
    })
  })

  describe('when the page stops waiting', () => {
    it('should return null when aborted between retries', async () => {
      const abort = new AbortController()
      const get = async (): Promise<Response> => {
        abort.abort()
        return new Response('Bad Gateway', { status: 502 })
      }

      expect(await fetchConfig(abort.signal, get, noWait)).toBeNull()
    })
  })
})
