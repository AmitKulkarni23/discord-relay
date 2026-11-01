/**
 * Writes one JSON log line to stdout, e.g.
 * `{"time":"…","event":"client_connected","clients":3}`.
 * Never pass the bot token or message content in `fields`.
 */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }))
}
