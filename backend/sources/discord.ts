import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'
import { errorMessage, log } from '../log.ts'
import { compareIds, type ChannelInfo, type Msg } from '../types.ts'

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
  /** Removes a message deleted in Discord. */
  remove: (channelId: string, id: string) => void
  /** The IDs of a channel's buffered messages. */
  buffered: (channelId: string) => string[]
  /** The `edits-deletes` flag: whether deletions in Discord reach the page. Read each time, so a change applies at once. */
  deletesEnabled: () => boolean
  /** How many recent messages to load at startup; matches the hub's buffer size. */
  historyLimit?: number
  /** Called when logging in cannot work however often it is retried: a bad token or a disallowed intent. */
  onFatal: (err: unknown) => void
  /** How long the Gateway may stay disconnected before reconnecting with a fresh client. */
  watchdogMs?: number
  /** First wait before retrying a channel whose history failed to load; doubles per attempt up to 5 minutes. */
  historyRetryMs?: number
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

/** The longest wait between attempts to load a channel's history. */
const MAX_HISTORY_RETRY_MS = 5 * 60_000

/** True when a login failure needs a person, so retrying is pointless. */
function isFatalLogin(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const code = 'code' in err ? err.code : undefined
  return code === 'TokenInvalid' || code === 'DisallowedIntents' || /disallowed intents/i.test(err.message)
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

/** Counts down while the Gateway is disconnected. */
export type Watchdog = {
  /** Starts the countdown, unless one is already running. */
  disconnected(): void
  /** Cancels the countdown. */
  connected(): void
}

/**
 * Calls `onExpire` if `disconnected()` is not followed by `connected()` within
 * `limitMs`. Railway only healthchecks at deploy time, so this is how a stalled
 * Gateway connection gets noticed. Timers are injectable for tests.
 */
export function createWatchdog(opts: {
  limitMs: number
  onExpire: () => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}): Watchdog {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((handle: unknown) => clearTimeout(handle as Timer))
  let pending: unknown

  return {
    disconnected(): void {
      if (pending !== undefined) return
      pending = setTimer(() => {
        pending = undefined
        opts.onExpire()
      }, opts.limitMs)
    },
    connected(): void {
      if (pending === undefined) return
      clearTimer(pending)
      pending = undefined
    },
  }
}

/** The running bot, as `startDiscord` returns it. */
export type DiscordSource = {
  /** Settles once the first login attempt has finished; a failure goes to `onFatal` or the log, never here. */
  login: Promise<void>
  /** True while the Gateway connection is up. */
  isConnected(): boolean
  /** False while a channel's history cannot be loaded, usually because the bot cannot read it. */
  isChannelAvailable(channelId: string): boolean
  /** Every relayed channel, with its name once its history has loaded. */
  channels(): ChannelInfo[]
  /** Cancels the watchdog and any retries, and closes the Gateway connection. */
  stop(): Promise<void>
}

/**
 * Logs in to the Discord Gateway, publishes the latest `historyLimit` messages once ready and
 * again after any fresh session, then publishes each new message from any of `channelIds`.
 * Returns the login promise, the connection and channel state for /health, the channel names
 * for /config, and `stop`.
 */
export function startDiscord(deps: DiscordDeps): DiscordSource {
  const { token, channelIds, publish, remove, buffered, deletesEnabled, historyLimit = 100, onFatal, watchdogMs = 5 * 60_000, historyRetryMs = 5_000 } = deps
  const watchdog = createWatchdog({ limitMs: watchdogMs, onExpire: () => void reconnect() })
  let connected = false
  const wanted = new Set(channelIds)
  /** Channel names, filled in as each channel's history loads. */
  const names = new Map<string, string>()
  /** True once the first session is ready; each later ready event is a fresh session that may have missed messages. */
  let started = false
  let warnedMissingContent = false
  let stopped = false
  /** Channels whose latest history load failed. */
  const unavailable = new Set<string>()
  /** Failed loads in a row and the pending retry, per channel. */
  const retries = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>()

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
      log.error('message_skipped', { channelId: m.channelId, messageId: m.id, error: errorMessage(err) })
    }
  }

  /**
   * Removes messages deleted while the Gateway was down, which fire no event: anything held that Discord
   * no longer returns. `fetched` is oldest first. A full page says nothing about messages older than it.
   */
  function removeMissing(channelId: string, held: string[], fetched: Array<{ id: string }>): void {
    if (!deletesEnabled()) return
    const kept = new Set(fetched.map(m => m.id))
    const oldest = fetched.length < historyLimit ? undefined : fetched[0]?.id
    for (const id of held) {
      if (!kept.has(id) && (oldest === undefined || compareIds(id, oldest) > 0)) remove(channelId, id)
    }
  }

  /** Marks a channel unavailable and tries again later: access may be granted, or an outage may end. */
  function retryHistory(channelId: string): void {
    unavailable.add(channelId)
    if (stopped) return
    const retry = retries.get(channelId) ?? { attempts: 0 }
    clearTimeout(retry.timer)
    retry.timer = setTimeout(() => void publishHistory(channelId), Math.min(historyRetryMs * 2 ** retry.attempts, MAX_HISTORY_RETRY_MS))
    retry.attempts++
    retries.set(channelId, retry)
  }

  /** Publishes one channel's latest `historyLimit` messages, oldest first. Logs and retries on failure. */
  async function publishHistory(channelId: string): Promise<void> {
    clearTimeout(retries.get(channelId)?.timer)
    try {
      const channel = await client.channels.fetch(channelId)
      if (!channel?.isTextBased()) {
        log.error('history_failed', { channelId, reason: 'channel not found or not a text channel' })
        retryHistory(channelId)
        return
      }
      if ('name' in channel && typeof channel.name === 'string') names.set(channelId, channel.name)
      // Taken before the fetch, so a message posted while it runs is never mistaken for a deleted one.
      const held = buffered(channelId)
      const messages = await collectHistory(async (before, limit) => [...(await channel.messages.fetch({ limit, before })).values()], historyLimit)
      removeMissing(channelId, held, messages)
      for (const m of messages) handle(m)
      unavailable.delete(channelId)
      retries.delete(channelId)
      log.info('history_loaded', { channelId, count: messages.length })
    } catch (err) {
      log.error('history_failed', { channelId, error: errorMessage(err) })
      retryHistory(channelId)
    }
  }

  /** Publishes every channel's latest messages. Never rejects: publishHistory logs its own failures. */
  async function loadHistory(): Promise<void> {
    for (const id of channelIds) await publishHistory(id)
  }

  /** Builds a client with every listener attached. */
  function createClient(): Client {
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
      // Without this, deleting a message outside discord.js's cache fires no event, and it would stay on the page.
      partials: [Partials.Message],
    })
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
      if (started) return
      started = true
      void loadHistory()
    })
    client.on(Events.MessageCreate, m => {
      if (wanted.has(m.channelId)) handle(m)
    })
    client.on(Events.MessageDelete, m => {
      if (deletesEnabled() && wanted.has(m.channelId)) remove(m.channelId, m.id)
    })
    client.on(Events.ChannelUpdate, (_, channel) => {
      if (wanted.has(channel.id) && 'name' in channel && typeof channel.name === 'string') names.set(channel.id, channel.name)
    })
    client.on(Events.MessageBulkDelete, (messages, channel) => {
      if (deletesEnabled() && wanted.has(channel.id)) for (const id of messages.keys()) remove(channel.id, id)
    })
    return client
  }

  /** Logs in. A failure a retry could fix is only logged, and the watchdog tries again. */
  async function login(next: Client): Promise<void> {
    try {
      await next.login(token)
    } catch (err) {
      if (isFatalLogin(err)) onFatal(err)
      else log.error('discord_login_failed', { error: errorMessage(err) })
    }
  }

  /**
   * Replaces a Gateway connection that has stayed down, inside the process. Exiting would lose the
   * buffer, which can't be reloaded while Discord is down, and use up Railway's limited restarts.
   */
  async function reconnect(): Promise<void> {
    if (stopped) return
    log.error('watchdog_expired', { reason: 'Gateway disconnected past the watchdog limit; reconnecting with a fresh client' })
    const old = client
    const next = createClient()
    client = next
    // Nothing from the old connection may count from here on. Without an 'error' listener, an emitted error would crash.
    old.removeAllListeners()
    old.on(Events.Error, () => {})
    setConnected(false, 'gateway_reconnecting')
    try {
      await old.destroy()
    } catch (err) {
      log.warn('discord_client_destroy_failed', { error: errorMessage(err) })
    }
    // Closing can outlast the next attempt, which replaces `next`, or a stop.
    if (!stopped && client === next) await login(next)
  }

  let client = createClient()

  // Start the countdown now so a login that never becomes ready is retried too.
  watchdog.disconnected()

  return {
    login: login(client),
    isConnected: () => connected,
    isChannelAvailable: channelId => !unavailable.has(channelId),
    channels: () => channelIds.map(id => ({ id, name: names.get(id) ?? null })),
    async stop() {
      stopped = true
      watchdog.connected()
      for (const retry of retries.values()) clearTimeout(retry.timer)
      await client.destroy()
    },
  }
}
