import type { Msg } from '../types.ts'

type AttachmentsLike = {
  values(): Iterable<{ url: string; name: string; contentType: string | null; size: number; width: number | null; height: number | null }>
}

/**
 * The fields of a discord.js `Message` that `toMsg` reads. A real `Message`
 * fits this type, and tests can pass plain objects.
 */
export type MessageLike = {
  id: string
  channelId: string
  content: string | null
  /** Null when the channel is not cached, which would otherwise lose the message: the browser rejects null text. */
  cleanContent: string | null
  createdAt: Date
  editedAt: Date | null
  author: {
    id: string
    username: string
    globalName: string | null
    bot: boolean
    displayAvatarURL: () => string
  }
  attachments: AttachmentsLike
  /** Joins, pins, boosts and the like, which nobody typed. */
  system: boolean
  stickers: { values(): Iterable<{ name: string }> }
  embeds: Array<{ title: string | null; description: string | null }>
  poll: { question: { text: string | null } } | null
  /** A forward's original message; the forward itself has no content of its own. */
  messageSnapshots: { first(): { content: string | null; attachments: AttachmentsLike } | undefined }
}

/** The title and description of a message's first embed that has either, as text. */
function embedText(m: MessageLike): string {
  const embed = m.embeds.find(e => e.title || e.description)
  return embed ? [embed.title, embed.description].filter(Boolean).join('\n') : ''
}

/** Says what a message carries besides typed text, or null when nothing. A link preview on typed text does not count. */
function describeExtras(m: MessageLike, forwarded: boolean, typed: boolean): string | null {
  const parts: string[] = []
  if (forwarded) parts.push('Forwarded')
  for (const sticker of m.stickers.values()) parts.push(`Sticker: ${sticker.name}`)
  if (m.poll?.question.text) parts.push(`Poll: ${m.poll.question.text}`)
  if (!typed && !forwarded && m.embeds.length > 0) parts.push('Embed')
  return parts.length > 0 ? parts.join(' · ') : null
}

/** Converts a discord.js message to the `Msg` shape the hub and browser use. */
export function toMsg(m: MessageLike): Msg {
  const forward = m.messageSnapshots.first()
  const typed = m.cleanContent ?? m.content ?? ''
  return {
    id: m.id,
    channelId: m.channelId,
    author: {
      id: m.author.id,
      name: m.author.globalName ?? m.author.username,
      avatarUrl: m.author.displayAvatarURL(),
      bot: m.author.bot,
    },
    // Mentions and custom emoji become @name, #name and :name:. An uncached mention stays raw.
    // ponytail: a forward's text stays raw, because cleanContent can throw on a channel the bot has not cached.
    content: forward ? (forward.content ?? '') : typed || embedText(m),
    note: describeExtras(m, forward !== undefined, typed !== ''),
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    attachments: [...(forward ?? m).attachments.values()].map(a => ({
      url: a.url,
      name: a.name,
      contentType: a.contentType,
      size: a.size,
      width: a.width,
      height: a.height,
    })),
  }
}

/**
 * True when a message has nothing to show at all. Discord sends messages like this
 * without the MessageContent intent.
 */
export function isMissingContent(msg: Msg): boolean {
  return msg.content === '' && msg.attachments.length === 0 && msg.note === null
}
