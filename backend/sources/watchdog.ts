/**
 * A timer that notices a Gateway connection that stays down. discord.js normally reconnects by itself;
 * if it has not after 5 minutes, the watchdog fires and discord.ts replaces the client with a fresh one.
 */
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
 * Gateway connection gets noticed.
 *
 * Example with a 5-minute limit: the Gateway drops at 12:00 and `disconnected()` starts
 * the countdown. A second `disconnected()` at 12:01 (discord.js reports a disconnect, then
 * a reconnect attempt) does not restart it. If `connected()` comes at 12:02 the countdown
 * is cancelled; if nothing comes by 12:05, `onExpire` runs and the bot reconnects with a fresh client.
 *
 * `setTimer(callback, ms)` and `clearTimer(handle)` default to setTimeout and clearTimeout;
 * tests pass fake ones to move time forward without waiting.
 */
export function createWatchdog(opts: {
  limitMs: number
  onExpire: () => void
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}): Watchdog {
  const setTimer = opts.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms))
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
