import { flags } from 'railway'
import { errorMessage, log } from './log.ts'

/** Feature flags, exposed to the browser through GET /config. */
export type Flags = { attachments: boolean; editsDeletes: boolean; debugPanel: boolean }

/** Used before the first sync, without a token, or when a flag is missing in Railway. */
export const DEFAULT_FLAGS: Flags = { attachments: false, editsDeletes: false, debugPanel: false }

/**
 * Starts Railway's feature-flag client and returns a reader for the current
 * values. Flags live in Project Settings → Feature Flags (`attachments`,
 * `edits-deletes`, `debug-panel`); the SDK keeps them in memory and polls
 * Railway, so a change applies within seconds and never needs a redeploy.
 * Never throws: without `RAILWAY_TOKEN`, or if Railway is unreachable, every
 * flag reads as its default and the app keeps running.
 */
export async function startFlags(env: Record<string, string | undefined>): Promise<() => Flags> {
  const token = env.RAILWAY_TOKEN
  if (!token) {
    log.warn('flags_unavailable', { reason: 'RAILWAY_TOKEN is not set; every flag is off' })
    return () => DEFAULT_FLAGS
  }

  try {
    await flags.init({ token, authType: 'project-token', timeoutMs: 5_000 })
    log.info('flags_loaded', { names: flags.list() })
  } catch (err) {
    log.warn('flags_unavailable', { reason: errorMessage(err) })
    return () => DEFAULT_FLAGS
  }

  return () => {
    // Event listeners read flags, where a throw would take the process down.
    try {
      return {
        attachments: flags.getBoolean('attachments', undefined, DEFAULT_FLAGS.attachments),
        editsDeletes: flags.getBoolean('edits-deletes', undefined, DEFAULT_FLAGS.editsDeletes),
        debugPanel: flags.getBoolean('debug-panel', undefined, DEFAULT_FLAGS.debugPanel),
      }
    } catch {
      return DEFAULT_FLAGS
    }
  }
}
