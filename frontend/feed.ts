import { compareIds, type Attachment, type ChannelInfo, type Msg } from '../backend/types.ts'

export { compareIds }

/** The most messages the browser holds; the oldest are dropped past this. */
export const MAX_MSGS = 500

/** Longest wait between reconnects. */
export const MAX_RETRY_MS = 30_000

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

/**
 * Returns how long to wait before a reconnect: a random point in a window that
 * doubles per attempt, so browsers dropped together do not come back together.
 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  return random() * Math.min(1000 * 2 ** attempt, MAX_RETRY_MS)
}

/** One piece of a message's text. Only http and https ever become links. */
export type Part =
  | { kind: 'text' | 'code' | 'block'; text: string }
  | { kind: 'link'; href: string }
  | { kind: 'time'; iso: string }
  | { kind: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; parts: Part[] }

/**
 * Discord's inline syntax, leftmost match first. Headings, quotes, lists and masked links stay as typed.
 * Timestamps stop at 11 digits, because anything longer can be out of range for a Date.
 */
const TOKEN = new RegExp(
  [
    '\\\\(?<escaped>[*_~`|\\\\])',
    '```(?:[a-z0-9+-]*\\n)?(?<block>[\\s\\S]+?)\\n?```',
    '`(?<code>[^`\\n]+)`',
    '<(?<wrapped>https?://[^\\s>]+)>',
    '(?<url>https?://[^\\s<]+)',
    '<t:(?<time>\\d{1,11})(?::[tTdDfFR])?>',
    '\\*\\*(?<bold>[\\s\\S]+?)\\*\\*(?!\\*)',
    '__(?<underline>[\\s\\S]+?)__(?!_)',
    '~~(?<strike>[\\s\\S]+?)~~',
    '\\|\\|(?<spoiler>[\\s\\S]+?)\\|\\|',
    '\\*(?<star>[^*\\s](?:[^*\\n]*[^*\\s])?)\\*',
    '(?<!\\w)_(?<under>[^_\\s](?:[^_\\n]*[^_\\s])?)_(?!\\w)',
  ].join('|'),
  'gi',
)

/** Length of `url` without trailing punctuation, keeping a closing bracket opened inside the URL. */
function linkLength(url: string): number {
  let end = url.length
  while (end > 0) {
    const last = url.charAt(end - 1)
    const closes = last === ')' && url.slice(0, end).split('(').length < url.slice(0, end).split(')').length
    if (!closes && !'.,;:!?\'"]'.includes(last)) break
    end--
  }
  return end
}

/** Splits a message's text into parts for React to render; nothing here ever becomes HTML. */
export function parseMarkup(text: string): Part[] {
  const parts: Part[] = []
  let at = 0
  const addText = (t: string): void => {
    const last = parts.at(-1)
    if (last?.kind === 'text') last.text += t
    else if (t) parts.push({ kind: 'text', text: t })
  }
  for (const match of text.matchAll(TOKEN)) {
    const g = match.groups ?? {}
    const before = text.slice(at, match.index)
    addText(g.block !== undefined ? before.replace(/\n$/, '') : before)
    at = match.index + match[0].length
    if (g.block !== undefined && text[at] === '\n') at++
    if (g.escaped !== undefined) addText(g.escaped)
    else if (g.block !== undefined) parts.push({ kind: 'block', text: g.block })
    else if (g.code !== undefined) parts.push({ kind: 'code', text: g.code })
    else if (g.wrapped !== undefined) parts.push({ kind: 'link', href: g.wrapped })
    else if (g.url !== undefined) {
      at = match.index + linkLength(g.url)
      parts.push({ kind: 'link', href: text.slice(match.index, at) })
    } else if (g.time !== undefined) parts.push({ kind: 'time', iso: new Date(Number(g.time) * 1000).toISOString() })
    else if (g.bold !== undefined) parts.push({ kind: 'bold', parts: parseMarkup(g.bold) })
    else if (g.underline !== undefined) parts.push({ kind: 'underline', parts: parseMarkup(g.underline) })
    else if (g.strike !== undefined) parts.push({ kind: 'strike', parts: parseMarkup(g.strike) })
    else if (g.spoiler !== undefined) parts.push({ kind: 'spoiler', parts: parseMarkup(g.spoiler) })
    else parts.push({ kind: 'italic', parts: parseMarkup(g.star ?? g.under ?? '') })
  }
  addText(text.slice(at))
  return parts
}

/** What the status chip says just after a reconnect: that the stream is back, and what `?since=` recovered. */
export function recoveredLabel(caughtUp: number): string {
  return caughtUp === 0 ? 'Back live' : `Back · ${caughtUp} caught up`
}

/** Builds the /events URL. `since` is the newest ID held, so a reconnect gets only newer messages. */
export function eventsUrl(channel: string | null, since: string | null): string {
  const params = new URLSearchParams()
  if (channel) params.set('channel', channel)
  if (since) params.set('since', since)
  const query = params.toString()
  return query ? `/events?${query}` : '/events'
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

/** What the page needs from GET /config. */
export type PageConfig = { attachments: boolean; channels: ChannelInfo[] }

/**
 * Narrows the untrusted GET /config body. Anything unexpected falls back to
 * attachments off and no channels, and malformed channel entries are dropped.
 */
export function parseConfig(v: unknown): PageConfig {
  if (!isRecord(v)) return { attachments: false, channels: [] }
  const channels = Array.isArray(v.channels)
    ? v.channels.filter((c): c is ChannelInfo => isRecord(c) && typeof c.id === 'string' && (c.name === null || typeof c.name === 'string'))
    : []
  return { attachments: v.attachments === true, channels: channels.map(c => ({ id: c.id, name: c.name })) }
}

/**
 * Reads GET /config, retrying with the stream's backoff until it answers: a 502 mid-deploy must not
 * leave the page without tabs, or stuck retrying a `?channel=` the server would answer 404 to.
 * Returns null once `signal` aborts.
 */
export async function fetchConfig(
  signal: AbortSignal,
  get: (url: string, init: RequestInit) => Promise<Response> = fetch,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<PageConfig | null> {
  for (let attempt = 0; !signal.aborted; attempt++) {
    try {
      const res = await get('/config', { signal })
      if (res.ok) return parseConfig(await res.json())
    } catch {
      // A network failure or a body that is not JSON: retry like any other failure.
    }
    await wait(retryDelay(attempt))
  }
  return null
}

/** Narrows an unknown value to a plain object. */
function isRecord(v: unknown): v is Record<string, unknown> {
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

/** Narrows an unknown value to a Msg. */
function isMsg(v: unknown): v is Msg {
  if (!isRecord(v) || !isRecord(v.author)) return false
  const a = v.author
  return (
    typeof v.id === 'string' &&
    typeof v.channelId === 'string' &&
    typeof v.content === 'string' &&
    typeof v.createdAt === 'string' &&
    (v.editedAt === null || typeof v.editedAt === 'string') &&
    Array.isArray(v.attachments) &&
    v.attachments.every(isAttachment) &&
    typeof a.id === 'string' &&
    typeof a.name === 'string' &&
    typeof a.bot === 'boolean' &&
    (a.avatarUrl === null || typeof a.avatarUrl === 'string')
  )
}
