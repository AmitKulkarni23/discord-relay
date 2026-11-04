/** Railway reads this field to colour and filter log lines (`@level:error`). */
type Level = 'debug' | 'info' | 'warn' | 'error'

/**
 * Writes one JSON log line to stdout, e.g.
 * `{"clients":3,"time":"…","level":"info","event":"client_connected"}`.
 * `time`, `level` and `event` are written last so a field can never override them.
 */
function write(level: Level, event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ...fields, time: new Date().toISOString(), level, event }))
}

/**
 * Structured logger: `log.info('server_started', { url })`.
 * Never pass the bot token or message content in `fields`.
 */
export const log = {
  debug: (event: string, fields: Record<string, unknown> = {}): void => {
    // Off in production: a deploy reconnecting 12k clients would write 24k lines and bury real errors past Railway's 500 lines/s.
    if (process.env.NODE_ENV !== 'production' || process.env.LOG_LEVEL === 'debug') write('debug', event, fields)
  },
  info: (event: string, fields: Record<string, unknown> = {}): void => write('info', event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}): void => write('warn', event, fields),
  error: (event: string, fields: Record<string, unknown> = {}): void => write('error', event, fields),
}
