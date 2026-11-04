import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import net from 'node:net'
import { createHub, type Hub } from '../hub.ts'
import type { Flags } from '../flags.ts'
import { encodeEvent, formatEvent, MAX_CONNECTIONS_PER_IP, startServer } from '../server.ts'
import type { Msg } from '../types.ts'

const CHANNEL = '1301000000000000001'
const CHANNEL_2 = '1301000000000000002'

/** Builds a realistic message for the test channel. */
function makeMsg(id: string, content = `deploy finished for build ${id}`, channelId = CHANNEL, createdAt = '2026-11-01T17:00:00.000Z'): Msg {
  return {
    id,
    channelId,
    author: { id: '1290000000000000042', name: 'amit', avatarUrl: null, bot: false },
    content,
    createdAt,
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
async function openEvents(base: URL, path = '/events', headers: Record<string, string> = {}) {
  const abort = new AbortController()
  const res = await fetch(new URL(path, base), { signal: abort.signal, headers })
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

/** Captures the JSON log lines written during a test. Undone by `afterEach`. */
function captureLogs(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = []
  const spy = spyOn(console, 'log').mockImplementation((line: string) => {
    lines.push(JSON.parse(line) as Record<string, unknown>)
  })
  stops.push(() => spy.mockRestore())
  return lines
}

const stops: Array<() => void> = []
afterEach(() => {
  while (stops.length) stops.pop()?.()
})

/** Starts a server on a random port with test defaults. */
function start(hub: Hub, overrides: { connected?: boolean; pingMs?: number; channelName?: string | null; flags?: () => Flags } = {}) {
  const server = startServer({
    port: 0,
    hub,
    channelIds: [CHANNEL, CHANNEL_2],
    flags: overrides.flags ?? (() => ({ attachments: true, editsDeletes: false, debugPanel: false })),
    isDiscordConnected: () => overrides.connected ?? true,
    channels: () => [
      { id: CHANNEL, name: overrides.channelName === undefined ? 'relay-test' : overrides.channelName },
      { id: CHANNEL_2, name: 'announcements' },
    ],
    pingMs: overrides.pingMs ?? 60_000,
  })
  stops.push(server.stop)
  return server
}

describe('formatEvent', () => {
  describe('when given a message', () => {
    it('should produce an SSE event with the message ID when formatted', () => {
      const msg = makeMsg('1302000000000000001')
      expect(formatEvent(msg)).toBe(`id: 1302000000000000001\ndata: ${JSON.stringify(msg)}\n\n`)
    })
  })
})

describe('encodeEvent', () => {
  describe('when the same message is encoded twice', () => {
    it('should return the same bytes when the message object is unchanged', () => {
      const msg = makeMsg('1302000000000000001')

      expect(encodeEvent(msg)).toBe(encodeEvent(msg))
      expect(new TextDecoder().decode(encodeEvent(msg))).toBe(formatEvent(msg))
    })
  })
})

describe('server', () => {
  describe('when several browsers read one message', () => {
    it('should send every browser the replay and the live message intact when bytes are shared', async () => {
      const hub = createHub()
      hub.publish(makeMsg('1302000000000000001', 'replayed to both'))
      const { url } = start(hub)
      const first = await openEvents(url)
      const second = await openEvents(url)
      await waitFor(() => hub.subscriberCount() === 2)

      hub.publish(makeMsg('1302000000000000002', 'live to both'))

      for (const events of [first, second]) {
        const text = await events.readUntil(t => t.includes('live to both'))
        expect(text).toContain('replayed to both')
      }
    })
  })

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

  describe('when a browser reconnects with ?since=', () => {
    /** Starts a server holding three messages, the way a reconnect finds it. */
    function startWithBuffer() {
      const hub = createHub()
      for (const id of ['1302000000000000001', '1302000000000000002', '1302000000000000003']) hub.publish(makeMsg(id))
      return { hub, url: start(hub).url }
    }

    it('should replay only newer messages when the ID is valid', async () => {
      const { url } = startWithBuffer()

      const events = await openEvents(url, '/events?since=1302000000000000002')
      const text = await events.readUntil(t => t.includes('id: 1302000000000000003'))

      expect(text).not.toContain('id: 1302000000000000001')
      expect(text).not.toContain('id: 1302000000000000002')
    })

    it('should skip a live message when the browser already has it', async () => {
      const hub = createHub()
      const { url } = start(hub)
      const events = await openEvents(url, '/events?since=1302000000000000002')
      await waitFor(() => hub.subscriberCount() === 1)

      // A restarted server refills its buffer by publishing history, so old IDs can arrive live.
      hub.publish(makeMsg('1302000000000000001'))
      hub.publish(makeMsg('1302000000000000003'))

      const text = await events.readUntil(t => t.includes('id: 1302000000000000003'))
      expect(text).not.toContain('id: 1302000000000000001')
    })

    it('should replay the full buffer when the ID is not a snowflake', async () => {
      const { url } = startWithBuffer()

      const events = await openEvents(url, '/events?since=1302%27%20OR%201')
      const text = await events.readUntil(t => t.includes('id: 1302000000000000003'))

      expect(text).toContain('id: 1302000000000000001')
    })
  })

  describe('when a browser picks a channel', () => {
    it('should stream the first configured channel when no channel is given', async () => {
      const hub = createHub()
      hub.publish(makeMsg('1302000000000000001', 'first channel message'))
      hub.publish(makeMsg('1302000000000000002', 'second channel message', CHANNEL_2))
      const server = start(hub)

      const events = await openEvents(server.url)
      const text = await events.readUntil(t => t.includes('first channel message'))
      events.abort()

      expect(text).not.toContain('second channel message')
    })

    it('should stream only that channel when ?channel= names a configured channel', async () => {
      const hub = createHub()
      hub.publish(makeMsg('1302000000000000001', 'first channel message'))
      hub.publish(makeMsg('1302000000000000002', 'second channel message', CHANNEL_2))
      const server = start(hub)

      const events = await openEvents(server.url, `/events?channel=${CHANNEL_2}`)
      const text = await events.readUntil(t => t.includes('second channel message'))
      events.abort()

      expect(text).not.toContain('first channel message')
    })

    it('should return 404 when ?channel= is not a configured channel', async () => {
      const hub = createHub()
      const { url } = start(hub)

      const res = await fetch(new URL('/events?channel=1301000000000000999', url))

      expect(res.status).toBe(404)
      expect(hub.subscriberCount()).toBe(0)
    })
  })

  describe('when the stream is idle', () => {
    it('should send a ping when no messages arrive for pingMs', async () => {
      const hub = createHub()
      const { url } = start(hub, { pingMs: 20 })

      const events = await openEvents(url)

      expect(await events.readUntil(t => t.includes(': ping\n\n'))).toContain(': ping')
    })

    it('should ping every stream from one timer when several are open', async () => {
      const timers = spyOn(globalThis, 'setInterval')
      const { url } = start(createHub(), { pingMs: 20 })

      const first = await openEvents(url)
      const second = await openEvents(url)
      await first.readUntil(t => t.includes(': ping\n\n'))
      await second.readUntil(t => t.includes(': ping\n\n'))
      const created = timers.mock.calls.length
      timers.mockRestore()

      expect(created).toBe(1)
    })
  })

  describe('when Railway sends a request ID', () => {
    const REQUEST_ID = 'hX3kPq9mRgOaLw2nT7vYtA'
    const headers = { 'X-Railway-Request-Id': REQUEST_ID }

    it('should log it when a stream connects and disconnects', async () => {
      const hub = createHub()
      const { url } = start(hub)
      const logs = captureLogs()

      const events = await openEvents(url, '/events', headers)
      await waitFor(() => hub.subscriberCount() === 1)
      events.abort()
      await waitFor(() => hub.subscriberCount() === 0)

      expect(logs.find(l => l.event === 'client_connected')?.requestId).toBe(REQUEST_ID)
      expect(logs.find(l => l.event === 'client_disconnected')?.requestId).toBe(REQUEST_ID)
    })

    it('should log it when the IP is past the cap', async () => {
      const { url } = start(createHub())
      for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) await openEvents(url)
      const logs = captureLogs()

      const rejected = await openEvents(url, '/events', headers)

      expect(rejected.res.status).toBe(429)
      expect(logs.find(l => l.event === 'client_rejected')?.requestId).toBe(REQUEST_ID)
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

  describe('when one IP opens many streams', () => {
    /** Opens /events as `ip`, the way Railway's edge forwards it. */
    const openAs = (url: URL, ip: string) => openEvents(url, '/events', { 'X-Real-IP': ip })
    const fillCap = async (url: URL, ip: string) => {
      const opened = []
      for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) opened.push(await openAs(url, ip))
      return opened
    }

    it('should return 429 when the IP is past the cap, and leave other IPs alone', async () => {
      const hub = createHub()
      const { url } = start(hub)
      await fillCap(url, '203.0.113.7')

      const rejected = await openAs(url, '203.0.113.7')
      const other = await openAs(url, '203.0.113.8')

      expect(rejected.res.status).toBe(429)
      expect(other.res.status).toBe(200)
      expect(hub.subscriberCount()).toBe(MAX_CONNECTIONS_PER_IP + 1)
    })

    it('should count by the socket address when there is no X-Real-IP header', async () => {
      const { url } = start(createHub())
      for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) await openEvents(url)

      const rejected = await openEvents(url)

      expect(rejected.res.status).toBe(429)
    })

    it('should ignore X-Forwarded-For when a client varies it to dodge the cap', async () => {
      const { url } = start(createHub())
      for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) await openEvents(url, '/events', { 'X-Forwarded-For': `198.51.100.${i}` })

      const rejected = await openEvents(url, '/events', { 'X-Forwarded-For': '198.51.100.200' })

      expect(rejected.res.status).toBe(429)
    })

    it('should free the slot when a stream disconnects', async () => {
      const hub = createHub()
      const { url } = start(hub)
      const opened = await fillCap(url, '203.0.113.7')

      opened[0]?.abort()
      await waitFor(() => hub.subscriberCount() === MAX_CONNECTIONS_PER_IP - 1)
      const reopened = await openAs(url, '203.0.113.7')

      expect(reopened.res.status).toBe(200)
    })
  })

  describe('when a client stops reading', () => {
    /** Opens /events over a raw socket that never reads, like a stalled browser. */
    async function openStalled(url: URL, ip: string): Promise<net.Socket> {
      const sock = net.connect(Number(url.port), url.hostname)
      await new Promise<void>(resolve => sock.once('connect', () => resolve()))
      sock.on('error', () => {})
      sock.write(`GET /events HTTP/1.1\r\nHost: x\r\nX-Real-IP: ${ip}\r\nX-Railway-Request-Id: stalled-request\r\n\r\n`)
      sock.pause()
      stops.push(() => sock.destroy())
      return sock
    }

    it('should drop it, free its slot and keep other readers when it falls too far behind', async () => {
      const hub = createHub()
      const { url } = start(hub)
      const logs = captureLogs()
      await openStalled(url, '203.0.113.7')
      const reader = await openEvents(url)
      await waitFor(() => hub.subscriberCount() === 2)

      // Socket buffers absorb the first few MB, so publish until the stalled stream is over its limit.
      const body = 'x'.repeat(64 * 1024)
      let last = ''
      for (let i = 0; i < 1000 && hub.subscriberCount() === 2; i++) {
        last = `13020000000${String(1000000 + i)}0`
        hub.publish(makeMsg(last, body))
        await reader.readUntil(t => t.includes(`id: ${last}`))
      }

      expect(hub.subscriberCount()).toBe(1)
      expect(logs.find(l => l.event === 'client_dropped')?.requestId).toBe('stalled-request')
      const again = await openEvents(url, '/events', { 'X-Real-IP': '203.0.113.7' })
      expect(again.res.status).toBe(200)
    }, 20_000)

    it('should keep the client when its replay is larger than the limit', async () => {
      const hub = createHub()
      const body = 'x'.repeat(300 * 1024)
      for (let i = 1; i <= 5; i++) hub.publish(makeMsg(`130200000000000000${i}`, body))
      const { url } = start(hub)

      const events = await openEvents(url)
      await events.readUntil(t => t.includes('id: 1302000000000000005'))
      hub.publish(makeMsg('1302000000000000006', 'after the replay'))

      await events.readUntil(t => t.includes('after the replay'))
      expect(hub.subscriberCount()).toBe(1)
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

    it('should total the buffers and take the newest event across channels when several are relayed', async () => {
      const hub = createHub()
      hub.publish(makeMsg('1302000000000000001', 'older', CHANNEL, '2026-11-01T17:00:00.000Z'))
      hub.publish(makeMsg('1302000000000000002', 'newer', CHANNEL_2, '2026-11-01T18:30:00.000Z'))
      const { url } = start(hub)

      const body = await (await fetch(new URL('/health', url))).json()

      expect(body).toMatchObject({ buffered: 2, lastEventAt: '2026-11-01T18:30:00.000Z' })
    })

    it('should report unhealthy with 503 when Discord is disconnected', async () => {
      const { url } = start(createHub(), { connected: false })

      const res = await fetch(new URL('/health', url))

      expect(res.status).toBe(503)
      expect(await res.json()).toMatchObject({ discord: 'disconnected', lastEventAt: null })
    })
  })

  describe('when /config is requested', () => {
    it('should return the feature flags and every channel with its name when the channels are loaded', async () => {
      const { url } = start(createHub())

      const res = await fetch(new URL('/config', url))

      expect(await res.json()).toEqual({
        attachments: true,
        editsDeletes: false,
        debugPanel: false,
        channels: [
          { id: CHANNEL, name: 'relay-test' },
          { id: CHANNEL_2, name: 'announcements' },
        ],
      })
    })

    it('should read the flags on every request when a flag changes at runtime', async () => {
      let current: Flags = { attachments: false, editsDeletes: false, debugPanel: false }
      const { url } = start(createHub(), { flags: () => current })

      const before = await (await fetch(new URL('/config', url))).json()
      current = { ...current, attachments: true }
      const after = await (await fetch(new URL('/config', url))).json()

      expect(before).toMatchObject({ attachments: false })
      expect(after).toMatchObject({ attachments: true })
    })

    it('should return a null name when a channel has not loaded yet', async () => {
      const { url } = start(createHub(), { channelName: null })

      const res = await fetch(new URL('/config', url))

      expect(await res.json()).toMatchObject({
        channels: [
          { id: CHANNEL, name: null },
          { id: CHANNEL_2, name: 'announcements' },
        ],
      })
    })
  })

  describe('when / is requested', () => {
    it('should serve the HTML page with the React mount point when the browser opens the site', async () => {
      const { url } = start(createHub())

      const res = await fetch(url)

      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/html')
      expect(await res.text()).toContain('<div id="root">')
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
