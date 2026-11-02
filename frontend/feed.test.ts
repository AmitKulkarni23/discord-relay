import { describe, expect, it } from 'bun:test'
import type { Msg } from '../backend/types.ts'
import { addMsg, buildRows, compareIds, MAX_MSGS, parseConfig, parseMsg, sortMsgs } from './feed.ts'

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
      const rows = buildRows([
        makeMsg('1566588496691400001', '2026-11-01T23:00:00.000Z'),
        makeMsg('1566588496691400002', '2026-11-01T23:05:01.000Z'),
      ])

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
