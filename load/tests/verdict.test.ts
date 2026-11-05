import { describe, expect, it } from 'bun:test'
import { classifyStep, findUsableMax, nextProbe, summarizeRamp, type StepOutcome, type Verdict } from '../verdict.ts'

const LIMITS = { maxP99Ms: 1000, maxSlowestMs: 5000 }
const clean: StepOutcome = {
  received: 1000,
  expected: 1000,
  dropped: 0,
  gaps: 0,
  live: 100,
  healthy: 100,
  p99: 200,
  slowest: 400,
  busiestProcessCpu: 30,
  processLagMs: 5,
  generatorFailed: 0,
  generatorLagMs: 0,
}

describe('classifyStep', () => {
  describe('when an outside generator is sending the messages', () => {
    it('should be broken when a send failed, even if every message that was sent arrived', () => {
      expect(classifyStep({ ...clean, generatorFailed: 1 }, LIMITS)).toBe('BROKEN')
    })

    it('should be invalid when the generator fell behind its own schedule and the step did not pass', () => {
      expect(classifyStep({ ...clean, p99: 2000, generatorLagMs: 500 }, LIMITS)).toBe('INVALID')
    })
  })

  describe('when delivery met every bar', () => {
    it('should pass', () => {
      expect(classifyStep(clean, LIMITS)).toBe('PASS')
    })

    it('should still pass with a busy process, because an overloaded rig can only make delivery look worse', () => {
      expect(classifyStep({ ...clean, busiestProcessCpu: 99, processLagMs: 900 }, LIMITS)).toBe('PASS')
    })
  })

  describe('when nothing was lost but delivery was late', () => {
    it('should be slow when p99 misses the bar', () => {
      expect(classifyStep({ ...clean, p99: 1001 }, LIMITS)).toBe('SLOW')
    })

    it('should be slow when the slowest delivery misses the bar', () => {
      expect(classifyStep({ ...clean, slowest: 5001 }, LIMITS)).toBe('SLOW')
    })
  })

  describe('when something was lost', () => {
    for (const [name, change] of [
      ['a message went missing', { received: 999 }],
      ['a connection closed', { dropped: 1 }],
      ['a stream skipped a message', { gaps: 1 }],
      ['a consumer is no longer connected', { live: 99 }],
    ] as Array<[string, Partial<StepOutcome>]>) {
      it(`should be broken when ${name}`, () => {
        expect(classifyStep({ ...clean, ...change }, LIMITS)).toBe('BROKEN')
      })
    }
  })

  describe('when it did not pass and the test rig was overloaded', () => {
    it('should be invalid when a process used too much CPU', () => {
      expect(classifyStep({ ...clean, p99: 3000, busiestProcessCpu: 81 }, LIMITS)).toBe('INVALID')
    })

    it('should be invalid when a process fell too far behind', () => {
      expect(classifyStep({ ...clean, received: 1, processLagMs: 201 }, LIMITS)).toBe('INVALID')
    })

    it('should not blame the rig right at the limits', () => {
      expect(classifyStep({ ...clean, p99: 3000, busiestProcessCpu: 80, processLagMs: 200 }, LIMITS)).toBe('SLOW')
    })
  })
})

describe('summarizeRamp', () => {
  describe('when a ramp goes from passing to slow to broken', () => {
    it('should report the usable max, the hard max and where each ended', () => {
      const summary = summarizeRamp([
        { consumers: 1000, verdict: 'PASS' },
        { consumers: 2000, verdict: 'PASS' },
        { consumers: 3000, verdict: 'SLOW' },
        { consumers: 4000, verdict: 'SLOW' },
        { consumers: 5000, verdict: 'BROKEN' },
      ])

      expect(summary).toEqual({ usableMax: 2000, firstNotPassing: 3000, hardMax: 4000, brokeAt: 5000, invalidAt: null })
    })
  })

  describe('when every step passes', () => {
    it('should say no limit was found', () => {
      expect(summarizeRamp([{ consumers: 1000, verdict: 'PASS' }])).toEqual({
        usableMax: 1000,
        firstNotPassing: null,
        hardMax: 1000,
        brokeAt: null,
        invalidAt: null,
      })
    })
  })

  describe('when the first step already fails', () => {
    it('should report no usable max', () => {
      expect(summarizeRamp([{ consumers: 1000, verdict: 'BROKEN' }])).toEqual({
        usableMax: null,
        firstNotPassing: 1000,
        hardMax: null,
        brokeAt: 1000,
        invalidAt: null,
      })
    })
  })

  describe('when a step is invalid', () => {
    it('should report nothing beyond it as known', () => {
      const summary = summarizeRamp([
        { consumers: 1000, verdict: 'PASS' },
        { consumers: 2000, verdict: 'INVALID' },
        { consumers: 3000, verdict: 'BROKEN' },
      ])

      expect(summary).toEqual({ usableMax: 1000, firstNotPassing: null, hardMax: 1000, brokeAt: null, invalidAt: 2000 })
    })
  })
})

describe('nextProbe', () => {
  describe('when the gap is wider than the precision', () => {
    it('should try the middle, rounded to a whole hundred', () => {
      expect(nextProbe(20_000, 40_000, 10)).toBe(30_000)
      expect(nextProbe(1000, 2300, 10)).toBe(1700)
    })
  })

  describe('when the gap is within the precision', () => {
    it('should stop', () => {
      expect(nextProbe(20_000, 22_000, 10)).toBeNull()
    })
  })

  describe('when rounding leaves nothing new to try', () => {
    it('should stop', () => {
      expect(nextProbe(100, 200, 10)).toBeNull()
    })
  })

  describe('when even the lowest count failed', () => {
    it('should search down from zero', () => {
      expect(nextProbe(0, 1000, 10)).toBe(500)
    })
  })
})

describe('findUsableMax', () => {
  const OPTIONS = { precisionPct: 10, repeats: 3, maxTries: 30 }
  /** A server that passes up to `capacity`, recording what was tried. */
  const serverWith = (capacity: number) => {
    const tried: number[] = []
    return {
      tried,
      tryCount: async (consumers: number): Promise<Verdict> => {
        tried.push(consumers)
        return consumers <= capacity ? 'PASS' : 'BROKEN'
      },
    }
  }

  describe('when the ramp found a pass and a failure', () => {
    it('should narrow down, then confirm the result the set number of times', async () => {
      const server = serverWith(27_000)

      const result = await findUsableMax({ usableMax: 20_000, firstNotPassing: 40_000 }, server.tryCount, OPTIONS)

      expect(result).toEqual({ usableMax: 25_000, confirmed: true, invalidAt: null })
      expect(server.tried.filter(n => n === 25_000).length).toBeGreaterThanOrEqual(3)
    })
  })

  describe('when a limit passes once but not on repeat', () => {
    it('should lower it until it holds every time', async () => {
      let calls = 0
      const flaky = async (consumers: number): Promise<Verdict> => {
        calls++
        if (consumers > 10_000) return 'SLOW'
        if (consumers === 10_000) return calls % 2 === 0 ? 'SLOW' : 'PASS'
        return 'PASS'
      }

      const result = await findUsableMax({ usableMax: 10_000, firstNotPassing: 10_500 }, flaky, OPTIONS)

      expect(result.confirmed).toBe(true)
      expect(result.usableMax).toBeLessThan(10_000)
    })
  })

  describe('when the ramp never failed', () => {
    it('should say the limit was not found rather than claim one', async () => {
      const server = serverWith(100_000)

      expect(await findUsableMax({ usableMax: 60_000, firstNotPassing: null }, server.tryCount, OPTIONS)).toEqual({
        usableMax: 60_000,
        confirmed: false,
        invalidAt: null,
      })
      expect(server.tried).toEqual([])
    })
  })

  describe('when a try cannot be trusted', () => {
    it('should stop and name the count', async () => {
      const result = await findUsableMax({ usableMax: 1000, firstNotPassing: 2000 }, async () => 'INVALID', OPTIONS)

      expect(result).toEqual({ usableMax: 1000, confirmed: false, invalidAt: 1500 })
    })
  })

  describe('when it runs out of tries', () => {
    it('should stop without claiming a confirmed result', async () => {
      const result = await findUsableMax({ usableMax: 1000, firstNotPassing: 100_000 }, async () => 'PASS', { ...OPTIONS, maxTries: 2 })

      expect(result.confirmed).toBe(false)
    })
  })
})
