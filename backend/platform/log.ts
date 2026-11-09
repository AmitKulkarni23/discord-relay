/** Returns an error's message, or the value as a string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

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

/** How many times each event was logged. Keys are the event names written in the code, so the map stays small. */
const counts = new Map<string, number>()

/** Counts the event, then writes it unless its level is off. */
function emit(level: Level, event: string, fields: Record<string, unknown>, on = true): void {
  counts.set(event, (counts.get(event) ?? 0) + 1)
  if (on) write(level, event, fields)
}

/**
 * Structured logger: `log.info('server_started', { url })`.
 * Never pass the bot token or message content in `fields`.
 */
export const log = {
  // Off in production: a deploy reconnecting 12k clients would write 24k lines and bury real errors past Railway's 500 lines/s.
  debug: (event: string, fields: Record<string, unknown> = {}): void =>
    emit('debug', event, fields, process.env.NODE_ENV !== 'production' || process.env.LOG_LEVEL === 'debug'),
  info: (event: string, fields: Record<string, unknown> = {}): void => emit('info', event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}): void => emit('warn', event, fields),
  error: (event: string, fields: Record<string, unknown> = {}): void => emit('error', event, fields),
  /** How many times `event` was logged since the process started, debug lines included even when they are off. Feeds the metrics push. */
  count: (event: string): number => counts.get(event) ?? 0,
}
