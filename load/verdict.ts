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
  /** Messages an outside generator could not deliver to the server. */
  generatorFailed: number
  /** How far an outside generator fell behind its own timers. */
  generatorLagMs: number
}

/** Judges one step. A busy process only matters when the step did not pass, since it can only make delivery look worse. */
export function classifyStep(o: StepOutcome, limits: { maxP99Ms: number; maxSlowestMs: number }): Verdict {
  const broken = o.received !== o.expected || o.dropped > 0 || o.gaps > 0 || o.live !== o.healthy || o.generatorFailed > 0
  if (!broken && o.p99 <= limits.maxP99Ms && o.slowest <= limits.maxSlowestMs) return 'PASS'
  if (o.busiestProcessCpu > MAX_PROCESS_CPU_PCT || o.processLagMs > MAX_PROCESS_LAG_MS || o.generatorLagMs > MAX_PROCESS_LAG_MS) return 'INVALID'
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

export type SearchResult = {
  usableMax: number | null
  /** True only when `usableMax` passed every repeat and a higher count was seen to fail. */
  confirmed: boolean
  invalidAt: number | null
}

/**
 * Narrows the gap a ramp left between its last pass and first failure, then repeats the result, because
 * runs vary. A count that fails a repeat counts as a failure and the search continues below it.
 */
export async function findUsableMax(
  ramp: Pick<RampSummary, 'usableMax' | 'firstNotPassing'>,
  tryCount: (consumers: number) => Promise<Verdict>,
  options: { precisionPct: number; repeats: number; maxTries: number },
): Promise<SearchResult> {
  let passed = ramp.usableMax ?? 0
  let failed = ramp.firstNotPassing
  const found = (confirmed: boolean, invalidAt: number | null = null): SearchResult => ({ usableMax: passed || null, confirmed, invalidAt })
  if (failed === null) return found(false)

  let tries = 0
  while (tries < options.maxTries) {
    const probe = nextProbe(passed, failed, options.precisionPct)
    if (probe !== null) {
      tries++
      const verdict = await tryCount(probe)
      if (verdict === 'INVALID') return found(false, probe)
      if (verdict === 'PASS') passed = probe
      else failed = probe
      continue
    }
    if (passed === 0) return found(false)
    let held = true
    for (let i = 0; i < options.repeats && held; i++) {
      if (tries >= options.maxTries) return found(false)
      tries++
      const verdict = await tryCount(passed)
      if (verdict === 'INVALID') return found(false, passed)
      held = verdict === 'PASS'
    }
    if (held) return found(true)
    // It did not hold, so it is the new failure, and nothing below it has been shown to pass yet.
    failed = passed
    passed = Math.floor((passed * (1 - (options.precisionPct * 2) / 100)) / 100) * 100
  }
  return found(false)
}
