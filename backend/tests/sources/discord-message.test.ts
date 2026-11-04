import { describe, expect, it } from 'bun:test'
import { isMissingContent, toMsg, type MessageLike } from '../../sources/discord-message.ts'
import { makeDiscordMessage } from './fixtures.ts'

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
