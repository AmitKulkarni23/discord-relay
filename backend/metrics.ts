import type { MetricsPush } from './config.ts'
import type { Hub } from './hub.ts'
import { errorMessage, log } from './log.ts'

/** One reading of every metric. Totals count up from process start. */
export type Snapshot = {
  gatewayConnected: boolean
  sseClients: number
  messagesTotal: number
  clientsDroppedTotal: number
  rejectedTotal: number
  watchdogRestartsTotal: number
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** Escapes the characters Influx line protocol treats as separators in a tag value. */
const escapeTag = (value: string): string => value.replace(/[ ,=]/g, '\\$&')

/**
 * Formats a snapshot as one Influx line protocol line. Grafana Cloud stores field `x` of measurement
 * `relay` as the Prometheus metric `relay_x`. The deployment tag keeps the old and new process apart
 * while they overlap during a deploy, so their totals never mix.
 */
export function formatMetrics(s: Snapshot, deployment: string): string {
  const fields = {
    gateway_connected: s.gatewayConnected ? 1 : 0,
    sse_clients: s.sseClients,
    messages_total: s.messagesTotal,
    clients_dropped_total: s.clientsDroppedTotal,
    rejected_total: s.rejectedTotal,
    watchdog_restarts_total: s.watchdogRestartsTotal,
  }
  const values = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
  return `relay,deployment=${escapeTag(deployment)} ${values}`
}

/** Sends one body to Grafana Cloud. Never throws: a failed push is logged and the next one tries again. */
export async function pushMetrics(push: MetricsPush, body: string, fetch: Fetch = globalThis.fetch): Promise<void> {
  try {
    const res = await fetch(push.url, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${push.user}:${push.token}`)}`, 'Content-Type': 'text/plain' },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) log.warn('metrics_push_failed', { status: res.status })
  } catch (err) {
    log.warn('metrics_push_failed', { error: errorMessage(err) })
  }
}

/** Reads every metric now. Drops, 429s and watchdog restarts are counted from their log events. */
export function readSnapshot(hub: Pick<Hub, 'subscriberCount' | 'publishedTotal'>, gatewayConnected: boolean): Snapshot {
  return {
    gatewayConnected,
    sseClients: hub.subscriberCount(),
    messagesTotal: hub.publishedTotal(),
    clientsDroppedTotal: log.count('client_dropped'),
    rejectedTotal: log.count('client_rejected'),
    watchdogRestartsTotal: log.count('watchdog_expired'),
  }
}

/** Pushes a snapshot every `intervalMs`. Returns a function that stops it. */
export function startMetrics(opts: {
  push: MetricsPush
  deployment: string
  hub: Pick<Hub, 'subscriberCount' | 'publishedTotal'>
  isConnected: () => boolean
  intervalMs?: number
}): () => void {
  const send = (): Promise<void> => pushMetrics(opts.push, formatMetrics(readSnapshot(opts.hub, opts.isConnected()), opts.deployment))
  const timer = setInterval(() => void send(), opts.intervalMs ?? 60_000)
  return () => clearInterval(timer)
}
