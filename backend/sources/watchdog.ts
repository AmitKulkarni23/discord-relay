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
