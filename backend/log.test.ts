import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { log } from './log.ts'

const out = spyOn(console, 'log').mockImplementation(() => {})
afterEach(() => out.mockClear())

/** Parses the single JSON line the logger just wrote. */
function lastLine(): Record<string, unknown> {
  const arg: unknown = out.mock.calls.at(-1)?.[0]
  if (typeof arg !== 'string') throw new Error('expected one string log line')
  return JSON.parse(arg)
}

describe('log', () => {
  describe('when an event is logged at a level', () => {
    it('should write one JSON line with level, event, time and fields when warn is called', () => {
      log.warn('gateway_disconnected', { channelId: '1566584977829900002' })

      expect(out).toHaveBeenCalledTimes(1)
      expect(lastLine()).toMatchObject({ level: 'warn', event: 'gateway_disconnected', channelId: '1566584977829900002' })
      expect(Date.parse(String(lastLine().time))).not.toBeNaN()
    })

    it('should set the matching level when debug, info or error is called', () => {
      log.debug('client_connected', { clients: 3 })
      expect(lastLine().level).toBe('debug')
      log.info('server_started')
      expect(lastLine().level).toBe('info')
      log.error('discord_login_failed', { error: 'An invalid token was provided.' })
      expect(lastLine().level).toBe('error')
    })
  })

  describe('when fields try to override the core keys', () => {
    it('should keep the real level and event when fields contain the same names', () => {
      log.info('history_loaded', { level: 'error', event: 'spoofed', count: 100 })

      expect(lastLine()).toMatchObject({ level: 'info', event: 'history_loaded', count: 100 })
    })
  })
})
