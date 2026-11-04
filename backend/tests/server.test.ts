import { describe, expect, it } from 'bun:test'
import type { Flags } from '../flags.ts'
import { createHub } from '../hub.ts'
import { startServer } from '../server.ts'
import { CHANNEL, CHANNEL_2, captureLogs, makeMsg, openEvents, start, waitFor } from './helpers.ts'

describe('server', () => {
  describe('when a channel cannot be read', () => {
    it('should stay healthy, since a restart would not help, and name the channel in /health', async () => {
      const { url } = start(createHub(), { available: false })

      const res = await fetch(new URL('/health', url))
      const body = (await res.json()) as { unavailableChannels: string[] }

      expect(res.status).toBe(200)
      expect(body.unavailableChannels).toEqual([CHANNEL, CHANNEL_2])
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
