/**
 * Reads and validates every environment variable once at startup (DISCORD_TOKEN, CHANNEL_ID,
 * BUFFER_SIZE, PORT, the Grafana trio). A bad value stops the process with a message naming the variable,
 * instead of failing later.
 */
/** Everything the process needs from its environment. */
export type Config = { token: string; channelIds: string[]; port: number; bufferSize: number; metrics: MetricsPush | null }

/** Where and how to push metrics to Grafana Cloud. */
export type MetricsPush = { url: string; user: string; token: string }

/** All three turn the metrics push on; none turns it off. */
const METRICS_VARS = ['GRAFANA_METRICS_URL', 'GRAFANA_METRICS_USER', 'GRAFANA_METRICS_TOKEN'] as const

/** Discord IDs (snowflakes) are 17 to 20 digits. */
const SNOWFLAKE = /^\d{17,20}$/

/**
 * Reads and validates config from an env object (normally `process.env`).
 * Throws an error naming the variable when a required one is missing or invalid.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const token = env.DISCORD_TOKEN
  if (!token) throw new Error('DISCORD_TOKEN is required')
  if (!env.CHANNEL_ID) throw new Error('CHANNEL_ID is required')
  const entries = env.CHANNEL_ID.split(',').map(entry => entry.trim())
  const invalid = entries.find(id => !SNOWFLAKE.test(id))
  if (invalid !== undefined) {
    throw new Error(`CHANNEL_ID must be one or more comma-separated Discord channel IDs, got "${invalid}"`)
  }
  const channelIds = [...new Set(entries)]

  const port = env.PORT ? Number(env.PORT) : 3000
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a port number, got "${env.PORT}"`)
  }

  const bufferSize = env.BUFFER_SIZE ? Number(env.BUFFER_SIZE) : 100
  if (!Number.isInteger(bufferSize) || bufferSize < 1 || bufferSize > 500) {
    throw new Error(`BUFFER_SIZE must be an integer from 1 to 500, got "${env.BUFFER_SIZE}"`)
  }

  return {
    token,
    channelIds,
    port,
    bufferSize,
    metrics: loadMetrics(env),
  }
}

/** Reads the Grafana push settings: null when none are set, an error naming the first missing one when only some are. */
function loadMetrics(env: Record<string, string | undefined>): MetricsPush | null {
  const [url, user, token] = METRICS_VARS.map(name => env[name])
  if (!url && !user && !token) return null
  const missing = METRICS_VARS.find(name => !env[name])
  if (missing || !url || !user || !token) throw new Error(`${missing} is required when any GRAFANA_METRICS_* variable is set`)
  if (!URL.canParse(url) || new URL(url).protocol !== 'https:') throw new Error(`GRAFANA_METRICS_URL must be an https URL, got "${url}"`)
  return { url, user, token }
}
