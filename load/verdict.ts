/** A process above this share of its one core may be the bottleneck, not the server. */
const MAX_PROCESS_CPU_PCT = 80
/** A process this far behind its own timers may be reporting delivery late. */
const MAX_PROCESS_LAG_MS = 200

export type Verdict = 'PASS' | 'SLOW' | 'BROKEN' | 'INVALID'

/** What one step measured. */
export type StepOutcome = {
  received: number
  expected: number
  dropped: number
  gaps: number
  live: number
  healthy: number
  p99: number
  slowest: number
  busiestProcessCpu: number
  processLagMs: number
}

/** Judges one step. A busy process only matters when the step did not pass, since it can only make delivery look worse. */
export function classifyStep(o: StepOutcome, limits: { maxP99Ms: number; maxSlowestMs: number }): Verdict {
  const broken = o.received !== o.expected || o.dropped > 0 || o.gaps > 0 || o.live !== o.healthy
  if (!broken && o.p99 <= limits.maxP99Ms && o.slowest <= limits.maxSlowestMs) return 'PASS'
  if (o.busiestProcessCpu > MAX_PROCESS_CPU_PCT || o.processLagMs > MAX_PROCESS_LAG_MS) return 'INVALID'
  return broken ? 'BROKEN' : 'SLOW'
}

export type RampSummary = {
  /** The highest count that passed before anything failed. */
  usableMax: number | null
  firstNotPassing: number | null
  /** The highest count before a step was broken. */
  hardMax: number | null
  brokeAt: number | null
  /** A step whose result cannot be trusted. Nothing after it counts. */
  invalidAt: number | null
}

/** Reads a ramp's steps, lowest first, up to the first one that cannot be trusted. */
export function summarizeRamp(steps: Array<{ consumers: number; verdict: Verdict }>): RampSummary {
  const summary: RampSummary = { usableMax: null, firstNotPassing: null, hardMax: null, brokeAt: null, invalidAt: null }
  for (const { consumers, verdict } of steps) {
    if (verdict === 'INVALID') {
      summary.invalidAt = consumers
      break
    }
    if (verdict === 'BROKEN') {
      summary.firstNotPassing ??= consumers
      summary.brokeAt = consumers
      break
    }
    summary.hardMax = consumers
    if (verdict === 'SLOW') summary.firstNotPassing ??= consumers
    else if (summary.firstNotPassing === null) summary.usableMax = consumers
  }
  return summary
}

/** The next count to try between a pass and a failure, or null once the gap is within `precisionPct` of the failure. */
export function nextProbe(passed: number, failed: number, precisionPct: number): number | null {
  if (failed - passed <= (failed * precisionPct) / 100) return null
  const middle = Math.round((passed + failed) / 200) * 100
  return middle > passed && middle < failed ? middle : null
}
