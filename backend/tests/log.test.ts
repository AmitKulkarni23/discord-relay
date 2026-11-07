import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { errorMessage, log } from '../log.ts'

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

  describe('when running in production', () => {
    const before = { NODE_ENV: process.env.NODE_ENV, LOG_LEVEL: process.env.LOG_LEVEL }
    afterEach(() => {
      process.env.NODE_ENV = before.NODE_ENV
      if (before.LOG_LEVEL === undefined) delete process.env.LOG_LEVEL
      else process.env.LOG_LEVEL = before.LOG_LEVEL
    })

    it('should drop debug lines but keep every other level', () => {
      process.env.NODE_ENV = 'production'
      delete process.env.LOG_LEVEL

      log.debug('client_connected', { clients: 3 })
      expect(out).not.toHaveBeenCalled()

      log.info('server_started')
      log.warn('gateway_disconnected')
      log.error('discord_login_failed')
      expect(out).toHaveBeenCalledTimes(3)
    })

    it('should keep debug lines when LOG_LEVEL asks for them during an incident', () => {
      process.env.NODE_ENV = 'production'
      process.env.LOG_LEVEL = 'debug'

      log.debug('client_connected', { clients: 3 })

      expect(lastLine().event).toBe('client_connected')
    })
  })

  describe('when fields try to override the core keys', () => {
    it('should keep the real level and event when fields contain the same names', () => {
      log.info('history_loaded', { level: 'error', event: 'spoofed', count: 100 })

      expect(lastLine()).toMatchObject({ level: 'info', event: 'history_loaded', count: 100 })
    })

    it('should keep the real timestamp when fields contain a time', () => {
      log.info('history_loaded', { time: 'spoofed' })

      expect(lastLine().time).not.toBe('spoofed')
    })
  })
})

describe('log.count', () => {
  describe('when events are logged', () => {
    it('should count every call per event when debug lines are not written', () => {
      const before = { NODE_ENV: process.env.NODE_ENV, LOG_LEVEL: process.env.LOG_LEVEL }
      process.env.NODE_ENV = 'production'
      delete process.env.LOG_LEVEL
      const rejected = log.count('client_rejected')
      const dropped = log.count('client_dropped')

      log.debug('client_rejected', { requestId: 'a1b2c3' })
      log.debug('client_rejected', { requestId: 'd4e5f6' })
      log.warn('client_dropped', { requestId: 'a1b2c3' })

      expect(log.count('client_rejected')).toBe(rejected + 2)
      expect(log.count('client_dropped')).toBe(dropped + 1)
      expect(log.count('never_logged_event')).toBe(0)
      process.env.NODE_ENV = before.NODE_ENV
      if (before.LOG_LEVEL !== undefined) process.env.LOG_LEVEL = before.LOG_LEVEL
    })
  })
})

describe('errorMessage', () => {
  describe('when given an Error', () => {
    it('should return its message alone', () => {
      expect(errorMessage(new Error('Missing Access'))).toBe('Missing Access')
    })
  })

  describe('when given anything else', () => {
    it('should return it as a string', () => {
      expect(errorMessage('Missing Access')).toBe('Missing Access')
      expect(errorMessage(50001)).toBe('50001')
    })
  })
})
