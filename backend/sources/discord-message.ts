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
function embedText(message: MessageLike): string {
  const embed = message.embeds.find(item => item.title || item.description)
  return embed ? [embed.title, embed.description].filter(Boolean).join('\n') : ''
}

/** Says what a message carries besides typed text, or null when nothing. A link preview on typed text does not count. */
function describeExtras(message: MessageLike, forwarded: boolean, typed: boolean): string | null {
  const parts: string[] = []
  if (forwarded) parts.push('Forwarded')
  for (const sticker of message.stickers.values()) parts.push(`Sticker: ${sticker.name}`)
  if (message.poll?.question.text) parts.push(`Poll: ${message.poll.question.text}`)
  if (!typed && !forwarded && message.embeds.length > 0) parts.push('Embed')
  return parts.length > 0 ? parts.join(' · ') : null
}

/** Converts a discord.js message to the `Msg` shape the hub and browser use. */
export function toMsg(message: MessageLike): Msg {
  const forward = message.messageSnapshots.first()
  const typed = message.cleanContent ?? message.content ?? ''
  return {
    id: message.id,
    channelId: message.channelId,
    author: {
      id: message.author.id,
      name: message.author.globalName ?? message.author.username,
      avatarUrl: message.author.displayAvatarURL(),
      bot: message.author.bot,
    },
    // Mentions and custom emoji become @name, #name and :name:. An uncached mention stays raw.
    // ponytail: a forward's text stays raw, because cleanContent can throw on a channel the bot has not cached.
    content: forward ? (forward.content ?? '') : typed || embedText(message),
    note: describeExtras(message, forward !== undefined, typed !== ''),
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt ? message.editedAt.toISOString() : null,
    attachments: [...(forward ?? message).attachments.values()].map(attachment => ({
      url: attachment.url,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      width: attachment.width,
      height: attachment.height,
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
