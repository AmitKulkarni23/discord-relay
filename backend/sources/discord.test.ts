import { describe, expect, it, mock } from 'bun:test'
import { createWatchdog, isMissingContent, toMsg, type MessageLike } from './discord.ts'

/** Builds a realistic discord.js-shaped message; override any field per test. */
function makeDiscordMessage(overrides: Partial<MessageLike> = {}): MessageLike {
  return {
    id: '1302000000000000001',
    channelId: '1301000000000000001',
    content: 'deploy finished for build 482',
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
        createdAt: '2026-11-01T17:00:00.000Z',
        editedAt: null,
        attachments: [],
      })
    })
  })

  describe('when a message has attachments', () => {
    it('should keep url, name and content type when attachments exist', () => {
      const attachment = {
        url: 'https://cdn.discordapp.com/attachments/1301000000000000001/1/build-log.png',
        name: 'build-log.png',
        contentType: 'image/png',
      }
      const msg = makeDiscordMessage({ attachments: new Map([['1', attachment]]) })

      expect(toMsg(msg).attachments).toEqual([attachment])
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
  describe('when content and attachments are empty', () => {
    it('should return true when there is nothing to show', () => {
      expect(isMissingContent(toMsg(makeDiscordMessage({ content: '' })))).toBe(true)
    })
  })

  describe('when the message has something to show', () => {
    it('should return false when there is an attachment but no text', () => {
      const msg = makeDiscordMessage({
        content: '',
        attachments: new Map([['1', { url: 'https://cdn.discordapp.com/a.png', name: 'a.png', contentType: 'image/png' }]]),
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
