import { afterEach, describe, expect, it } from 'bun:test'
import { createHub, type Hub } from './hub.ts'
import { formatEvent, loadConfig, startServer } from './server.ts'
import type { Msg } from './types.ts'

const CHANNEL = '1301000000000000001'
const VALID_ENV = { DISCORD_TOKEN: 'MTI5MDAwMDAwMDAwMDAwMDQy.fake.token', CHANNEL_ID: CHANNEL }

/** Builds a realistic message for the test channel. */
function makeMsg(id: string, content = `deploy finished for build ${id}`): Msg {
  return {
    id,
    channelId: CHANNEL,
    author: { id: '1290000000000000042', name: 'amit', avatarUrl: null, bot: false },
    content,
    createdAt: '2026-11-01T17:00:00.000Z',
    editedAt: null,
    attachments: [],
  }
}

/** Polls `cond` until it is true, failing after `ms`. */
async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(5)
  }
}

/** Opens /events and returns helpers to read the stream as text. */
async function openEvents(base: URL) {
  const abort = new AbortController()
  const res = await fetch(new URL('/events', base), { signal: abort.signal })
  if (!res.body) throw new Error('no response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''

  /** Reads chunks until the accumulated text satisfies `pred`. */
  async function readUntil(pred: (t: string) => boolean): Promise<string> {
    while (!pred(text)) {
      const { value, done } = await reader.read()
      if (done) throw new Error('stream ended')
      text += decoder.decode(value, { stream: true })
    }
    return text
  }

  return { res, reader, readUntil, abort: () => abort.abort() }
}

const stops: Array<() => void> = []
afterEach(() => {
  while (stops.length) stops.pop()?.()
})

/** Starts a server on a random port with test defaults. */
function start(hub: Hub, overrides: { connected?: boolean; pingMs?: number } = {}) {
  const server = startServer({
    port: 0,
    hub,
    channelId: CHANNEL,
    flags: { attachments: true, editsDeletes: false, debugPanel: false },
    isDiscordConnected: () => overrides.connected ?? true,
    pingMs: overrides.pingMs ?? 60_000,
  })
  stops.push(server.stop)
  return server
}

describe('loadConfig', () => {
  describe('when a required variable is missing', () => {
    it('should throw naming DISCORD_TOKEN when it is missing', () => {
      expect(() => loadConfig({ CHANNEL_ID: CHANNEL })).toThrow('DISCORD_TOKEN')
    })

    it('should throw naming CHANNEL_ID when it is empty', () => {
      expect(() => loadConfig({ ...VALID_ENV, CHANNEL_ID: '' })).toThrow('CHANNEL_ID')
    })
  })

  describe('when PORT is set or unset', () => {
    it('should default to 3000 when PORT is unset', () => {
      expect(loadConfig(VALID_ENV).port).toBe(3000)
    })

    it('should use the value when PORT is a valid number', () => {
      expect(loadConfig({ ...VALID_ENV, PORT: '8080' }).port).toBe(8080)
    })

    it('should throw naming PORT when it is not a number', () => {
      expect(() => loadConfig({ ...VALID_ENV, PORT: 'eighty' })).toThrow('PORT')
    })
  })

  describe('when feature flags are set', () => {
    it('should enable only the flags whose value is "true" when some are set', () => {
      const { flags } = loadConfig({ ...VALID_ENV, FEATURE_ATTACHMENTS: 'true', DEBUG_PANEL: 'yes' })
      expect(flags).toEqual({ attachments: true, editsDeletes: false, debugPanel: false })
    })
  })
})

describe('formatEvent', () => {
  describe('when given a message', () => {
    it('should produce an SSE event with the message ID when formatted', () => {
      const msg = makeMsg('1302000000000000001')
      expect(formatEvent(msg)).toBe(`id: 1302000000000000001\ndata: ${JSON.stringify(msg)}\n\n`)
    })
  })
})

describe('server', () => {
  describe('when a browser opens /events', () => {
    it('should send the buffered messages first, oldest first, when it connects', async () => {
      const hub = createHub()
      hub.publish(makeMsg('1302000000000000001'))
      hub.publish(makeMsg('1302000000000000002'))
      const { url } = start(hub)

      const events = await openEvents(url)
      const text = await events.readUntil(t => t.includes('1302000000000000002'))

      expect(events.res.headers.get('content-type')).toBe('text/event-stream')
      expect(events.res.headers.get('cache-control')).toBe('no-cache')
      expect(text.indexOf('id: 1302000000000000001')).toBeLessThan(text.indexOf('id: 1302000000000000002'))
    })

    it('should stream a message when it is published after connecting', async () => {
      const hub = createHub()
      const { url } = start(hub)
      const events = await openEvents(url)
      await waitFor(() => hub.subscriberCount() === 1)

      hub.publish(makeMsg('1302000000000000003', 'rollback complete'))

      const text = await events.readUntil(t => t.includes('rollback complete'))
      expect(text).toContain('id: 1302000000000000003')
    })
  })

  describe('when the stream is idle', () => {
    it('should send a ping when no messages arrive for pingMs', async () => {
      const hub = createHub()
      const { url } = start(hub, { pingMs: 20 })

      const events = await openEvents(url)

      expect(await events.readUntil(t => t.includes(': ping\n\n'))).toContain(': ping')
    })
  })

  describe('when the browser disconnects', () => {
    it('should unsubscribe it from the hub when the request is aborted', async () => {
      const hub = createHub()
      const { url } = start(hub)
      const events = await openEvents(url)
      await waitFor(() => hub.subscriberCount() === 1)

      events.abort()

      await waitFor(() => hub.subscriberCount() === 0)
      expect(hub.subscriberCount()).toBe(0)
    })
  })

  describe('when /health is requested', () => {
    it('should report healthy with 200 when Discord is connected', async () => {
      const hub = createHub()
      hub.publish(makeMsg('1302000000000000001'))
      const { url } = start(hub, { connected: true })

      const res = await fetch(new URL('/health', url))
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body).toMatchObject({
        discord: 'connected',
        clients: 0,
        buffered: 1,
        lastEventAt: '2026-11-01T17:00:00.000Z',
      })
    })

    it('should report unhealthy with 503 when Discord is disconnected', async () => {
      const { url } = start(createHub(), { connected: false })

      const res = await fetch(new URL('/health', url))

      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ discord: 'disconnected', lastEventAt: null })
    })
  })

  describe('when /config is requested', () => {
    it('should return the feature flags when asked', async () => {
      const { url } = start(createHub())

      const res = await fetch(new URL('/config', url))

      expect(await res.json()).toEqual({ attachments: true, editsDeletes: false, debugPanel: false })
    })
  })

  describe('when / is requested', () => {
    it('should return a plain-text page when the frontend does not exist yet', async () => {
      const { url } = start(createHub())

      const res = await fetch(url)

      expect(res.status).toBe(200)
      expect(await res.text()).toContain('DiscordRelay')
    })
  })

  describe('when stop is called', () => {
    it('should close open streams when the server stops', async () => {
      const hub = createHub()
      const server = start(hub)
      const events = await openEvents(server.url)
      await waitFor(() => hub.subscriberCount() === 1)

      server.stop()

      let done = false
      while (!done) done = (await events.reader.read()).done
      expect(done).toBe(true)
      expect(hub.subscriberCount()).toBe(0)
    })
  })
})
