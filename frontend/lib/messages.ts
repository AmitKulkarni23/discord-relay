import { compareIds, type Attachment, type Msg } from '../../backend/types.ts'

/** The most messages the browser holds; the oldest are dropped past this. */
export const MAX_MSGS = 500

/** Messages from one author closer together than this share a group header. */
const GROUP_GAP_MS = 5 * 60_000

/**
 * Stores `m` keyed by ID. A resend with the same edit time returns `prev`
 * unchanged, so a reconnect replay causes no re-render. Drops the oldest
 * message once more than MAX_MSGS are held.
 */
export function addMsg(prev: Map<string, Msg>, m: Msg): Map<string, Msg> {
  const held = prev.get(m.id)
  if (held && held.editedAt === m.editedAt) return prev
  const next = new Map(prev).set(m.id, m)
  if (next.size > MAX_MSGS) {
    let oldest = m.id
    for (const id of next.keys()) if (compareIds(id, oldest) < 0) oldest = id
    next.delete(oldest)
  }
  return next
}

/** The held messages, oldest first. */
export function sortMsgs(msgs: Map<string, Msg>): Msg[] {
  return [...msgs.values()].sort((a, b) => compareIds(a.id, b.id))
}

/** One line of the feed: a day divider, or a message that may start a group. */
export type Row = { kind: 'day'; key: string; date: Date } | { kind: 'msg'; key: string; msg: Msg; head: boolean }

/** Turns sorted messages into feed rows with day dividers and author groups. */
export function buildRows(msgs: Msg[]): Row[] {
  const rows: Row[] = []
  let prev: Msg | undefined
  for (const msg of msgs) {
    const at = new Date(msg.createdAt)
    const prevAt = prev ? new Date(prev.createdAt) : undefined
    const newDay = !prevAt || prevAt.toDateString() !== at.toDateString()
    if (newDay) rows.push({ kind: 'day', key: `day-${at.toDateString()}`, date: at })
    const head = newDay || !prev || !prevAt || prev.author.id !== msg.author.id || at.getTime() - prevAt.getTime() > GROUP_GAP_MS
    rows.push({ kind: 'msg', key: msg.id, msg, head })
    prev = msg
  }
  return rows
}

/** Parses one SSE `data:` payload into a Msg, or null when it does not match the shape. */
export function parseMsg(data: string): Msg | null {
  let v: unknown
  try {
    v = JSON.parse(data)
  } catch {
    return null
  }
  return isMsg(v) ? v : null
}

/** Narrows an unknown value to a plain object. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Narrows an unknown value to an Attachment. */
function isAttachment(v: unknown): v is Attachment {
  return (
    isRecord(v) &&
    typeof v.url === 'string' &&
    typeof v.name === 'string' &&
    (v.contentType === null || typeof v.contentType === 'string') &&
    typeof v.size === 'number' &&
    (v.width === null || typeof v.width === 'number') &&
    (v.height === null || typeof v.height === 'number')
  )
}

/** True for a string a Date can read. An invalid date would throw when formatted, during render. */
function isDate(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v))
}

/** Narrows an unknown value to a Msg. */
function isMsg(v: unknown): v is Msg {
  if (!isRecord(v) || !isRecord(v.author)) return false
  const a = v.author
  return (
    typeof v.id === 'string' &&
    typeof v.channelId === 'string' &&
    typeof v.content === 'string' &&
    isDate(v.createdAt) &&
    (v.editedAt === null || isDate(v.editedAt)) &&
    Array.isArray(v.attachments) &&
    v.attachments.every(isAttachment) &&
    typeof a.id === 'string' &&
    typeof a.name === 'string' &&
    typeof a.bot === 'boolean' &&
    (a.avatarUrl === null || typeof a.avatarUrl === 'string')
  )
}
