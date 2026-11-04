import { describe, expect, it } from 'bun:test'
import type { Msg } from '../../../backend/types.ts'
import { addMsg, buildRows, MAX_MSGS, parseDeletedId, parseMsg, removeMsg, sortMsgs } from '../../lib/messages.ts'

const CHANNEL = '1566584977829900002'

/** Builds a realistic message; `id` doubles as ordering, `at` is the ISO time. */
function makeMsg(id: string, at: string, author = 'relay_tester', overrides: Partial<Msg> = {}): Msg {
  return {
    id,
    channelId: CHANNEL,
    author: { id: `9616757156344000${author.length}`, name: author, avatarUrl: 'https://cdn.discordapp.com/embed/avatars/0.png', bot: false },
    content: `message ${id} from ${author}`,
    note: null,
    createdAt: at,
    editedAt: null,
    attachments: [],
    ...overrides,
  }
}

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

describe('removeMsg', () => {
  const m = makeMsg('1566588496691400001', '2026-11-01T23:03:23.418Z')

  describe('when the message is held', () => {
    it('should return a list without it', () => {
      const held = addMsg(new Map(), m)

      const next = removeMsg(held, m.id)

      expect(next.size).toBe(0)
      expect(held.size).toBe(1)
    })
  })

  describe('when the message is not held', () => {
    it('should return the same list, so nothing re-renders', () => {
      const held = addMsg(new Map(), m)

      expect(removeMsg(held, '1566588496691400009')).toBe(held)
    })
  })
})

describe('parseDeletedId', () => {
  describe('when the event data names a message', () => {
    it('should return its ID', () => {
      expect(parseDeletedId('{"id":"1566588496691400001","channelId":"1566584977829900002"}')).toBe('1566588496691400001')
    })
  })

  describe('when the event data is malformed', () => {
    it('should return null', () => {
      expect(parseDeletedId('not json')).toBeNull()
      expect(parseDeletedId('{"id":42}')).toBeNull()
      expect(parseDeletedId('null')).toBeNull()
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

    it('should return null when the note is mistyped', () => {
      const m = makeMsg('1566588496691400001', '2026-11-01T23:03:23.418Z')

      expect(parseMsg(JSON.stringify({ ...m, note: 7 }))).toBeNull()
    })

    it('should return null when a date is not a date, since formatting it would throw during render', () => {
      const m = makeMsg('1566588496691400001', '2026-11-01T23:03:23.418Z')

      expect(parseMsg(JSON.stringify({ ...m, createdAt: 'not a date' }))).toBeNull()
      expect(parseMsg(JSON.stringify({ ...m, editedAt: 'not a date' }))).toBeNull()
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
