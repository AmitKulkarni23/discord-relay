export type Sample = { ts: string; value: number }
export type MetricsSummary = { cpuAvg: number | null; cpuMax: number | null; memoryGbMax: number | null; samples: number }

/** Reduces `railway metrics --raw --json` output to the figures a step needs. */
export function summarizeMetrics(raw: { measurements: Record<string, Sample[]> }): MetricsSummary {
  const cpu = (raw.measurements.CPU_USAGE ?? []).map(s => s.value).filter(v => v > 0)
  const memory = (raw.measurements.MEMORY_USAGE_GB ?? []).map(s => s.value).filter(v => v > 0)
  return {
    cpuAvg: cpu.length ? cpu.reduce((a, b) => a + b, 0) / cpu.length : null,
    cpuMax: cpu.length ? Math.max(...cpu) : null,
    memoryGbMax: memory.length ? Math.max(...memory) : null,
    samples: cpu.length,
  }
}
