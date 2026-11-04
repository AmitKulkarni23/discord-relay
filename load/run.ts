/**
 * Finds how many concurrent /events clients the server holds: ramps through client counts and
 * stops at the first level that fails. Exits 1 if any level failed. Spawns load/server.ts unless
 * --host names a remote one; add --public for a deploy behind HTTPS with routes under /__load.
 *
 *   bun load/run.ts --levels 1000,5000,10000 --rate 5 --hold 60 --workers 4
 *
 * --msgBytes sets the size of each SSE event (default about 470). Discord allows 2,000 characters, or 4,000 with
 * Nitro, plus up to 10 attachments, so about 10000 is the realistic top. --channels spreads clients evenly across
 * that many channels, and --rate is per channel; a remote server sets it with CHANNELS instead.
 *
 * --slowPct makes that share of clients read slowly: --slowMode stop never reads after the headers, crawl takes one
 * read per second. They are left out of the delivery figures, so a level passes only if everyone else is unaffected.
 * --burst publishes that many messages in one go every --burstEverySec, instead of --rate, and silence between.
 * Filling the 1 MiB limit takes about (1 MiB + socket buffers) / (rate x msgBytes), so hold long enough to see drops.
 */
import { parseArgs } from 'node:util'
import type { WorkerCommand, WorkerReply } from './worker.ts'

const { values } = parseArgs({
  options: {
    host: { type: 'string' },
    public: { type: 'boolean', default: false },
    controlPath: { type: 'string', default: '/__load' },
    controlUrl: { type: 'string' },
    port: { type: 'string', default: '3100' },
    levels: { type: 'string', default: '100,1000,2000,5000,10000' },
    rate: { type: 'string', default: '5' },
    msgBytes: { type: 'string', default: '0' },
    channels: { type: 'string', default: '1' },
    burst: { type: 'string', default: '0' },
    burstEverySec: { type: 'string', default: '10' },
    slowPct: { type: 'string', default: '0' },
    slowMode: { type: 'string', default: 'stop' },
    hold: { type: 'string', default: '60' },
    workers: { type: 'string', default: '4' },
    listeners: { type: 'string', default: '1' },
    connectPerSec: { type: 'string', default: '1000' },
    maxP99Ms: { type: 'string', default: '1000' },
    keepGoing: { type: 'boolean', default: false },
    maxSec: { type: 'string', default: '900' },
  },
})

const port = Number(values.port)
const burst = Number(values.burst)
const burstEverySec = Number(values.burstEverySec)
const rate = burst ? burst / burstEverySec : Number(values.rate)
const msgBytes = Number(values.msgBytes)
const holdSec = Number(values.hold)
const workerCount = Number(values.workers)
const connectPerSec = Number(values.connectPerSec)
const maxP99Ms = Number(values.maxP99Ms)
const listeners = Number(values.listeners)
const isPublic = values.public as boolean
const ports = isPublic ? [443] : Array.from({ length: listeners }, (_, i) => (i === 0 ? port : port + 1 + i))
const levels = (values.levels as string).split(',').map(Number)
const GRACE_MS = 10_000
// The window skips at least one burst and needs a few more to measure.
if (burst && holdSec < burstEverySec * 3) throw new Error('--hold must be at least 3 times --burstEverySec')

const localServer = values.host
  ? null
  : Bun.spawn(['bun', 'load/server.ts'], {
      env: { ...process.env, PORT: String(port), LISTENERS: String(listeners), CHANNELS: values.channels },
      stdout: 'ignore',
      stderr: 'inherit',
    })
const host = values.host ?? '127.0.0.1'
const control = values.controlUrl ?? (isPublic ? `https://${host}${values.controlPath}` : `http://${host.includes(':') ? `[${host}]` : host}:${port + 1}`)

type Stats = {
  now: number
  seq: number
  channelIds: string[]
  clients: number
  cpuPct: number
  rssMb: number
  rssMaxMb: number
  lagMsMax: number
  publishes: number
  publishMsAvg: number
  publishMsMax: number
}
const getStats = async (): Promise<Stats> => (await fetch(`${control}/stats`, { signal: AbortSignal.timeout(30_000) })).json() as Promise<Stats>

/** A worker's replies arrive on one queue, in order. */
type Worker = { command: (c: WorkerCommand) => void; next: () => Promise<WorkerReply>; kill: () => void }
function spawnWorker(): Worker {
  const replies: WorkerReply[] = []
  const waiting: Array<(r: WorkerReply) => void> = []
  const proc = Bun.spawn(['bun', 'load/worker.ts'], {
    stdout: 'inherit',
    stderr: 'inherit',
    ipc(message: WorkerReply) {
      const resolve = waiting.shift()
      if (resolve) resolve(message)
      else replies.push(message)
    },
  })
  return {
    command: c => proc.send(c),
    next: () => {
      const queued = replies.shift()
      return queued ? Promise.resolve(queued) : new Promise(resolve => waiting.push(resolve))
    },
    kill: () => proc.kill(),
  }
}

function percentile(hist: Map<number, number>, total: number, p: number): number {
  let seen = 0
  for (const ms of [...hist.keys()].sort((a, b) => a - b)) {
    seen += hist.get(ms) ?? 0
    if (seen >= total * p) return ms
  }
  return Number.NaN
}

async function waitForServer(): Promise<Stats> {
  for (let i = 0; i < 100; i++) {
    try {
      return await getStats()
    } catch {
      await Bun.sleep(100)
    }
  }
  throw new Error(`no load server at ${control}`)
}

/** The server's clock minus ours, so delivery times hold across machines. */
async function clockOffset(): Promise<number> {
  let best = { rtt: Number.POSITIVE_INFINITY, offset: 0 }
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now()
    const s = await getStats()
    const t1 = Date.now()
    if (t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: s.now - (t0 + t1) / 2 }
  }
  return best.offset
}

const workers = Array.from({ length: workerCount }, spawnWorker)
const all = <T>(fn: (w: Worker, i: number) => Promise<T>) => Promise.all(workers.map(fn))

function stop(code: number): never {
  for (const w of workers) w.kill()
  localServer?.kill()
  process.exit(code)
}

// Nothing here may wait forever: a hard deadline, and every process exits together if one part dies.
setTimeout(
  () => {
    console.error(JSON.stringify({ event: 'deadline_exceeded', maxSec: values.maxSec }))
    stop(1)
  },
  Number(values.maxSec) * 1000,
)
process.on('uncaughtException', err => {
  console.error(err)
  stop(1)
})
process.on('unhandledRejection', err => {
  console.error(err)
  stop(1)
})
void localServer?.exited.then(code => {
  console.error(JSON.stringify({ event: 'load_server_exited', code }))
  stop(1)
})

const { channelIds } = await waitForServer()
const offsetMs = await clockOffset()
await fetch(`${control}/rate?perSec=0`, { method: 'POST' })
await Bun.sleep(1000)
const baseline = await getStats()
await fetch(`${control}/rate?perSec=${rate}&msgBytes=${msgBytes}&burst=${burst}&everySec=${burstEverySec}`, { method: 'POST' })
console.log(
  JSON.stringify({
    event: 'start',
    host,
    rate,
    msgBytes,
    burst,
    burstEverySec,
    channels: channelIds.length,
    slowPct: values.slowPct,
    slowMode: values.slowMode,
    holdSec,
    workerCount,
    levels,
    baselineRssMb: baseline.rssMb,
    clockOffsetMs: offsetMs,
  }),
)
console.log(
  'clients | conn s | delivered | p50 ms | p99 ms |  max ms | cpu avg% | cpu max% | rss MB | KB/client | srv lag ms | gen lag ms | gen cpu% | dropped | egress MB/s | slow gone | result',
)

let opened = 0
const results = []

for (const target of levels) {
  const toOpen = target - opened
  const connectStart = performance.now()
  await all((w, i) => {
    const count = Math.floor(toOpen / workerCount) + (i < toOpen % workerCount ? 1 : 0)
    w.command({
      type: 'open',
      host,
      ports,
      tls: isPublic,
      channelIds,
      count,
      perSec: connectPerSec / workerCount,
      worker: i,
      first: Math.floor(opened / workerCount),
      slowPct: Number(values.slowPct),
      slowMode: values.slowMode as string,
    })
    return w.next()
  }).then(replies => {
    const failed = replies.reduce((n, r) => n + (r.type === 'opened' ? r.failed : 0), 0)
    const statuses: Record<string, number> = {}
    for (const r of replies) if (r.type === 'opened') for (const [k, v] of Object.entries(r.statuses)) statuses[k] = (statuses[k] ?? 0) + v
    if (failed || Object.keys(statuses).some(s => s !== '200')) console.log(JSON.stringify({ event: 'connect_problems', target, failed, statuses }))
  })
  opened = target
  const connectSec = (performance.now() - connectStart) / 1000

  // Let the connect burst settle so the window measures steady state, not the burst.
  await Bun.sleep(5000)
  await getStats()

  const from = (await getStats()).seq + (burst ? burst * Math.max(1, Math.ceil(2 / burstEverySec)) : Math.ceil(rate * 2))
  for (const w of workers) w.command({ type: 'window', from, offsetMs })
  const windowStart = performance.now()
  const samples: Stats[] = []
  const holdEnd = performance.now() + holdSec * 1000
  while (performance.now() < holdEnd) {
    await Bun.sleep(5000)
    samples.push(await getStats())
  }
  const last = await getStats()
  samples.push(last)
  const to = last.seq
  const reports = await all(w => {
    w.command({ type: 'end', to, graceMs: GRACE_MS })
    return w.next()
  })

  const windowSec = (performance.now() - windowStart) / 1000
  const hist = new Map<number, number>()
  let live = 0
  let dropped = 0
  let received = 0
  let gaps = 0
  let dups = 0
  let behind = 0
  let genLag = 0
  let genCpu = 0
  let rxBytes = 0
  let slowTotal = 0
  for (const r of reports) {
    if (r.type !== 'report') continue
    live += r.live
    dropped += r.closed
    received += r.received
    gaps += r.gaps
    dups += r.dups
    behind += r.behind
    genLag = Math.max(genLag, r.lagMsMax)
    genCpu += r.cpuPct
    rxBytes += r.rxBytes
    slowTotal += r.slowTotal
    for (const [ms, n] of Object.entries(r.histMs)) hist.set(Number(ms), (hist.get(Number(ms)) ?? 0) + n)
  }

  const healthy = target - slowTotal
  const expected = healthy * (to - from)
  // A paused socket may never see its close, so the server's count is what shows the drops.
  const slowGone = Math.max(0, target - (await getStats()).clients)
  const egressMbPerSec = rxBytes / 2 ** 20 / windowSec
  const deliveredPct = (received / expected) * 100
  const p50 = percentile(hist, received, 0.5)
  const p99 = percentile(hist, received, 0.99)
  const max = Math.max(...hist.keys())
  const cpuAvg = samples.reduce((n, s) => n + s.cpuPct, 0) / samples.length
  const cpuMax = Math.max(...samples.map(s => s.cpuPct))
  const rssMax = Math.max(...samples.map(s => s.rssMaxMb))
  const lagMax = Math.max(...samples.map(s => s.lagMsMax))
  const kbPerClient = ((last.rssMb - baseline.rssMb) * 1024) / target
  const passed = received === expected && dropped === 0 && gaps === 0 && p99 <= maxP99Ms && live === healthy
  const row = {
    clients: target,
    connectSec,
    deliveredPct,
    p50,
    p99,
    max,
    cpuAvg,
    cpuMax,
    rssMb: last.rssMb,
    rssMax,
    kbPerClient,
    lagMax,
    genLag,
    genCpu,
    dropped,
    egressMbPerSec,
    slowTotal,
    slowGone,
    gaps,
    dups,
    behind,
    live,
    serverClients: last.clients,
    publishMsAvg: last.publishMsAvg,
    publishMsMax: Math.max(...samples.map(s => s.publishMsMax)),
    passed,
  }
  results.push(row)

  console.log(
    [
      String(target).padStart(7),
      connectSec.toFixed(1).padStart(6),
      `${deliveredPct.toFixed(2)}%`.padStart(9),
      String(p50).padStart(6),
      String(p99).padStart(6),
      String(max).padStart(7),
      cpuAvg.toFixed(0).padStart(8),
      cpuMax.toFixed(0).padStart(8),
      last.rssMb.toFixed(0).padStart(6),
      kbPerClient.toFixed(1).padStart(9),
      lagMax.toFixed(0).padStart(10),
      genLag.toFixed(0).padStart(10),
      genCpu.toFixed(0).padStart(8),
      String(dropped).padStart(7),
      egressMbPerSec.toFixed(2).padStart(11),
      String(slowGone).padStart(9),
      passed ? 'PASS' : 'FAIL',
    ].join(' | '),
  )
  console.log(JSON.stringify({ event: 'level', ...row }))

  if (!passed && !values.keepGoing) break
}

console.log(JSON.stringify({ event: 'done', maxPassing: results.filter(r => r.passed).at(-1)?.clients ?? 0 }))
stop(results.every(r => r.passed) ? 0 : 1)
