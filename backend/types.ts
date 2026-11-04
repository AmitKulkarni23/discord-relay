/** A file attached to a Discord message. */
export type Attachment = {
  /** Discord CDN URL. Signed, expires after about 24 hours. */
  url: string
  name: string
  contentType: string | null
  /** File size in bytes. */
  size: number
  /** Pixel size for images and videos; null for other files. */
  width: number | null
  height: number | null
}

/** A Discord message in the shape the hub, the server and the browser share. */
export type Msg = {
  /** Discord message ID (snowflake): unique and ordered by time. */
  id: string
  channelId: string
  author: { id: string; name: string; avatarUrl: string | null; bot: boolean }
  content: string
  /** Says what a message carries besides typed text ("Forwarded", "Sticker: name"), or null when nothing. */
  note: string | null
  /** ISO 8601 */
  createdAt: string
  /** ISO 8601, or null if never edited */
  editedAt: string | null
  attachments: Attachment[]
}

/** A relayed channel as GET /config reports it; `name` is null until the bot has loaded it. */
export type ChannelInfo = { id: string; name: string | null }

/** Orders two Discord snowflakes by time without converting them to numbers. */
export function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}
