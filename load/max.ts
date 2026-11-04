/**
 * Finds the usable max at one message rate: ramps with load/run.ts, narrows the gap between its last
 * pass and first failure, and repeats the result. Each try is a separate run with no connections left over.
 *
 *   bun load/max.ts --rate 10 --consumers 5000,10000,20000,40000 --hold 60
 *
 * Takes load/run.ts's flags, plus --repeats (default 3) and --precisionPct (default 10).
 */
import { parseArgs } from 'node:util'
import { findUsableMax, type RampSummary, type Verdict } from './verdict.ts'

const OWN_FLAGS = new Set(['--consumers', '--repeats', '--precisionPct'])
const argv = Bun.argv.slice(2)
const { values } = parseArgs({
  args: argv,
  strict: false,
  options: { consumers: { type: 'string' }, repeats: { type: 'string', default: '3' }, precisionPct: { type: 'string', default: '10' } },
})
if (typeof values.consumers !== 'string') throw new Error('--consumers is required, for example --consumers 5000,10000,20000')
const passthrough = argv.filter((arg, i) => !OWN_FLAGS.has(arg) && !OWN_FLAGS.has(argv[i - 1] ?? ''))

/** Runs load/run.ts, passing its output through, and returns its summary. */
async function run(consumers: string, extra: string[] = []): Promise<RampSummary & { lastVerdict: Verdict | null }> {
  const proc = Bun.spawn(['bun', 'load/run.ts', '--consumers', consumers, ...extra, ...passthrough], { stdout: 'pipe', stderr: 'inherit' })
  const output = await new Response(proc.stdout).text()
  await proc.exited
  process.stdout.write(output)
  let summary: RampSummary | undefined
  let lastVerdict: Verdict | null = null
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue
    const event = JSON.parse(line) as { event: string; verdict?: Verdict } & RampSummary
    if (event.event === 'step' && event.verdict) lastVerdict = event.verdict
    if (event.event === 'done') summary = event
  }
  if (!summary) throw new Error(`load/run.ts ended without a result (exit ${proc.exitCode})`)
  return { ...summary, lastVerdict }
}

const ramp = await run(values.consumers, ['--findHardMax'])
const result = ramp.invalidAt
  ? { usableMax: ramp.usableMax, confirmed: false, invalidAt: ramp.invalidAt }
  : await findUsableMax(ramp, async consumers => (await run(String(consumers))).lastVerdict ?? 'INVALID', {
      precisionPct: Number(values.precisionPct),
      repeats: Number(values.repeats),
      maxTries: 30,
    })

console.log(JSON.stringify({ event: 'max', ...result, hardMaxAtLeast: ramp.hardMax, brokeAt: ramp.brokeAt }))
