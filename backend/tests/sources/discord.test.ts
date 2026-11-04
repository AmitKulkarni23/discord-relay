import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { Client, Events } from 'discord.js'
import { collectHistory, createWatchdog, isMissingContent, startDiscord, toMsg, type MessageLike } from '../../sources/discord.ts'
import type { Msg } from '../../types.ts'

/** Builds a realistic discord.js-shaped message; override any field per test. */
function makeDiscordMessage(overrides: Partial<MessageLike> = {}): MessageLike {
  return {
    id: '1302000000000000001',
    channelId: '1301000000000000001',
    content: 'deploy finished for build 482',
    cleanContent: 'deploy finished for build 482',
    createdAt: new Date('2026-11-01T17:00:00.000Z'),
    editedAt: null,
    author: {
      id: '1290000000000000042',
      username: 'amit_k',
      globalName: 'Amit',
      bot: false,
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1290000000000000042/abc.png',
    },
    attachments: new Map(),
    system: false,
    stickers: new Map(),
    embeds: [],
    poll: null,
    messageSnapshots: { first: () => undefined },
    ...overrides,
  }
}

/** A fake timer: records the scheduled callback so a test can fire it. */
function fakeTimers() {
  const pending = new Map<number, () => void>()
  let next = 0
  return {
    pending,
    setTimer: mock((fn: () => void) => {
      next += 1
      pending.set(next, fn)
      return next
    }),
    clearTimer: mock((handle: unknown) => {
      pending.delete(handle as number)
    }),
    /** Runs every pending callback, as if the time limit passed. */
    elapse() {
      for (const [handle, fn] of [...pending]) {
        pending.delete(handle)
        fn()
      }
    },
  }
}

describe('toMsg', () => {
  describe('when the author has a global name', () => {
    it('should use the global name when it is set', () => {
      expect(toMsg(makeDiscordMessage()).author.name).toBe('Amit')
    })
  })

  describe('when the author has no global name', () => {
    it('should fall back to the username when globalName is null', () => {
      const msg = makeDiscordMessage({
        author: { ...makeDiscordMessage().author, globalName: null },
      })
      expect(toMsg(msg).author.name).toBe('amit_k')
    })
  })

  describe('when a message is converted', () => {
    it('should use the text with mentions and custom emoji already resolved to names', () => {
      expect(toMsg(makeDiscordMessage({ cleanContent: '@Amit shipped it :party:' })).content).toBe('@Amit shipped it :party:')
    })

    it('should keep IDs, content, avatar and creation time when converted', () => {
      expect(toMsg(makeDiscordMessage())).toEqual({
        id: '1302000000000000001',
        channelId: '1301000000000000001',
        author: {
          id: '1290000000000000042',
          name: 'Amit',
          avatarUrl: 'https://cdn.discordapp.com/avatars/1290000000000000042/abc.png',
          bot: false,
        },
        content: 'deploy finished for build 482',
        note: null,
        createdAt: '2026-11-01T17:00:00.000Z',
        editedAt: null,
        attachments: [],
      })
    })
  })

  describe('when a message has attachments', () => {
    it('should keep url, name, content type, size and dimensions when attachments exist', () => {
      const attachment = {
        url: 'https://cdn.discordapp.com/attachments/1301000000000000001/1/build-log.png',
        name: 'build-log.png',
        contentType: 'image/png',
        size: 48213,
        width: 1280,
        height: 720,
      }
      const msg = makeDiscordMessage({ attachments: new Map([['1', attachment]]) })

      expect(toMsg(msg).attachments).toEqual([attachment])
    })

    it('should set width and height to null when the file is not an image or video', () => {
      const attachment = {
        url: 'https://cdn.discordapp.com/attachments/1301000000000000001/2/release-notes.pdf',
        name: 'release-notes.pdf',
        contentType: 'application/pdf',
        size: 90211,
        width: null,
        height: null,
      }
      const msg = makeDiscordMessage({ attachments: new Map([['2', attachment]]) })

      expect(toMsg(msg).attachments[0]).toMatchObject({ size: 90211, width: null, height: null })
    })
  })

  describe('when a message was edited', () => {
    it('should set editedAt as an ISO string when the message has an edit time', () => {
      const msg = makeDiscordMessage({ editedAt: new Date('2026-11-01T17:05:00.000Z') })
      expect(toMsg(msg).editedAt).toBe('2026-11-01T17:05:00.000Z')
    })
  })
})

describe('isMissingContent', () => {
  describe('when a message carries something other than typed text', () => {
    const snapshots = (snapshot: { content: string | null; attachments: Map<string, unknown> }) =>
      ({ first: () => snapshot }) as unknown as MessageLike['messageSnapshots']
    const file = {
      url: 'https://cdn.discordapp.com/attachments/1/2/build-log.png',
      name: 'build-log.png',
      contentType: 'image/png',
      size: 2048,
      width: 640,
      height: 480,
    }

    it('should fall back to the raw text when discord.js cannot clean it, because its channel is not cached', () => {
      const msg = toMsg(makeDiscordMessage({ content: 'ping <@961675715634400003>', cleanContent: null }))

      expect(msg.content).toBe('ping <@961675715634400003>')
    })

    it('should leave the note empty for an ordinary message', () => {
      expect(toMsg(makeDiscordMessage()).note).toBeNull()
    })

    it('should show the original text and files of a forward, labelled as forwarded', () => {
      const msg = toMsg(
        makeDiscordMessage({
          cleanContent: '',
          messageSnapshots: snapshots({ content: 'deploy finished for build 482', attachments: new Map([['1', file]]) }),
        }),
      )

      expect(msg.content).toBe('deploy finished for build 482')
      expect(msg.attachments.map(a => a.name)).toEqual(['build-log.png'])
      expect(msg.note).toBe('Forwarded')
    })

    it('should cope with a forward that has no text', () => {
      const msg = toMsg(makeDiscordMessage({ cleanContent: '', messageSnapshots: snapshots({ content: null, attachments: new Map() }) }))

      expect(msg.content).toBe('')
      expect(msg.note).toBe('Forwarded')
    })

    it('should name a sticker', () => {
      const msg = toMsg(makeDiscordMessage({ cleanContent: '', stickers: new Map([['1', { name: 'party parrot' }]]) }))

      expect(msg.content).toBe('')
      expect(msg.note).toBe('Sticker: party parrot')
    })

    it('should state a poll question', () => {
      const msg = toMsg(makeDiscordMessage({ cleanContent: '', poll: { question: { text: 'Ship it today?' } } }))

      expect(msg.note).toBe('Poll: Ship it today?')
    })

    it('should use the title and description of an embed-only message as its text', () => {
      const msg = toMsg(makeDiscordMessage({ cleanContent: '', embeds: [{ title: 'Build 482', description: 'All checks passed' }] }))

      expect(msg.content).toBe('Build 482\nAll checks passed')
      expect(msg.note).toBe('Embed')
    })

    it('should still label an embed with no text', () => {
      const msg = toMsg(makeDiscordMessage({ cleanContent: '', embeds: [{ title: null, description: null }] }))

      expect(msg.content).toBe('')
      expect(msg.note).toBe('Embed')
    })

    it('should ignore the link preview of a message that has text', () => {
      const msg = toMsg(makeDiscordMessage({ cleanContent: 'see https://railway.com', embeds: [{ title: 'Railway', description: 'Deploy anything' }] }))

      expect(msg.content).toBe('see https://railway.com')
      expect(msg.note).toBeNull()
    })

    it('should list everything when a message has several kinds', () => {
      const msg = toMsg(makeDiscordMessage({ stickers: new Map([['1', { name: 'party parrot' }]]), poll: { question: { text: 'Ship it today?' } } }))

      expect(msg.note).toBe('Sticker: party parrot · Poll: Ship it today?')
    })

    it('should not count a labelled message as missing its content', () => {
      expect(isMissingContent(toMsg(makeDiscordMessage({ cleanContent: '', stickers: new Map([['1', { name: 'party parrot' }]]) })))).toBe(false)
    })
  })

  describe('when content and attachments are empty', () => {
    it('should return true when there is nothing to show', () => {
      expect(isMissingContent(toMsg(makeDiscordMessage({ cleanContent: '' })))).toBe(true)
    })
  })

  describe('when the message has something to show', () => {
    it('should return false when there is an attachment but no text', () => {
      const msg = makeDiscordMessage({
        cleanContent: '',
        attachments: new Map([
          [
            '1',
            {
              url: 'https://cdn.discordapp.com/attachments/1301000000000000001/3/screenshot.png',
              name: 'screenshot.png',
              contentType: 'image/png',
              size: 20480,
              width: 800,
              height: 600,
            },
          ],
        ]),
      })
      expect(isMissingContent(toMsg(msg))).toBe(false)
    })

    it('should return false when there is text', () => {
      expect(isMissingContent(toMsg(makeDiscordMessage()))).toBe(false)
    })
  })
})

describe('createWatchdog', () => {
  describe('when disconnected longer than the limit', () => {
    it('should call onExpire once when the limit passes without reconnecting', () => {
      const timers = fakeTimers()
      const onExpire = mock()
      const watchdog = createWatchdog({ limitMs: 300_000, onExpire, ...timers })

      watchdog.disconnected()
      timers.elapse()

      expect(onExpire).toHaveBeenCalledTimes(1)
      expect(timers.setTimer).toHaveBeenCalledWith(expect.any(Function), 300_000)
    })
  })

  describe('when reconnected before the limit', () => {
    it('should not call onExpire when connected is reported in time', () => {
      const timers = fakeTimers()
      const onExpire = mock()
      const watchdog = createWatchdog({ limitMs: 300_000, onExpire, ...timers })

      watchdog.disconnected()
      watchdog.connected()
      timers.elapse()

      expect(onExpire).not.toHaveBeenCalled()
    })
  })

  describe('when disconnect is reported twice', () => {
    it('should keep the first deadline when already counting down', () => {
      const timers = fakeTimers()
      const watchdog = createWatchdog({ limitMs: 300_000, onExpire: mock(), ...timers })

      watchdog.disconnected()
      watchdog.disconnected()

      expect(timers.setTimer).toHaveBeenCalledTimes(1)
    })
  })
})

/**
 * A fake Discord history of `count` messages with increasing snowflake IDs.
 * Like discord.js, each page comes back newest first and `before` is exclusive.
 */
function fakeChannel(count: number) {
  const ids = Array.from({ length: count }, (_, i) => String(1302000000000000000n + BigInt(i)))
  const calls: Array<{ before: string | undefined; limit: number }> = []
  const fetchPage = async (before: string | undefined, limit: number) => {
    calls.push({ before, limit })
    const older = before === undefined ? ids : ids.filter(id => BigInt(id) < BigInt(before))
    return older
      .slice(-limit)
      .reverse()
      .map(id => ({ id }))
  }
  return { ids, calls, fetchPage }
}

describe('collectHistory', () => {
  describe('when the limit fits in one page', () => {
    it('should make one request and return messages oldest first when the limit is 100 or less', async () => {
      const ch = fakeChannel(150)

      const got = await collectHistory(ch.fetchPage, 40)

      expect(ch.calls).toEqual([{ before: undefined, limit: 40 }])
      expect(got.map(m => m.id)).toEqual(ch.ids.slice(-40))
    })
  })

  describe('when the limit spans several pages', () => {
    it('should page back with before and return the newest messages oldest first when the limit is 250', async () => {
      const ch = fakeChannel(400)

      const got = await collectHistory(ch.fetchPage, 250)

      expect(ch.calls.map(c => c.limit)).toEqual([100, 100, 50])
      expect(ch.calls[1]?.before).toBe(ch.ids[300])
      expect(got.map(m => m.id)).toEqual(ch.ids.slice(-250))
    })
  })

  describe('when the channel has fewer messages than the limit', () => {
    it('should stop after a short page when the channel runs out', async () => {
      const ch = fakeChannel(130)

      const got = await collectHistory(ch.fetchPage, 500)

      expect(ch.calls).toHaveLength(2)
      expect(got.map(m => m.id)).toEqual(ch.ids)
    })
  })
})

const CHANNEL = '1301000000000000001'
/** A message discord.js could hand over that toMsg cannot convert. */
const MALFORMED = { author: null } as unknown as Partial<MessageLike>

/** Runs the real startDiscord and discord.js Client with login and the channel faked, so nothing touches the network. */
function startFakeDiscord(history: MessageLike[]) {
  const logs: Array<Record<string, unknown>> = []
  spyOn(console, 'log').mockImplementation((line: string) => {
    logs.push(JSON.parse(line) as Record<string, unknown>)
  })
  let client: Client | undefined
  const login = spyOn(Client.prototype, 'login').mockImplementation(async function (this: Client) {
    client = this
    return 'token'
  })
  const published: Msg[] = []
  const discord = startDiscord({ token: 'token', channelIds: [CHANNEL], publish: m => published.push(m) })
  login.mockRestore()
  if (!client) throw new Error('login was not called')
  const channel = {
    isTextBased: () => true,
    name: 'general',
    // Newest first, as Discord returns them. Every message fits on the first page.
    messages: { fetch: async () => new Map([...history].reverse().map(m => [m.id, m])) },
  }
  const fetchChannel = spyOn(client.channels, 'fetch').mockResolvedValue(channel as never)
  return { client, discord, published, logs, fetchChannel }
}

/** Polls until `cond` holds, failing after a second. */
async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await Bun.sleep(1)
  }
}

describe('startDiscord', () => {
  let stop = async (): Promise<void> => {}
  afterEach(async () => {
    await stop()
    mock.restore()
  })

  describe('when a message cannot be converted', () => {
    it('should log it and keep going when it arrives live', () => {
      const fake = startFakeDiscord([])
      stop = fake.discord.stop

      fake.client.emit(Events.MessageCreate, makeDiscordMessage({ id: '1302000000000000001', ...MALFORMED }) as never)
      fake.client.emit(Events.MessageCreate, makeDiscordMessage({ id: '1302000000000000002' }) as never)

      expect(fake.published.map(m => m.id)).toEqual(['1302000000000000002'])
      expect(fake.logs).toContainEqual(expect.objectContaining({ level: 'error', event: 'message_skipped', messageId: '1302000000000000001' }))
    })

    it('should still load the rest of the channel when it is in the history', async () => {
      const history = [
        makeDiscordMessage({ id: '1302000000000000001' }),
        makeDiscordMessage({ id: '1302000000000000002', ...MALFORMED }),
        makeDiscordMessage({ id: '1302000000000000003' }),
      ]
      const fake = startFakeDiscord(history)
      stop = fake.discord.stop

      fake.client.emit(Events.ClientReady, fake.client as never)
      await waitFor(() => fake.logs.some(l => l.event === 'history_loaded' || l.event === 'history_failed'))

      expect(fake.published.map(m => m.id)).toEqual(['1302000000000000001', '1302000000000000003'])
      expect(fake.logs).not.toContainEqual(expect.objectContaining({ event: 'history_failed' }))
    })
  })

  describe('when the Gateway starts a fresh session after startup', () => {
    /** Starts a fake bot and waits for its startup history. */
    async function startReady(history: MessageLike[]) {
      const fake = startFakeDiscord(history)
      stop = fake.discord.stop
      // discord.js emits these in this order on the first connection.
      fake.client.emit(Events.ShardReady, 0, undefined)
      fake.client.emit(Events.ClientReady, fake.client as never)
      await waitFor(() => fake.logs.some(l => l.event === 'history_loaded'))
      return fake
    }

    it('should load history once when the first session starts', async () => {
      const fake = await startReady([makeDiscordMessage({ id: '1302000000000000001' })])

      expect(fake.fetchChannel).toHaveBeenCalledTimes(1)
    })

    it('should publish messages posted during the gap when a new session is ready', async () => {
      const history = [makeDiscordMessage({ id: '1302000000000000001' })]
      const fake = await startReady(history)
      history.push(makeDiscordMessage({ id: '1302000000000000002' }))

      fake.client.emit(Events.ShardReady, 0, undefined)
      await waitFor(() => fake.published.some(m => m.id === '1302000000000000002'))

      expect(fake.fetchChannel).toHaveBeenCalledTimes(2)
    })

    it('should not reload history when the session resumes because Discord replays what was missed', async () => {
      const fake = await startReady([makeDiscordMessage({ id: '1302000000000000001' })])

      fake.client.emit(Events.ShardResume, 0, 0)

      expect(fake.fetchChannel).toHaveBeenCalledTimes(1)
    })
  })

  describe('when Discord posts a system message', () => {
    it('should not publish a join, pin or boost as it arrives', () => {
      const fake = startFakeDiscord([])
      stop = fake.discord.stop

      fake.client.emit(Events.MessageCreate, makeDiscordMessage({ id: '1302000000000000001', cleanContent: '', system: true }) as never)
      fake.client.emit(Events.MessageCreate, makeDiscordMessage({ id: '1302000000000000002' }) as never)

      expect(fake.published.map(m => m.id)).toEqual(['1302000000000000002'])
      expect(fake.logs.filter(l => l.event === 'message_content_missing')).toHaveLength(0)
    })

    it('should leave it out of history too', async () => {
      const history = [makeDiscordMessage({ id: '1302000000000000002' }), makeDiscordMessage({ id: '1302000000000000001', cleanContent: '', system: true })]
      const fake = startFakeDiscord(history)
      stop = fake.discord.stop

      fake.client.emit(Events.ClientReady, fake.client as never)
      await waitFor(() => fake.logs.some(l => l.event === 'history_loaded'))

      expect(fake.published.map(m => m.id)).toEqual(['1302000000000000002'])
    })
  })

  describe('when messages have no text and no attachments', () => {
    it('should warn once and still publish each one when several arrive', () => {
      const fake = startFakeDiscord([])
      stop = fake.discord.stop

      for (const id of ['1302000000000000001', '1302000000000000002']) {
        fake.client.emit(Events.MessageCreate, makeDiscordMessage({ id, cleanContent: '' }) as never)
      }

      expect(fake.logs.filter(l => l.event === 'message_content_missing')).toHaveLength(1)
      expect(fake.published).toHaveLength(2)
    })
  })
})
