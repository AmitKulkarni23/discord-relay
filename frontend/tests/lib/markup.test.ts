import { describe, expect, it } from 'bun:test'
import { parseMarkup, type Part } from '../../lib/markup.ts'

describe('parseMarkup', () => {
  describe('links', () => {
    it('should keep plain text as one part', () => {
      expect(parseMarkup('no links here')).toEqual([{ kind: 'text', text: 'no links here' }])
    })

    it('should split out an https link with the text around it', () => {
      expect(parseMarkup('see https://railway.com/docs now')).toEqual([
        { kind: 'text', text: 'see ' },
        { kind: 'link', href: 'https://railway.com/docs' },
        { kind: 'text', text: ' now' },
      ])
    })

    it('should leave trailing punctuation out of a link', () => {
      expect(parseMarkup('go to http://a.com/b.')).toEqual([
        { kind: 'text', text: 'go to ' },
        { kind: 'link', href: 'http://a.com/b' },
        { kind: 'text', text: '.' },
      ])
    })

    it('should keep a closing bracket that belongs to the URL and drop one that does not', () => {
      expect(parseMarkup('https://a.com/x_(y)')).toEqual([{ kind: 'link', href: 'https://a.com/x_(y)' }])
      expect(parseMarkup('(https://a.com/x)')).toEqual([
        { kind: 'text', text: '(' },
        { kind: 'link', href: 'https://a.com/x' },
        { kind: 'text', text: ')' },
      ])
    })

    it('should never link a script or data URL', () => {
      for (const text of ['javascript:alert(1)', 'data:text/html,x', 'JAVASCRIPT://a.com']) {
        expect(parseMarkup(text)).toEqual([{ kind: 'text', text }])
      }
    })
  })

  describe('Discord formatting', () => {
    const text = (t: string): Part => ({ kind: 'text', text: t })

    it('should parse bold, italic, underline, strikethrough and spoilers', () => {
      expect(parseMarkup('**a**')).toEqual([{ kind: 'bold', parts: [text('a')] }])
      expect(parseMarkup('*a*')).toEqual([{ kind: 'italic', parts: [text('a')] }])
      expect(parseMarkup('_a_')).toEqual([{ kind: 'italic', parts: [text('a')] }])
      expect(parseMarkup('__a__')).toEqual([{ kind: 'underline', parts: [text('a')] }])
      expect(parseMarkup('~~a~~')).toEqual([{ kind: 'strike', parts: [text('a')] }])
      expect(parseMarkup('||a||')).toEqual([{ kind: 'spoiler', parts: [text('a')] }])
    })

    it('should nest formatting and links', () => {
      expect(parseMarkup('***a***')).toEqual([{ kind: 'bold', parts: [{ kind: 'italic', parts: [text('a')] }] }])
      expect(parseMarkup('**see https://a.com**')).toEqual([{ kind: 'bold', parts: [text('see '), { kind: 'link', href: 'https://a.com' }] }])
    })

    it('should not parse anything inside code', () => {
      expect(parseMarkup('`**a** https://a.com`')).toEqual([{ kind: 'code', text: '**a** https://a.com' }])
    })

    it('should drop a code block language and its edge newlines', () => {
      expect(parseMarkup('```ts\nconst a = 1\n```')).toEqual([{ kind: 'block', text: 'const a = 1' }])
      expect(parseMarkup('```plain```')).toEqual([{ kind: 'block', text: 'plain' }])
    })

    it('should drop one line break on each side of a code block, since the block already sits on its own line', () => {
      expect(parseMarkup('before\n```a```\nafter')).toEqual([text('before'), { kind: 'block', text: 'a' }, text('after')])
      expect(parseMarkup('before\n\n```a```')).toEqual([text('before\n'), { kind: 'block', text: 'a' }])
    })

    it('should keep escaped characters literal and join them with the text around them', () => {
      expect(parseMarkup('\\*a\\*')).toEqual([text('*a*')])
    })

    it('should leave text that only looks like formatting alone', () => {
      for (const t of ['**unclosed', 'snake_case_name', 'a * b * c', 'a_b', '|| ']) expect(parseMarkup(t)).toEqual([text(t)])
    })

    it('should link a URL wrapped to suppress its preview', () => {
      expect(parseMarkup('<https://a.com/b>')).toEqual([{ kind: 'link', href: 'https://a.com/b' }])
    })

    it('should not treat formatting characters inside a URL as formatting', () => {
      expect(parseMarkup('https://a.com/x__y__z')).toEqual([{ kind: 'link', href: 'https://a.com/x__y__z' }])
    })

    it('should turn a Discord timestamp into a time', () => {
      expect(parseMarkup('<t:1618953630:R>')).toEqual([{ kind: 'time', iso: '2021-04-20T21:20:30.000Z' }])
      expect(parseMarkup('<t:1618953630>')).toEqual([{ kind: 'time', iso: '2021-04-20T21:20:30.000Z' }])
    })

    it('should leave a timestamp too large to be a date as text', () => {
      expect(parseMarkup('<t:999999999999999>')).toEqual([text('<t:999999999999999>')])
    })
  })
})
