import { describe, expect, it } from 'bun:test'
import { attachmentKind, fitBox, formatBytes, isDiscordCdn } from './media.ts'

describe('isDiscordCdn', () => {
  describe('when the URL is on a Discord CDN host', () => {
    it('should allow it when the host is cdn.discordapp.com or media.discordapp.net', () => {
      expect(isDiscordCdn('https://cdn.discordapp.com/avatars/961675715634400003/a1b2c3.png')).toBe(true)
      expect(isDiscordCdn('https://media.discordapp.net/attachments/1/2/build-log.png')).toBe(true)
    })
  })

  describe('when the URL is anywhere else', () => {
    it('should reject it when the host, scheme or value is wrong', () => {
      expect(isDiscordCdn('https://cdn.discordapp.com.evil.example/a.png')).toBe(false)
      expect(isDiscordCdn('http://cdn.discordapp.com/a.png')).toBe(false)
      expect(isDiscordCdn('javascript:alert(1)')).toBe(false)
      expect(isDiscordCdn(null)).toBe(false)
    })
  })
})

describe('attachmentKind', () => {
  describe('when the content type is known', () => {
    it('should pick image, video or audio from the MIME type when it starts with that kind', () => {
      expect(attachmentKind('image/png')).toBe('image')
      expect(attachmentKind('video/mp4')).toBe('video')
      expect(attachmentKind('audio/ogg')).toBe('audio')
    })
  })

  describe('when the content type is anything else', () => {
    it('should treat it as a plain file when the type is missing or not media', () => {
      expect(attachmentKind('application/pdf')).toBe('file')
      expect(attachmentKind(null)).toBe('file')
      expect(attachmentKind('image/svg+xml')).toBe('file')
    })
  })
})

describe('formatBytes', () => {
  describe('when a size is formatted', () => {
    it('should use the largest unit that keeps the number at or above 1 when given bytes', () => {
      expect(formatBytes(512)).toBe('512 B')
      expect(formatBytes(48213)).toBe('47.1 KB')
      expect(formatBytes(25 * 1024 * 1024)).toBe('25.0 MB')
    })
  })
})

describe('fitBox', () => {
  describe('when the media is larger than the box', () => {
    it('should scale down keeping the aspect ratio when the width is the limit', () => {
      expect(fitBox(1280, 720, 400, 320)).toEqual({ width: 400, height: 225 })
    })

    it('should scale down keeping the aspect ratio when the height is the limit', () => {
      expect(fitBox(600, 1200, 400, 320)).toEqual({ width: 160, height: 320 })
    })
  })

  describe('when the media is small or has no size', () => {
    it('should keep the size when it already fits', () => {
      expect(fitBox(120, 80, 400, 320)).toEqual({ width: 120, height: 80 })
    })

    it('should return null when width or height is unknown', () => {
      expect(fitBox(null, 720, 400, 320)).toBeNull()
    })
  })
})
