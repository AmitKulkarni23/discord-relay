/**
 * Adds Railway's own CPU and memory figures to a load test's results, measured from outside the process
 * so several readers cannot disturb them. Run it afterwards, wherever the Railway CLI is logged in.
 *
 *   bun load/railway-metrics.ts results.jsonl --service load-server
 *
 * results.jsonl is load/run.ts's or load/max.ts's output. Samples are 30 s apart, so short spikes do not show. Railway can pad a window with zeros, which are left out.
 */
import { parseArgs } from 'node:util'
import { summarizeMetrics, type Sample } from './metrics-summary.ts'

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { service: { type: 'string' }, environment: { type: 'string' } },
})
const [file] = positionals
if (!file || !values.service) throw new Error('usage: bun load/railway-metrics.ts results.jsonl --service <name> [--environment <name>]')
const env = values.environment ? ['-e', values.environment] : []
console.log('consumers | verdict | cpu avg vCPU | cpu max vCPU | memory max GB | samples')
for (const line of (await Bun.file(file).text()).split('\n')) {
  if (!line.startsWith('{"event":"step"')) continue
  const step = JSON.parse(line) as { consumers: number; verdict: string; windowStartIso: string; windowEndIso: string }
  const proc = Bun.spawn(
    ['railway', 'metrics', '-s', values.service, ...env, '--cpu', '--memory', '--raw', '--json', '--since', step.windowStartIso, '--until', step.windowEndIso],
    {
      stderr: 'inherit',
    },
  )
  const m = summarizeMetrics(JSON.parse(await new Response(proc.stdout).text()) as { measurements: Record<string, Sample[]> })
  console.log(
    [
      String(step.consumers).padStart(9),
      step.verdict.padEnd(7),
      String(m.cpuAvg?.toFixed(2) ?? '-').padStart(12),
      String(m.cpuMax?.toFixed(2) ?? '-').padStart(12),
      String(m.memoryGbMax?.toFixed(2) ?? '-').padStart(13),
      String(m.samples).padStart(7),
    ].join(' | '),
  )
}
