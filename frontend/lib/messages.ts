/**
 * Pure logic for the held messages: add, remove and sort them, group them into feed rows,
 * and check that what arrives over SSE really is a Msg.
 */
import { compareIds, type Attachment, type Msg } from '../../backend/core/types.ts'

/** The most messages the browser holds; the oldest are dropped past this. */
export const MAX_MSGS = 500

/** Messages from one author closer together than this share a group header. */
const GROUP_GAP_MS = 5 * 60_000

/**
 * Stores `m` keyed by ID and returns a new Map, because React only re-renders when state is a new object.
 * A resend with the same edit time returns `prev` unchanged, so a reconnect replay causes no re-render.
 * Drops the oldest message once more than MAX_MSGS are held.
 *
 * Example, with MAX_MSGS = 3 for brevity:
 *   prev = { 101 → "hi", 102 → "yo", 103 → "ok" }
 *   addMsg(prev, 104 → "new")          → { 102, 103, 104 }   (101, the oldest, dropped)
 *   addMsg(prev, 102 → "yo", same edit) → prev itself         (replay: nothing changes)
 *   addMsg(prev, 102 → "yo!", edited)   → { 101, 102 → "yo!", 103 }
 */
export function addMsg(prev: Map<string, Msg>, m: Msg): Map<string, Msg> {
  const held = prev.get(m.id)
  if (held && held.editedAt === m.editedAt) return prev
  // new Map(prev) is a shallow copy: it copies up to 500 references to the existing Msg objects. Message text,
  // authors and attachments stay where they are and are shared by the old and new maps.
  const updated = new Map(prev).set(m.id, m)
  if (updated.size > MAX_MSGS) {
    let oldest = m.id
    for (const id of updated.keys()) if (compareIds(id, oldest) < 0) oldest = id
    updated.delete(oldest)
  }
  return updated
}

/** Removes a deleted message. Returns `prev` unchanged when it is not held, so nothing re-renders. */
export function removeMsg(prev: Map<string, Msg>, id: string): Map<string, Msg> {
  if (!prev.has(id)) return prev
  const updated = new Map(prev)
  updated.delete(id)
  return updated
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
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    return null
  }
  return isMsg(value) ? value : null
}

/** Parses one `delete` event's data into the deleted message's ID, or null when it does not match. */
export function parseDeletedId(data: string): string | null {
  try {
    const value: unknown = JSON.parse(data)
    return isRecord(value) && typeof value.id === 'string' ? value.id : null
  } catch {
    return null
  }
}

/** Narrows an unknown value to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Narrows an unknown value to an Attachment. */
function isAttachment(value: unknown): value is Attachment {
  return (
    isRecord(value) &&
    typeof value.url === 'string' &&
    typeof value.name === 'string' &&
    (value.contentType === null || typeof value.contentType === 'string') &&
    typeof value.size === 'number' &&
    (value.width === null || typeof value.width === 'number') &&
    (value.height === null || typeof value.height === 'number')
  )
}

/** True for a string a Date can read. An invalid date would throw when formatted, during render. */
function isDate(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

/** Narrows an unknown value to a Msg. */
function isMsg(value: unknown): value is Msg {
  if (!isRecord(value) || !isRecord(value.author)) return false
  const author = value.author
  return (
    typeof value.id === 'string' &&
    typeof value.channelId === 'string' &&
    typeof value.content === 'string' &&
    (value.note === null || typeof value.note === 'string') &&
    isDate(value.createdAt) &&
    (value.editedAt === null || isDate(value.editedAt)) &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isAttachment) &&
    typeof author.id === 'string' &&
    typeof author.name === 'string' &&
    typeof author.bot === 'boolean' &&
    (author.avatarUrl === null || typeof author.avatarUrl === 'string')
  )
}
