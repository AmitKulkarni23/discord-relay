import { describe, expect, it } from 'bun:test'
import type { Msg } from '../backend/types.ts'
import {
  addMsg,
  buildRows,
  compareIds,
  eventsUrl,
  fetchConfig,
  MAX_MSGS,
  MAX_RETRY_MS,
  parseConfig,
  parseMarkup,
  parseMsg,
  retryDelay,
  sortMsgs,
  type Part,
} from './feed.ts'

const CHANNEL = '1566584977829900002'

/** Builds a realistic message; `id` doubles as ordering, `at` is the ISO time. */
function makeMsg(id: string, at: string, author = 'relay_tester', overrides: Partial<Msg> = {}): Msg {
  return {
    id,
    channelId: CHANNEL,
    author: { id: `9616757156344000${author.length}`, name: author, avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png', bot: false },
    content: `message ${id} from ${author}`,
    createdAt: at,
    editedAt: null,
    attachments: [],
    ...overrides,
  }
}

describe('compareIds', () => {
  describe('when snowflakes have different lengths', () => {
    it('should order the shorter ID first when compared as numbers', () => {
      expect(compareIds('999999999999999999', '1000000000000000000')).toBeLessThan(0)
    })
  })

  describe('when snowflakes have the same length', () => {
    it('should order by digits when lengths match', () => {
      expect(compareIds('1566588496691400002', '1566588496691400001')).toBeGreaterThan(0)
      expect(compareIds('1566588496691400001', '1566588496691400001')).toBe(0)
    })
  })
})

describe('addMsg', () => {
  describe('when a new message arrives', () => {
    it('should store it keyed by ID when it was not held before', () => {
      const m = makeMsg('1566588496691400001', '2026-11-01T23:03:23.418Z')

      const next = addMsg(new Map(), m)

      expect(next.get(m.id)).toEqual(m)
    })
  })

  describe('when the same message is resent on reconnect', () => {
    it('should return the same map when nothing changed', () => {
      const m = makeMsg('1566588496691400001', '2026-11-01T23:03:23.418Z')
      const held = addMsg(new Map(), m)

      expect(addMsg(held, { ...m })).toBe(held)
    })

    it('should replace the stored copy when the message was edited', () => {
      const m = makeMsg('1566588496691400001', '2026-11-01T23:03:23.418Z')
      const held = addMsg(new Map(), m)
      const edited = { ...m, content: 'fixed typo', editedAt: '2026-11-01T23:05:00.000Z' }

      const next = addMsg(held, edited)

      expect(next.size).toBe(1)
      expect(next.get(m.id)?.content).toBe('fixed typo')
    })
  })

  describe('when the list is full', () => {
    it('should drop the oldest message when one more arrives', () => {
      let held = new Map<string, Msg>()
      for (let i = 0; i < MAX_MSGS; i++) held = addMsg(held, makeMsg(String(1566588496691400000n + BigInt(i) * 1000n), '2026-11-01T23:00:00.000Z'))
      const oldest = sortMsgs(held)[0]?.id

      held = addMsg(held, makeMsg('1566588496699999999', '2026-11-01T23:59:00.000Z'))

      expect(held.size).toBe(MAX_MSGS)
      expect(oldest && held.has(oldest)).toBe(false)
      expect(held.has('1566588496699999999')).toBe(true)
    })
  })
})

describe('parseMsg', () => {
  describe('when the event data is a valid message', () => {
    it('should return the message when every field has the right type', () => {
      const m = makeMsg('1566588496691400001', '2026-11-01T23:03:23.418Z')

      expect(parseMsg(JSON.stringify(m))).toEqual(m)
    })
  })

  describe('when the message has attachments', () => {
    const attachment = {
      url: 'https://cdn.discordapp.com/attachments/1/2/build-log.png',
      name: 'build-log.png',
      contentType: 'image/png',
      size: 2048,
      width: 640,
      height: 480,
    }
    const withAttachment = (a: unknown): string => JSON.stringify({ ...makeMsg('1566588496691400001', '2026-11-01T23:03:23.418Z'), attachments: [a] })

    it('should keep an attachment when every field has the right type', () => {
      expect(parseMsg(withAttachment(attachment))?.attachments).toEqual([attachment])
    })

    it('should keep an attachment when its type and dimensions are unknown', () => {
      const unknownFile = { ...attachment, contentType: null, width: null, height: null }

      expect(parseMsg(withAttachment(unknownFile))?.attachments).toEqual([unknownFile])
    })

    it('should return null when any attachment field is missing or mistyped', () => {
      const bad = [
        null,
        'build-log.png',
        { ...attachment, url: 42 },
        { ...attachment, name: null },
        { ...attachment, contentType: 7 },
        { ...attachment, size: '2048' },
        { ...attachment, width: '640' },
        { ...attachment, height: '480' },
      ]

      for (const a of bad) expect(parseMsg(withAttachment(a))).toBeNull()
    })

    it('should return null when attachments is not a list', () => {
      const m = makeMsg('1566588496691400001', '2026-11-01T23:03:23.418Z')

      expect(parseMsg(JSON.stringify({ ...m, attachments: attachment }))).toBeNull()
    })
  })

  describe('when the event data is malformed', () => {
    it('should return null when the data is not JSON', () => {
      expect(parseMsg('not json')).toBeNull()
    })

    it('should return null when a required field is missing or mistyped', () => {
      const m = makeMsg('1566588496691400001', '2026-11-01T23:03:23.418Z')
      expect(parseMsg(JSON.stringify({ ...m, author: { name: 'relay_tester' } }))).toBeNull()
      expect(parseMsg(JSON.stringify({ ...m, id: 42 }))).toBeNull()
    })
  })
})

describe('buildRows', () => {
  describe('when one author posts several times within five minutes', () => {
    it('should start one group and mark the rest as continuations', () => {
      const msgs = [
        makeMsg('1566588496691400001', '2026-11-01T23:00:00.000Z'),
        makeMsg('1566588496691400002', '2026-11-01T23:02:00.000Z'),
        makeMsg('1566588496691400003', '2026-11-01T23:04:59.000Z'),
      ]

      const rows = buildRows(msgs)

      expect(rows.filter(r => r.kind === 'msg').map(r => r.kind === 'msg' && r.head)).toEqual([true, false, false])
    })
  })

  describe('when the author changes or the gap is long', () => {
    it('should start a new group when another author posts', () => {
      const rows = buildRows([
        makeMsg('1566588496691400001', '2026-11-01T23:00:00.000Z', 'relay_tester'),
        makeMsg('1566588496691400002', '2026-11-01T23:00:30.000Z', 'ana_r'),
      ])

      expect(rows.filter(r => r.kind === 'msg').map(r => r.kind === 'msg' && r.head)).toEqual([true, true])
    })

    it('should start a new group when more than five minutes pass', () => {
      const rows = buildRows([makeMsg('1566588496691400001', '2026-11-01T23:00:00.000Z'), makeMsg('1566588496691400002', '2026-11-01T23:05:01.000Z')])

      expect(rows.filter(r => r.kind === 'msg').map(r => r.kind === 'msg' && r.head)).toEqual([true, true])
    })
  })

  describe('when messages span two days', () => {
    it('should insert a day divider before each new local day', () => {
      const first = new Date(2026, 10, 1, 23, 50).toISOString()
      const second = new Date(2026, 10, 2, 0, 10).toISOString()

      const rows = buildRows([makeMsg('1566588496691400001', first), makeMsg('1566588496691400002', second)])

      expect(rows.map(r => r.kind)).toEqual(['day', 'msg', 'day', 'msg'])
    })
  })
})

describe('parseConfig', () => {
  describe('when /config returns the expected shape', () => {
    it('should return the channels and the attachments flag when every field is valid', () => {
      const config = parseConfig({
        attachments: true,
        editsDeletes: false,
        debugPanel: false,
        channels: [
          { id: '1566584977829900002', name: 'relay' },
          { id: '1566584977829900003', name: null },
        ],
      })

      expect(config).toEqual({
        attachments: true,
        channels: [
          { id: '1566584977829900002', name: 'relay' },
          { id: '1566584977829900003', name: null },
        ],
      })
    })
  })

  describe('when /config returns something unexpected', () => {
    it('should fall back to no channels and attachments off when the value is not an object', () => {
      expect(parseConfig('<html>502 Bad Gateway</html>')).toEqual({ attachments: false, channels: [] })
    })

    it('should drop channel entries that are malformed when some are valid', () => {
      const config = parseConfig({ attachments: 'yes', channels: [{ id: 42 }, { id: '1566584977829900002', name: 'relay' }, null] })

      expect(config).toEqual({ attachments: false, channels: [{ id: '1566584977829900002', name: 'relay' }] })
    })
  })
})

describe('retryDelay', () => {
  describe('when retries keep failing', () => {
    it('should double the ceiling until the maximum when the random draw is at its top', () => {
      const top = () => 1
      expect([0, 1, 2, 3, 4, 5, 6, 99].map(attempt => retryDelay(attempt, top))).toEqual([
        1000,
        2000,
        4000,
        8000,
        16_000,
        MAX_RETRY_MS,
        MAX_RETRY_MS,
        MAX_RETRY_MS,
      ])
    })

    it('should spread the wait across the whole window when the random draw varies', () => {
      expect(retryDelay(2, () => 0)).toBe(0)
      expect(retryDelay(2, () => 0.5)).toBe(2000)
    })
  })
})

describe('eventsUrl', () => {
  describe('when connecting for the first time', () => {
    it('should omit since when no message has been seen', () => {
      expect(eventsUrl(null, null)).toBe('/events')
      expect(eventsUrl(CHANNEL, null)).toBe(`/events?channel=${CHANNEL}`)
    })
  })

  describe('when reconnecting', () => {
    it('should send the newest seen ID when one is held', () => {
      expect(eventsUrl(null, '1566588496691400002')).toBe('/events?since=1566588496691400002')
      expect(eventsUrl(CHANNEL, '1566588496691400002')).toBe(`/events?channel=${CHANNEL}&since=1566588496691400002`)
    })
  })
})

describe('fetchConfig', () => {
  const GOOD = { attachments: true, channels: [{ id: CHANNEL, name: 'general' }] }
  const noWait = async (): Promise<void> => {}

  describe('when /config fails before it answers', () => {
    it('should retry until it succeeds when the server returns a 502', async () => {
      const replies = [new Response('Bad Gateway', { status: 502 }), Response.json(GOOD)]
      const get = async (): Promise<Response> => replies.shift() as Response

      expect(await fetchConfig(new AbortController().signal, get, noWait)).toEqual(GOOD)
      expect(replies).toHaveLength(0)
    })

    it('should retry when the network fails or the body is not JSON', async () => {
      let calls = 0
      const get = async (): Promise<Response> => {
        calls++
        if (calls === 1) throw new TypeError('Failed to fetch')
        return calls === 2 ? new Response('<html>') : Response.json(GOOD)
      }

      expect(await fetchConfig(new AbortController().signal, get, noWait)).toEqual(GOOD)
      expect(calls).toBe(3)
    })
  })

  describe('when the page stops waiting', () => {
    it('should return null when aborted between retries', async () => {
      const abort = new AbortController()
      const get = async (): Promise<Response> => {
        abort.abort()
        return new Response('Bad Gateway', { status: 502 })
      }

      expect(await fetchConfig(abort.signal, get, noWait)).toBeNull()
    })
  })
})

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
