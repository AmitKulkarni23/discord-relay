import { describe, expect, it } from 'bun:test'
import { loadConfig } from '../config.ts'

const CHANNEL = '1301000000000000001'
const CHANNEL_2 = '1301000000000000002'
const VALID_ENV = { DISCORD_TOKEN: 'MTI5MDAwMDAwMDAwMDAwMDQy.fake.token', CHANNEL_ID: CHANNEL }

describe('loadConfig', () => {
  describe('when a required variable is missing', () => {
    it('should throw naming DISCORD_TOKEN when it is missing', () => {
      expect(() => loadConfig({ CHANNEL_ID: CHANNEL })).toThrow('DISCORD_TOKEN')
    })

    it('should throw naming CHANNEL_ID when it is empty', () => {
      expect(() => loadConfig({ ...VALID_ENV, CHANNEL_ID: '' })).toThrow('CHANNEL_ID')
    })
  })

  describe('when CHANNEL_ID lists one or more channels', () => {
    it('should return one channel when CHANNEL_ID holds a single ID', () => {
      expect(loadConfig(VALID_ENV).channelIds).toEqual([CHANNEL])
    })

    it('should split, trim and dedupe when CHANNEL_ID is comma-separated', () => {
      const env = { ...VALID_ENV, CHANNEL_ID: `${CHANNEL}, ${CHANNEL_2},${CHANNEL}` }
      expect(loadConfig(env).channelIds).toEqual([CHANNEL, CHANNEL_2])
    })

    it('should throw naming CHANNEL_ID when an entry is empty or not a snowflake', () => {
      for (const bad of [`${CHANNEL},,${CHANNEL_2}`, 'general', '12345', `${CHANNEL},#announcements`]) {
        expect(() => loadConfig({ ...VALID_ENV, CHANNEL_ID: bad })).toThrow('CHANNEL_ID')
      }
    })
  })

  describe('when PORT is set or unset', () => {
    it('should default to 3000 when PORT is unset', () => {
      expect(loadConfig(VALID_ENV).port).toBe(3000)
    })

    it('should use the value when PORT is a valid number', () => {
      expect(loadConfig({ ...VALID_ENV, PORT: '8080' }).port).toBe(8080)
    })

    it('should throw naming PORT when it is not a number', () => {
      expect(() => loadConfig({ ...VALID_ENV, PORT: 'eighty' })).toThrow('PORT')
    })
  })

  describe('when BUFFER_SIZE is set or unset', () => {
    it('should default to 100 when BUFFER_SIZE is unset', () => {
      expect(loadConfig(VALID_ENV).bufferSize).toBe(100)
    })

    it('should use the value when BUFFER_SIZE is an integer from 1 to 500', () => {
      expect(loadConfig({ ...VALID_ENV, BUFFER_SIZE: '250' }).bufferSize).toBe(250)
    })

    it('should throw naming BUFFER_SIZE when it is out of range or not an integer', () => {
      for (const bad of ['0', '501', 'abc', '1.5']) {
        expect(() => loadConfig({ ...VALID_ENV, BUFFER_SIZE: bad })).toThrow('BUFFER_SIZE')
      }
    })
  })

  describe('when the Grafana metrics variables are set', () => {
    const METRICS = {
      GRAFANA_METRICS_URL: 'https://prometheus-prod-67-prod-us-west-0.grafana.net/api/v1/push/influx/write',
      GRAFANA_METRICS_USER: '3747868',
      GRAFANA_METRICS_TOKEN: 'glc_fake_token',
    }

    it('should turn metrics off when none of them is set', () => {
      expect(loadConfig(VALID_ENV).metrics).toBeNull()
    })

    it('should return all three when all are set', () => {
      expect(loadConfig({ ...VALID_ENV, ...METRICS }).metrics).toEqual({ url: METRICS.GRAFANA_METRICS_URL, user: '3747868', token: 'glc_fake_token' })
    })

    it('should name the missing variable when only some are set', () => {
      expect(() => loadConfig({ ...VALID_ENV, ...METRICS, GRAFANA_METRICS_TOKEN: '' })).toThrow('GRAFANA_METRICS_TOKEN')
    })

    it('should reject a URL that is not https when one is given', () => {
      expect(() => loadConfig({ ...VALID_ENV, ...METRICS, GRAFANA_METRICS_URL: 'prometheus-prod-67' })).toThrow('GRAFANA_METRICS_URL')
    })
  })
})
