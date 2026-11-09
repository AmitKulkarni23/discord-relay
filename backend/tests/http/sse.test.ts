import { describe, expect, it, spyOn } from 'bun:test'
import net from 'node:net'
import { createHub } from '../../core/hub.ts'
import { encodeEvent, formatEvent, MAX_CONNECTIONS_PER_IP } from '../../http/sse.ts'
import { CHANNEL, CHANNEL_2, captureLogs, makeMsg, openEvents, start, stops, waitFor } from '../helpers.ts'

describe('the delete event', () => {
  const OLD = '1302000000000000001'
  const NEW = '1302000000000000002'
  const deleted = (id: string): string => `event: delete\ndata: {"id":"${id}","channelId":"${CHANNEL}"}\n\n`

  it('should tell an open stream, even about a message older than its since', async () => {
    const hub = createHub(10)
    hub.publish(makeMsg(NEW))
    const { url } = start(hub)
    const stream = await openEvents(url, `/events?since=${NEW}`)
    await waitFor(() => hub.subscriberCount() === 1)

    hub.remove(CHANNEL, OLD)

    expect(await stream.readUntil(received => received.includes('event: delete'))).toContain(deleted(OLD))
    stream.abort()
  })

  it('should replay recent deletions to a reconnecting browser', async () => {
    const hub = createHub(10)
    hub.remove(CHANNEL, OLD)
    const { url } = start(hub)

    const stream = await openEvents(url, `/events?since=${NEW}`)

    expect(await stream.readUntil(received => received.includes('event: delete'))).toContain(deleted(OLD))
    stream.abort()
  })

  it('should send a first-time visitor no deletions, because their buffer never held them', async () => {
    const hub = createHub(10)
    hub.remove(CHANNEL, OLD)
    hub.publish(makeMsg(NEW))
    const { url } = start(hub)

    const stream = await openEvents(url)
    const text = await stream.readUntil(received => received.includes(NEW))

    expect(text).not.toContain('event: delete')
    stream.abort()
  })

  it('should stop serving a deleted message to new visitors', async () => {
    const hub = createHub(10)
    hub.publish(makeMsg(OLD))
    hub.publish(makeMsg(NEW))
    hub.remove(CHANNEL, OLD)
    const { url } = start(hub)

    const stream = await openEvents(url)
    const text = await stream.readUntil(received => received.includes(NEW))

    expect(text).not.toContain(OLD)
    stream.abort()
  })
})

describe('the discord status event', () => {
  it('should tell a new stream that Discord is connected', async () => {
    const { url } = start(createHub(10))
    const stream = await openEvents(url)
    expect(await stream.readUntil(received => received.includes('event: discord'))).toContain('event: discord\ndata: connected\n\n')
    stream.abort()
  })

  it('should tell a new stream that Discord is disconnected', async () => {
    const { url } = start(createHub(10), { connected: false })
    const stream = await openEvents(url)
    expect(await stream.readUntil(received => received.includes('event: discord'))).toContain('event: discord\ndata: disconnected\n\n')
    stream.abort()
  })

  it('should say the relay has failed when the bot cannot log in, so the page can say a person is needed', async () => {
    const { url } = start(createHub(10), { connected: false, loginFailed: true })
    const stream = await openEvents(url)

    expect(await stream.readUntil(received => received.includes('event: discord'))).toContain('event: discord\ndata: failed\n\n')
    stream.abort()
  })

  it('should say a channel the bot cannot read is unavailable', async () => {
    const { url } = start(createHub(10), { available: false })
    const stream = await openEvents(url)

    expect(await stream.readUntil(received => received.includes('event: discord'))).toContain('event: discord\ndata: unavailable\n\n')
    stream.abort()
  })

  it('should say Discord is disconnected when both are true, because that is the cause to fix first', async () => {
    const { url } = start(createHub(10), { connected: false, available: false })
    const stream = await openEvents(url)

    expect(await stream.readUntil(received => received.includes('event: discord'))).toContain('event: discord\ndata: disconnected\n\n')
    stream.abort()
  })

  it('should push a channel becoming available to an open stream', async () => {
    const overrides = { available: false }
    const { url } = start(createHub(10), overrides)
    const stream = await openEvents(url)
    await stream.readUntil(received => received.includes('data: unavailable'))

    overrides.available = true

    expect(await stream.readUntil(received => received.includes('data: connected'))).toContain('event: discord\ndata: connected\n\n')
    stream.abort()
  })

  it('should push a change to an open stream', async () => {
    const overrides = { connected: true }
    const { url } = start(createHub(10), overrides)
    const stream = await openEvents(url)
    await stream.readUntil(received => received.includes('data: connected'))
    overrides.connected = false
    expect(await stream.readUntil(received => received.includes('data: disconnected'))).toContain('event: discord\ndata: disconnected\n\n')
    stream.abort()
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

describe('encodeEvent', () => {
  describe('when the same message is encoded twice', () => {
    it('should return the same bytes when the message object is unchanged', () => {
      const msg = makeMsg('1302000000000000001')

      expect(encodeEvent(msg)).toBe(encodeEvent(msg))
      expect(new TextDecoder().decode(encodeEvent(msg))).toBe(formatEvent(msg))
    })
  })
})

describe('event streams', () => {
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
        const text = await events.readUntil(received => received.includes('live to both'))
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
      const text = await events.readUntil(received => received.includes('1302000000000000002'))

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

      const text = await events.readUntil(received => received.includes('rollback complete'))
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
      const text = await events.readUntil(received => received.includes('id: 1302000000000000003'))

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

      const text = await events.readUntil(received => received.includes('id: 1302000000000000003'))
      expect(text).not.toContain('id: 1302000000000000001')
    })

    it('should replay the full buffer when the ID is not a snowflake', async () => {
      const { url } = startWithBuffer()

      const events = await openEvents(url, '/events?since=1302%27%20OR%201')
      const text = await events.readUntil(received => received.includes('id: 1302000000000000003'))

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
      const text = await events.readUntil(received => received.includes('first channel message'))
      events.abort()

      expect(text).not.toContain('second channel message')
    })

    it('should stream only that channel when ?channel= names a configured channel', async () => {
      const hub = createHub()
      hub.publish(makeMsg('1302000000000000001', 'first channel message'))
      hub.publish(makeMsg('1302000000000000002', 'second channel message', CHANNEL_2))
      const server = start(hub)

      const events = await openEvents(server.url, `/events?channel=${CHANNEL_2}`)
      const text = await events.readUntil(received => received.includes('second channel message'))
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

      expect(await events.readUntil(received => received.includes('event: ping\n'))).toContain('event: ping\ndata: 1\n\n')
    })

    it('should ping every stream from one timer when several are open', async () => {
      const timers = spyOn(globalThis, 'setInterval')
      const { url } = start(createHub(), { pingMs: 20 })

      const first = await openEvents(url)
      const second = await openEvents(url)
      await first.readUntil(received => received.includes('event: ping\n'))
      await second.readUntil(received => received.includes('event: ping\n'))
      const created = timers.mock.calls.filter(([, ms]) => ms === 20).length
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

      expect(logs.find(entry => entry.event === 'client_connected')?.requestId).toBe(REQUEST_ID)
      expect(logs.find(entry => entry.event === 'client_disconnected')?.requestId).toBe(REQUEST_ID)
    })

    it('should log it when the IP is past the cap', async () => {
      const { url } = start(createHub())
      for (let i = 0; i < MAX_CONNECTIONS_PER_IP; i++) await openEvents(url)
      const logs = captureLogs()

      const rejected = await openEvents(url, '/events', headers)

      expect(rejected.res.status).toBe(429)
      expect(logs.find(entry => entry.event === 'client_rejected')?.requestId).toBe(REQUEST_ID)
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
        await reader.readUntil(received => received.includes(`id: ${last}`))
      }

      expect(hub.subscriberCount()).toBe(1)
      expect(logs.find(entry => entry.event === 'client_dropped')?.requestId).toBe('stalled-request')
      const again = await openEvents(url, '/events', { 'X-Real-IP': '203.0.113.7' })
      expect(again.res.status).toBe(200)
    }, 20_000)

    it('should keep the client when its replay is larger than the limit', async () => {
      const hub = createHub()
      const body = 'x'.repeat(300 * 1024)
      for (let i = 1; i <= 5; i++) hub.publish(makeMsg(`130200000000000000${i}`, body))
      const { url } = start(hub)

      const events = await openEvents(url)
      await events.readUntil(received => received.includes('id: 1302000000000000005'))
      hub.publish(makeMsg('1302000000000000006', 'after the replay'))

      await events.readUntil(received => received.includes('after the replay'))
      expect(hub.subscriberCount()).toBe(1)
    })
  })
})
