import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { createHub } from '../hub.ts'
import { log } from '../log.ts'
import { formatMetrics, pushMetrics, readSnapshot, type Snapshot } from '../metrics.ts'

const out = spyOn(console, 'log').mockImplementation(() => {})
afterEach(() => out.mockClear())

const PUSH = { url: 'https://prometheus-prod-67-prod-us-west-0.grafana.net/api/v1/push/influx/write', user: '3747868', token: 'glc_fake_token' }
const SNAPSHOT: Snapshot = { gatewayConnected: true, sseClients: 42, messagesTotal: 318, clientsDroppedTotal: 2, rejectedTotal: 5, watchdogRestartsTotal: 0 }
const DEPLOYMENT = '6f1c2a9e-0b7d-4f3e-9a51-2c8d7e4b1f60'

describe('formatMetrics', () => {
  describe('when given a snapshot', () => {
    it('should write one Influx line tagged with the deployment when called', () => {
      expect(formatMetrics(SNAPSHOT, DEPLOYMENT)).toBe(
        `relay,deployment=${DEPLOYMENT} gateway_connected=1,sse_clients=42,messages_total=318,clients_dropped_total=2,rejected_total=5,watchdog_restarts_total=0`,
      )
    })

    it('should escape spaces, commas and equals signs when the deployment tag has them', () => {
      expect(formatMetrics({ ...SNAPSHOT, gatewayConnected: false }, 'local dev,a=b')).toStartWith('relay,deployment=local\\ dev\\,a\\=b gateway_connected=0,')
    })
  })
})

describe('pushMetrics', () => {
  describe('when Grafana accepts the push', () => {
    it('should POST the line with basic auth when called', async () => {
      const fetch = mock(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }))
      await pushMetrics(PUSH, 'relay sse_clients=42', fetch)

      const [url, init] = fetch.mock.calls[0] ?? []
      expect(url).toBe(PUSH.url)
      expect(init?.method).toBe('POST')
      expect(init?.body).toBe('relay sse_clients=42')
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${btoa('3747868:glc_fake_token')}`)
      expect(out).not.toHaveBeenCalled()
    })
  })

  describe('when the push fails', () => {
    it('should log a warning with the status when Grafana rejects it', async () => {
      await pushMetrics(PUSH, 'relay sse_clients=42', async () => new Response('authentication error', { status: 401 }))

      expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({ level: 'warn', event: 'metrics_push_failed', status: 401 })
    })

    it('should log a warning instead of throwing when the network fails', async () => {
      await pushMetrics(PUSH, 'relay sse_clients=42', async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      })

      expect(JSON.parse(String(out.mock.calls[0]?.[0]))).toMatchObject({ event: 'metrics_push_failed', error: 'getaddrinfo ENOTFOUND' })
    })
  })
})

describe('readSnapshot', () => {
  describe('when the hub and the logs have activity', () => {
    it('should read clients and messages from the hub and totals from the log counts when called', () => {
      const hub = createHub(10)
      hub.subscribe('1301000000000000001', () => {})
      const dropped = log.count('client_dropped')
      log.warn('client_dropped', { requestId: 'a1b2c3' })

      expect(readSnapshot(hub, true)).toMatchObject({ gatewayConnected: true, sseClients: 1, messagesTotal: 0, clientsDroppedTotal: dropped + 1 })
    })
  })
})
