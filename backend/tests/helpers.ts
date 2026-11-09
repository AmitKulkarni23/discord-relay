import { afterEach, spyOn } from 'bun:test'
import type { Flags } from '../platform/flags.ts'
import type { Hub } from '../core/hub.ts'
import { startServer } from '../server.ts'
import type { Msg } from '../core/types.ts'

export const CHANNEL = '1301000000000000001'
export const CHANNEL_2 = '1301000000000000002'

/** Builds a realistic message for the test channel. */
export function makeMsg(id: string, content = `deploy finished for build ${id}`, channelId = CHANNEL, createdAt = '2026-11-01T17:00:00.000Z'): Msg {
  return {
    id,
    channelId,
    author: { id: '1290000000000000042', name: 'amit', avatarUrl: null, bot: false },
    content,
    note: null,
    createdAt,
    editedAt: null,
    attachments: [],
  }
}

/** Polls `cond` until it is true, failing after `ms`. */
export async function waitFor(cond: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(5)
  }
}

/** Opens /events and returns helpers to read the stream as text. */
export async function openEvents(base: URL, path = '/events', headers: Record<string, string> = {}) {
  const abort = new AbortController()
  const res = await fetch(new URL(path, base), { signal: abort.signal, headers })
  if (!res.body) throw new Error('no response body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''

  /** Reads chunks until the accumulated text satisfies `pred`. */
  async function readUntil(isDone: (received: string) => boolean): Promise<string> {
    while (!isDone(text)) {
      const { value, done } = await reader.read()
      if (done) throw new Error('stream ended')
      text += decoder.decode(value, { stream: true })
    }
    return text
  }

  return { res, reader, readUntil, abort: () => abort.abort() }
}

/** Captures the JSON log lines written during a test. Undone by `afterEach`. */
export function captureLogs(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = []
  const spy = spyOn(console, 'log').mockImplementation((line: string) => {
    lines.push(JSON.parse(line) as Record<string, unknown>)
  })
  stops.push(() => spy.mockRestore())
  return lines
}

export const stops: Array<() => void> = []
afterEach(() => {
  while (stops.length) stops.pop()?.()
})

/** Starts a server on a random port with test defaults. */
export function start(
  hub: Hub,
  overrides: { connected?: boolean; loginFailed?: boolean; available?: boolean; pingMs?: number; channelName?: string | null; flags?: () => Flags } = {},
) {
  const server = startServer({
    port: 0,
    hub,
    channelIds: [CHANNEL, CHANNEL_2],
    flags: overrides.flags ?? (() => ({ attachments: true, editsDeletes: false, debugPanel: false })),
    isDiscordConnected: () => overrides.connected ?? true,
    isChannelAvailable: () => overrides.available ?? true,
    isLoginFailed: () => overrides.loginFailed ?? false,
    channels: () => [
      { id: CHANNEL, name: overrides.channelName === undefined ? 'relay-test' : overrides.channelName },
      { id: CHANNEL_2, name: 'announcements' },
    ],
    pingMs: overrides.pingMs ?? 60_000,
  })
  stops.push(server.stop)
  return server
}
