/**
 * Creates or updates DiscordRelay's Grafana dashboard and alert rules. This file is their source of
 * truth: change them here and run it again, never only in the Grafana UI.
 *
 *   GRAFANA_TOKEN=<service account token, Admin role> bun .grafana/apply.ts
 *
 * Alerts go to the contact point named in CONTACT_POINT, which holds the Discord webhook and is
 * created by hand in Grafana (Alerting > Contact points) so the webhook URL never enters the repo.
 */

const GRAFANA_URL = process.env.GRAFANA_URL ?? 'https://earnestturkey2621.grafana.net'
const CONTACT_POINT = 'Discord Incidents'
const FOLDER_UID = 'discord-relay'

const token = process.env.GRAFANA_TOKEN
if (!token) throw new Error('GRAFANA_TOKEN is required: a Grafana service account token with the Admin role')

/** Calls the Grafana HTTP API and returns the parsed body; throws with Grafana's answer on failure. */
async function api(method: string, path: string, body?: unknown, ok: number[] = []): Promise<unknown> {
  const res = await fetch(`${GRAFANA_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Disable-Provenance': 'true' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok && !ok.includes(res.status)) throw new Error(`${method} ${path}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

/** Finds the stack's own Prometheus data source, where the app's pushed metrics land. */
async function prometheusUid(): Promise<string> {
  const sources = (await api('GET', '/api/datasources')) as { uid: string; name: string; type: string }[]
  const prom = sources.find(source => source.type === 'prometheus' && source.name.startsWith('grafanacloud-') && source.name.endsWith('-prom'))
  if (!prom) throw new Error(`no grafanacloud-*-prom data source among: ${sources.map(source => source.name).join(', ')}`)
  return prom.uid
}

/** A dashboard panel with one or more PromQL queries. */
function panel(id: number, title: string, type: 'stat' | 'timeseries', x: number, y: number, dataSource: string, queries: Record<string, string>, extra = {}) {
  return {
    id,
    title,
    type,
    gridPos: { x, y, w: 12, h: 8 },
    datasource: { type: 'prometheus', uid: dataSource },
    targets: Object.entries(queries).map(([legendFormat, expr], i) => ({
      refId: String.fromCharCode(65 + i),
      expr,
      legendFormat,
      datasource: { type: 'prometheus', uid: dataSource },
    })),
    ...extra,
  }
}

function dashboard(dataSource: string) {
  return {
    uid: 'discord-relay',
    title: 'DiscordRelay',
    timezone: 'browser',
    refresh: '1m',
    time: { from: 'now-6h', to: 'now' },
    schemaVersion: 39,
    panels: [
      panel(
        1,
        'Discord Gateway',
        'stat',
        0,
        0,
        dataSource,
        { gateway: 'max(last_over_time(relay_gateway_connected[2m]))' },
        {
          fieldConfig: {
            defaults: {
              mappings: [{ type: 'value', options: { '0': { text: 'Disconnected', color: 'red' }, '1': { text: 'Connected', color: 'green' } } }],
              noValue: 'No data: app down?',
            },
            overrides: [],
          },
          options: { colorMode: 'background', reduceOptions: { calcs: ['lastNotNull'] } },
        },
      ),
      // ponytail: max, not sum, so the old and new process overlapping in a deploy are not counted twice. Use sum once there are replicas.
      panel(2, 'Viewers (open streams)', 'timeseries', 12, 0, dataSource, { viewers: 'max(last_over_time(relay_sse_clients[2m]))' }),
      panel(3, 'Messages (per 5 min)', 'timeseries', 0, 8, dataSource, { messages: 'round(sum(increase(relay_messages_total[5m])))' }),
      panel(4, 'HTTP 500 errors (per 5 min)', 'timeseries', 12, 8, dataSource, { '500s': 'sum(increase(relay_http_errors_total[5m]))' }),
      panel(
        5,
        'Clients dropped (per 5 min)',
        'timeseries',
        0,
        16,
        dataSource,
        { dropped: 'sum(increase(relay_clients_dropped_total[5m]))' },
        { gridPos: { x: 0, y: 16, w: 8, h: 8 } },
      ),
      panel(
        6,
        '429 rejected (per 5 min)',
        'timeseries',
        8,
        16,
        dataSource,
        { rejected: 'sum(increase(relay_rejected_total[5m]))' },
        { gridPos: { x: 8, y: 16, w: 8, h: 8 } },
      ),
      panel(
        7,
        'Watchdog restarts (per 5 min)',
        'timeseries',
        16,
        16,
        dataSource,
        { restarts: 'sum(increase(relay_watchdog_restarts_total[5m]))' },
        { gridPos: { x: 16, y: 16, w: 8, h: 8 } },
      ),
    ],
  }
}

/** An alert rule that fires when `expr` crosses `threshold` for `pending`. */
function rule(
  uid: string,
  title: string,
  dataSource: string,
  expr: string,
  op: 'gt' | 'lt',
  threshold: number,
  pending: string,
  noData: 'OK' | 'Alerting',
  summary: string,
) {
  return {
    uid,
    title,
    orgID: 1,
    folderUID: FOLDER_UID,
    ruleGroup: 'relay',
    condition: 'C',
    for: pending,
    noDataState: noData,
    execErrState: 'Error',
    annotations: { summary },
    labels: {},
    notification_settings: { receiver: CONTACT_POINT },
    data: [
      { refId: 'A', datasourceUid: dataSource, relativeTimeRange: { from: 600, to: 0 }, model: { refId: 'A', expr, instant: true } },
      {
        refId: 'C',
        datasourceUid: '__expr__',
        relativeTimeRange: { from: 0, to: 0 },
        model: { refId: 'C', type: 'threshold', expression: 'A', conditions: [{ evaluator: { type: op, params: [threshold] } }] },
      },
    ],
  }
}

function alertRules(dataSource: string) {
  return [
    // No pushes at all: the process is down, crashing or cannot reach Grafana.
    rule(
      'relay-app-down',
      'App down',
      dataSource,
      'count(last_over_time(relay_gateway_connected[3m]))',
      'lt',
      1,
      '1m',
      'Alerting',
      'DiscordRelay has sent no metrics for 3 minutes.',
    ),
    rule(
      'relay-gateway-down',
      'Discord Gateway down',
      dataSource,
      'max(last_over_time(relay_gateway_connected[2m]))',
      'lt',
      1,
      '2m',
      'OK',
      'The bot has been disconnected from Discord for 2 minutes. Check /health and the gateway_disconnected logs.',
    ),
    rule(
      'relay-edge-cap',
      'Near the edge cap',
      dataSource,
      'max(last_over_time(relay_sse_clients[2m]))',
      'gt',
      8000,
      '5m',
      'OK',
      "Over 8,000 open streams. Railway's edge refuses new requests past 10,000 per edge node.",
    ),
    rule(
      'relay-http-errors',
      'HTTP 500 errors',
      dataSource,
      'sum(increase(relay_http_errors_total[5m]))',
      'gt',
      0,
      '0s',
      'OK',
      'A route threw and returned 500. Search the logs for @event:request_failed for the stack.',
    ),
    rule(
      'relay-drop-spike',
      'Drop spike',
      dataSource,
      'sum(increase(relay_clients_dropped_total[5m])) / clamp_min(max(last_over_time(relay_sse_clients[2m])), 1)',
      'gt',
      0.01,
      '0s',
      'OK',
      'More than 1% of clients were dropped in 5 minutes for falling 1 MiB behind. The server may be saturated.',
    ),
  ]
}

const dataSource = await prometheusUid()
await api('POST', '/api/folders', { uid: FOLDER_UID, title: 'DiscordRelay' }, [409, 412])
await api('POST', '/api/dashboards/db', { dashboard: dashboard(dataSource), folderUid: FOLDER_UID, overwrite: true })
await api('PUT', `/api/v1/provisioning/folder/${FOLDER_UID}/rule-groups/relay`, {
  title: 'relay',
  folderUid: FOLDER_UID,
  interval: 60,
  rules: alertRules(dataSource),
})
console.log(`Done: ${GRAFANA_URL}/d/discord-relay`)

export {}
