/** A file attached to a Discord message. */
export type Attachment = {
  /** Discord CDN URL. Signed, expires after about 24 hours. */
  url: string
  name: string
  contentType: string | null
}

/** A Discord message in the shape the hub, the server and the browser share. */
export type Msg = {
  /** Discord message ID (snowflake): unique and ordered by time. */
  id: string
  channelId: string
  author: { id: string; name: string; avatarUrl: string | null; bot: boolean }
  content: string
  /** ISO 8601 */
  createdAt: string
  /** ISO 8601, or null if never edited */
  editedAt: string | null
  attachments: Attachment[]
}

/** A relayed channel as GET /config reports it; `name` is null until the bot has loaded it. */
export type ChannelInfo = { id: string; name: string | null }
