import { describe, expect, it } from 'bun:test'
import { fetchConfig, parseConfig } from '../../lib/config.ts'

const CHANNEL = '1566584977829900002'

describe('parseConfig', () => {
  describe('when /config returns the expected shape', () => {
    it('should return the channels and the attachments flag when every field is valid', () => {
      const config = parseConfig({
        attachments: true,
        editsDeletes: false,
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
