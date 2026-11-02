/** Everything the process needs from its environment. */
export type Config = { token: string; channelIds: string[]; port: number; bufferSize: number }

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
  const entries = env.CHANNEL_ID.split(',').map(s => s.trim())
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
  }
}
