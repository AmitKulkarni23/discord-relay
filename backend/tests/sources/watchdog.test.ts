import { describe, expect, it, mock } from 'bun:test'
import { createWatchdog } from '../../sources/watchdog.ts'

/** A fake timer: records the scheduled callback so a test can fire it. */
function fakeTimers() {
  const pending = new Map<number, () => void>()
  let next = 0
  return {
    pending,
    setTimer: mock((fn: () => void) => {
      next += 1
      pending.set(next, fn)
      return next
    }),
    clearTimer: mock((handle: unknown) => {
      pending.delete(handle as number)
    }),
    /** Runs every pending callback, as if the time limit passed. */
    elapse() {
      for (const [handle, fn] of [...pending]) {
        pending.delete(handle)
        fn()
      }
    },
  }
}

describe('createWatchdog', () => {
  describe('when disconnected longer than the limit', () => {
    it('should call onExpire once when the limit passes without reconnecting', () => {
      const timers = fakeTimers()
      const onExpire = mock()
      const watchdog = createWatchdog({ limitMs: 300_000, onExpire, ...timers })

      watchdog.disconnected()
      timers.elapse()

      expect(onExpire).toHaveBeenCalledTimes(1)
      expect(timers.setTimer).toHaveBeenCalledWith(expect.any(Function), 300_000)
    })
  })

  describe('when reconnected before the limit', () => {
    it('should not call onExpire when connected is reported in time', () => {
      const timers = fakeTimers()
      const onExpire = mock()
      const watchdog = createWatchdog({ limitMs: 300_000, onExpire, ...timers })

      watchdog.disconnected()
      watchdog.connected()
      timers.elapse()

      expect(onExpire).not.toHaveBeenCalled()
    })
  })

  describe('when disconnect is reported twice', () => {
    it('should keep the first deadline when already counting down', () => {
      const timers = fakeTimers()
      const watchdog = createWatchdog({ limitMs: 300_000, onExpire: mock(), ...timers })

      watchdog.disconnected()
      watchdog.disconnected()

      expect(timers.setTimer).toHaveBeenCalledTimes(1)
    })
  })
})
