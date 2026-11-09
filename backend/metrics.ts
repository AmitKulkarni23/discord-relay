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
  httpErrorsTotal: number
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** Escapes the characters Influx line protocol treats as separators in a tag value. */
const escapeTag = (value: string): string => value.replace(/[ ,=]/g, '\\$&')

/**
 * Formats a snapshot as one Influx line protocol line. Grafana Cloud stores field `x` of measurement
 * `relay` as the Prometheus metric `relay_x`. The deployment tag keeps the old and new process apart
 * while they overlap during a deploy, so their totals never mix.
 */
export function formatMetrics(snapshot: Snapshot, deployment: string): string {
  const fields = {
    gateway_connected: snapshot.gatewayConnected ? 1 : 0,
    sse_clients: snapshot.sseClients,
    messages_total: snapshot.messagesTotal,
    clients_dropped_total: snapshot.clientsDroppedTotal,
    rejected_total: snapshot.rejectedTotal,
    watchdog_restarts_total: snapshot.watchdogRestartsTotal,
    http_errors_total: snapshot.httpErrorsTotal,
  }
  const values = Object.entries(fields)
    .map(([name, value]) => `${name}=${value}`)
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

/** Reads every metric now. Drops, 429s, watchdog restarts and 500s are counted from their log events. */
export function readSnapshot(hub: Pick<Hub, 'subscriberCount' | 'publishedTotal'>, gatewayConnected: boolean): Snapshot {
  return {
    gatewayConnected,
    sseClients: hub.subscriberCount(),
    messagesTotal: hub.publishedTotal(),
    clientsDroppedTotal: log.count('client_dropped'),
    rejectedTotal: log.count('client_rejected'),
    watchdogRestartsTotal: log.count('watchdog_expired'),
    httpErrorsTotal: log.count('request_failed'),
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
