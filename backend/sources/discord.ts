import { Client, Events, GatewayIntentBits } from 'discord.js'
import { log } from '../log.ts'
import type { ChannelInfo, Msg } from '../types.ts'

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

/** What `startDiscord` needs; passed in so the wiring stays in server.ts. */
export type DiscordDeps = {
  token: string
  /** Every channel to relay. */
  channelIds: string[]
  publish: (m: Msg) => void
  /** How many recent messages to load at startup; matches the hub's buffer size. */
  historyLimit?: number
  /** Called when the Gateway stays disconnected longer than `watchdogMs`. */
  onWatchdogExpired?: () => void
  watchdogMs?: number
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

/** Discord returns at most this many messages per history request. */
const PAGE_SIZE = 100

/**
 * Loads the newest `limit` messages, oldest first. `fetchPage(before, n)`
 * returns up to `n` messages older than `before` (all when undefined), newest
 * first, as Discord does; this walks back page by page until it has `limit`
 * or a page comes back short.
 */
export async function collectHistory<T extends { id: string }>(
  fetchPage: (before: string | undefined, limit: number) => Promise<T[]>,
  limit: number,
): Promise<T[]> {
  const out: T[] = []
  let before: string | undefined
  while (out.length < limit) {
    const n = Math.min(PAGE_SIZE, limit - out.length)
    const page = await fetchPage(before, n)
    out.push(...page)
    const oldest = page.at(-1)
    if (page.length < n || !oldest) break
    before = oldest.id
  }
  return out.reverse()
}

/**
 * Calls `onExpire` if `disconnected()` is not followed by `connected()` within
 * `limitMs`. Railway only healthchecks at deploy time, so this is how a stalled
 * Gateway connection gets the process restarted. Timers are injectable for tests.
 */
export function createWatchdog(opts: {
  limitMs: number
  onExpire: () => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}) {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((handle: unknown) => clearTimeout(handle as Timer))
  let pending: unknown

  return {
    /** Starts the countdown, unless one is already running. */
    disconnected(): void {
      if (pending !== undefined) return
      pending = setTimer(() => {
        pending = undefined
        opts.onExpire()
      }, opts.limitMs)
    },
    /** Cancels the countdown. */
    connected(): void {
      if (pending === undefined) return
      clearTimer(pending)
      pending = undefined
    },
  }
}

/**
 * Logs in to the Discord Gateway, publishes the latest `historyLimit` messages once ready and
 * again after any fresh session,
 * then publishes each new message from any of `channelIds`. Returns the login promise
 * (rejects on a bad token), the connection state for /health, the channel
 * names for /config, and `stop`.
 */
export function startDiscord(deps: DiscordDeps) {
  const { token, channelIds, publish, historyLimit = 100, onWatchdogExpired = () => {}, watchdogMs = 5 * 60_000 } = deps
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  })
  const watchdog = createWatchdog({ limitMs: watchdogMs, onExpire: onWatchdogExpired })
  let connected = false
  const wanted = new Set(channelIds)
  /** Channel names, filled in as each channel's history loads. */
  const names = new Map<string, string>()
  /** True once the first session is ready; each later ready event is a fresh session that may have missed messages. */
  let started = false
  let warnedMissingContent = false

  /** Records a Gateway state change for /health and the watchdog. */
  function setConnected(next: boolean, event: string): void {
    connected = next
    if (next) {
      watchdog.connected()
      log.info(event)
    } else {
      watchdog.disconnected()
      log.warn(event)
    }
  }

  /**
   * Converts and publishes one message, warning the first time one has no content. A message that
   * cannot be converted is logged and skipped, so it costs one message, not a restart (a throw on
   * the live path is uncaught) or the rest of the channel's history.
   */
  function handle(m: MessageLike): void {
    if (m.system) return
    try {
      const msg = toMsg(m)
      // Once per process: a history load alone can log BUFFER_SIZE of these in one burst, and one line says it all.
      if (!warnedMissingContent && isMissingContent(msg)) {
        warnedMissingContent = true
        log.warn('message_content_missing', {
          messageId: msg.id,
          hint: 'If the page shows many messages without text, check the MessageContent intent in the Discord developer portal',
        })
      }
      publish(msg)
    } catch (err) {
      log.error('message_skipped', { channelId: m.channelId, messageId: m.id, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Publishes one channel's latest `historyLimit` messages, oldest first. Logs and continues on failure. */
  async function publishHistory(channelId: string): Promise<void> {
    try {
      const channel = await client.channels.fetch(channelId)
      if (!channel?.isTextBased()) {
        log.error('history_failed', { channelId, reason: 'channel not found or not a text channel' })
        return
      }
      if ('name' in channel && typeof channel.name === 'string') names.set(channelId, channel.name)
      const messages = await collectHistory(async (before, limit) => [...(await channel.messages.fetch({ limit, before })).values()], historyLimit)
      for (const m of messages) handle(m)
      log.info('history_loaded', { channelId, count: messages.length })
    } catch (err) {
      log.error('history_failed', { channelId, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Publishes every channel's latest messages. Never rejects: publishHistory logs its own failures. */
  async function loadHistory(): Promise<void> {
    for (const id of channelIds) await publishHistory(id)
  }

  client.on(Events.ShardReady, () => {
    setConnected(true, 'gateway_connected')
    // A resume replays what was missed, but a fresh session does not. The hub drops what it already holds.
    if (started) void loadHistory()
  })
  client.on(Events.ShardResume, () => setConnected(true, 'gateway_resumed'))
  client.on(Events.ShardDisconnect, () => setConnected(false, 'gateway_disconnected'))
  client.on(Events.ShardReconnecting, () => setConnected(false, 'gateway_reconnecting'))
  // Without an 'error' listener, an emitted client error would throw and crash the process.
  client.on(Events.Error, err => log.error('discord_client_error', { error: err.message }))
  client.on(Events.Warn, info => log.warn('discord_client_warning', { info }))
  client.once(Events.ClientReady, () => {
    started = true
    void loadHistory()
  })
  client.on(Events.MessageCreate, m => {
    if (wanted.has(m.channelId)) handle(m)
  })

  // Start the countdown now so a login that never becomes ready also restarts the process.
  watchdog.disconnected()

  return {
    /** Resolves once logged in; rejects on an invalid token. */
    login: client.login(token),
    /** True while the Gateway connection is up. */
    isConnected: (): boolean => connected,
    /** Every relayed channel, with its name once its history has loaded. */
    channels: (): ChannelInfo[] => channelIds.map(id => ({ id, name: names.get(id) ?? null })),
    /** Cancels the watchdog and closes the Gateway connection. */
    async stop(): Promise<void> {
      watchdog.connected()
      await client.destroy()
    },
  }
}
