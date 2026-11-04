import { describe, expect, it } from 'bun:test'
import { summarizeMetrics } from '../railway-metrics.ts'

describe('summarizeMetrics', () => {
  describe('when Railway returned samples for the window', () => {
    it('should report average and peak CPU, and peak memory', () => {
      const summary = summarizeMetrics({
        measurements: {
          CPU_USAGE: [
            { ts: '2026-11-04T09:00:00+00:00', value: 0.5 },
            { ts: '2026-11-04T09:00:30+00:00', value: 1 },
          ],
          MEMORY_USAGE_GB: [
            { ts: '2026-11-04T09:00:00+00:00', value: 1.5 },
            { ts: '2026-11-04T09:00:30+00:00', value: 2 },
          ],
        },
      })

      expect(summary).toEqual({ cpuAvg: 0.75, cpuMax: 1, memoryGbMax: 2, samples: 2 })
    })
  })

  describe('when Railway pads a window with zero samples', () => {
    it('should leave them out, because they would drag the average down', () => {
      const summary = summarizeMetrics({
        measurements: {
          CPU_USAGE: [
            { ts: '2026-11-04T09:00:00+00:00', value: 0 },
            { ts: '2026-11-04T09:00:30+00:00', value: 1 },
          ],
          MEMORY_USAGE_GB: [{ ts: '2026-11-04T09:00:00+00:00', value: 0 }],
        },
      })

      expect(summary).toEqual({ cpuAvg: 1, cpuMax: 1, memoryGbMax: null, samples: 1 })
    })
  })

  describe('when the window held no samples', () => {
    it('should report nothing instead of zero, because zero would look like an idle server', () => {
      expect(summarizeMetrics({ measurements: {} })).toEqual({ cpuAvg: null, cpuMax: null, memoryGbMax: null, samples: 0 })
    })
  })
})
