import { Client, Events, GatewayIntentBits, Partials } from 'discord.js'
import { errorMessage, log } from '../platform/log.ts'
import { compareIds, type ChannelInfo, type Msg } from '../core/types.ts'
import { isMissingContent, toMsg, type MessageLike } from './discord-message.ts'
import { createWatchdog } from './watchdog.ts'

/** What `startDiscord` needs; passed in so the wiring stays in server.ts. */
export type DiscordDeps = {
  token: string
  /** Every channel to relay. */
  channelIds: string[]
  publish: (msg: Msg) => void
  /** Removes a message deleted in Discord. */
  remove: (channelId: string, id: string) => void
  /** The IDs of a channel's buffered messages. */
  bufferedIds: (channelId: string) => string[]
  /** The `edits-deletes` flag: whether deletions in Discord reach the page. Read each time, so a change applies at once. */
  deletesEnabled: () => boolean
  /** How many recent messages to load at startup; matches the hub's buffer size. */
  historyLimit?: number
  /** Called when logging in needs a person to fix it: a bad token or a disallowed intent. The watchdog still retries every 5 minutes. */
  onFatal: (err: unknown) => void
  /** How long the Gateway may stay disconnected before reconnecting with a fresh client. */
  watchdogMs?: number
  /** First wait before retrying a channel whose history failed to load; doubles per attempt up to 5 minutes. */
  historyRetryMs?: number
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
 * Loads the newest `limit` messages, oldest first. `fetchPage(before, pageSize)`
 * returns up to `pageSize` messages older than `before` (all when undefined), newest
 * first, as Discord does; this walks back page by page until it has `limit`
 * or a page comes back short.
 */
export async function collectHistory<T extends { id: string }>(
  fetchPage: (before: string | undefined, pageSize: number) => Promise<T[]>,
  limit: number,
): Promise<T[]> {
  const messages: T[] = []
  let before: string | undefined
  while (messages.length < limit) {
    const pageSize = Math.min(PAGE_SIZE, limit - messages.length)
    const page = await fetchPage(before, pageSize)
    messages.push(...page)
    const oldest = page.at(-1)
    // A short page means the channel has nothing older.
    if (page.length < pageSize || !oldest) break
    before = oldest.id
  }
  // Pages arrive newest first; the hub wants oldest first.
  return messages.reverse()
}

/** The running bot, as `startDiscord` returns it. */
export type DiscordSource = {
  /** Settles once the first login attempt has finished; a failure goes to `onFatal` or the log, never here. */
  login: Promise<void>
  /** True while the Gateway connection is up. */
  isConnected(): boolean
  /** True after a login that needs a person to fix it, until a later login succeeds. */
  loginFailed(): boolean
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
  const { token, channelIds, publish, remove, bufferedIds, deletesEnabled, historyLimit = 100, onFatal, watchdogMs = 5 * 60_000, historyRetryMs = 5_000 } = deps
  const watchdog = createWatchdog({ limitMs: watchdogMs, onExpire: () => void reconnect() })
  let connected = false
  let loginFailed = false
  const wanted = new Set(channelIds)
  /** Channel names, filled in as each channel's history loads. */
  const channelNames = new Map<string, string>()
  /** True once the first session is ready; each later ready event is a fresh session that may have missed messages. */
  let started = false
  let warnedMissingContent = false
  let stopped = false
  /** Channels whose latest history load failed. */
  const unavailable = new Set<string>()
  /** Failed loads in a row and the pending retry, per channel. */
  const retries = new Map<string, { attempts: number; timer?: ReturnType<typeof setTimeout> }>()

  /** Records a Gateway state change for /health and the watchdog. */
  function setConnected(isUp: boolean, event: string): void {
    connected = isUp
    if (isUp) {
      loginFailed = false
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
  function handle(message: MessageLike): void {
    if (message.system) return
    try {
      const msg = toMsg(message)
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
      log.error('message_skipped', { channelId: message.channelId, messageId: message.id, error: errorMessage(err) })
    }
  }

  /**
   * Removes messages deleted while the Gateway was down, which fire no event: anything held that Discord
   * no longer returns. `fetched` is oldest first. A full page says nothing about messages older than it.
   */
  function removeMissing(channelId: string, held: string[], fetched: Array<{ id: string }>): void {
    if (!deletesEnabled()) return
    const kept = new Set(fetched.map(msg => msg.id))
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
      if ('name' in channel && typeof channel.name === 'string') channelNames.set(channelId, channel.name)
      // Taken before the fetch, so a message posted while it runs is never mistaken for a deleted one.
      const held = bufferedIds(channelId)
      const messages = await collectHistory(async (before, pageSize) => [...(await channel.messages.fetch({ limit: pageSize, before })).values()], historyLimit)
      removeMissing(channelId, held, messages)
      for (const message of messages) handle(message)
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
    client.on(Events.MessageCreate, message => {
      if (wanted.has(message.channelId)) handle(message)
    })
    client.on(Events.MessageDelete, message => {
      if (deletesEnabled() && wanted.has(message.channelId)) remove(message.channelId, message.id)
    })
    client.on(Events.ChannelUpdate, (_, channel) => {
      if (wanted.has(channel.id) && 'name' in channel && typeof channel.name === 'string') channelNames.set(channel.id, channel.name)
    })
    client.on(Events.MessageBulkDelete, (messages, channel) => {
      if (deletesEnabled() && wanted.has(channel.id)) for (const id of messages.keys()) remove(channel.id, id)
    })
    return client
  }

  /** Logs in. A failure a retry could fix is only logged, and the watchdog tries again. */
  async function login(target: Client): Promise<void> {
    try {
      await target.login(token)
    } catch (err) {
      if (isFatalLogin(err)) {
        loginFailed = true
        onFatal(err)
      } else log.error('discord_login_failed', { error: errorMessage(err) })
    }
  }

  /**
   * Replaces a Gateway connection that has stayed down, inside the process. Exiting would lose the
   * buffer, which can't be reloaded while Discord is down, and use up Railway's limited restarts.
   */
  async function reconnect(): Promise<void> {
    if (stopped) return
    log.error('watchdog_expired', { reason: 'Gateway disconnected past the watchdog limit; reconnecting with a fresh client' })
    const oldClient = client
    const freshClient = createClient()
    client = freshClient
    // Nothing from the old connection may count from here on. Without an 'error' listener, an emitted error would crash.
    oldClient.removeAllListeners()
    oldClient.on(Events.Error, () => {})
    setConnected(false, 'gateway_reconnecting')
    try {
      await oldClient.destroy()
    } catch (err) {
      log.warn('discord_client_destroy_failed', { error: errorMessage(err) })
    }
    // Closing can outlast the next attempt, which replaces `freshClient`, or a stop.
    if (!stopped && client === freshClient) await login(freshClient)
  }

  let client = createClient()

  // Start the countdown now so a login that never becomes ready is retried too.
  watchdog.disconnected()

  return {
    login: login(client),
    isConnected: () => connected,
    loginFailed: () => loginFailed,
    isChannelAvailable: channelId => !unavailable.has(channelId),
    channels: () => channelIds.map(id => ({ id, name: channelNames.get(id) ?? null })),
    async stop() {
      stopped = true
      watchdog.connected()
      for (const retry of retries.values()) clearTimeout(retry.timer)
      await client.destroy()
    },
  }
}
