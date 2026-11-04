/** Ramps /events clients until a level fails; `bun load/run.ts --help` lists every knob. */
import { parseArgs } from 'node:util'
import type { ConsumerCommand, ConsumerReply } from './consumer.ts'

const HELP = `Finds how many concurrent /events clients the server holds: ramps through client counts and stops at the
first level that fails. Exits 1 if any level failed. Local only unless you mean otherwise: never point it at production.

  bun load/run.ts --levels 1000,5000,10000 --rate 5 --hold 60 --consumers 4

Load
  --levels <n,n>         client counts to ramp through (default 100,1000,2000,5000,10000)
  --rate <n>             messages per second, per channel (default 5)
  --hold <sec>           how long each level holds (default 60)
  --msgBytes <n>         size of each SSE event; 0 keeps about 470 (default 0). About 10000 is the realistic top
  --channels <n>         spread clients evenly across this many channels (default 1). A remote server sets CHANNELS instead

Traffic shape
  --burst <n>            publish this many at once every --burstEverySec, instead of --rate (default 0, off)
  --burstEverySec <sec>  time between bursts (default 10). --hold must be at least 3 times this
  --slowPct <n>          percent of clients that read slowly (default 0). Left out of delivery figures, so a level
                         passes only if everyone else is unaffected
  --slowMode <mode>      stop never reads after the headers, crawl takes one read per second (default stop)
  --churnPerSec <n>      close and reconnect this many clients every second (default 0). A 15 minute cut of N clients is N / 900
  --storm                close every client at once halfway through the hold, as a deploy does
  --stormJitterMs <ms>   clients return over this window (default 1000). Raise --maxP99Ms to about this for a storm

Pass or fail
  --maxP99Ms <ms>        latency limit for a level (default 1000)
  --keepGoing            run every level even after one fails
  --maxSec <sec>         abort the whole run after this long (default 900)

Consumers
  --consumers <n>        consumer processes (default 4)
  --connectPerSec <n>    how fast clients connect (default 1000)
  --listeners <n>        ports the server listens on (default 1)

Target
  --port <n>             local server port; control runs on port + 1 (default 3100)
  --host <host>          use this server instead of spawning load/server.ts
  --public               the host is a deploy behind HTTPS, with its control routes under --controlPath
  --controlPath <path>   control route prefix with --public (default /__load)
  --controlUrl <url>     full control URL, overriding the above

Reconnects use ?since=, so a missed message counts as a gap, and a message held up by a reconnect counts towards p99.
A storm keeps the server up, so its buffer survives, unlike a real restart.
Filling the 1 MiB limit takes about (1 MiB + socket buffers) / (rate x msgBytes), so hold long enough to see drops.`

const { values } = parseArgs({
  options: {
    help: { type: 'boolean', short: 'h', default: false },
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
    churnPerSec: { type: 'string', default: '0' },
    storm: { type: 'boolean', default: false },
    stormJitterMs: { type: 'string', default: '1000' },
    slowPct: { type: 'string', default: '0' },
    slowMode: { type: 'string', default: 'stop' },
    hold: { type: 'string', default: '60' },
    consumers: { type: 'string', default: '4' },
    listeners: { type: 'string', default: '1' },
    connectPerSec: { type: 'string', default: '1000' },
    maxP99Ms: { type: 'string', default: '1000' },
    keepGoing: { type: 'boolean', default: false },
    maxSec: { type: 'string', default: '900' },
  },
})

if (values.help) {
  console.log(HELP)
  process.exit(0)
}

const port = Number(values.port)
const burst = Number(values.burst)
const burstEverySec = Number(values.burstEverySec)
const rate = burst ? burst / burstEverySec : Number(values.rate)
const msgBytes = Number(values.msgBytes)
const holdSec = Number(values.hold)
const consumerCount = Number(values.consumers)
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

/** A consumer's replies arrive on one queue, in order. */
type Consumer = { command: (c: ConsumerCommand) => void; next: () => Promise<ConsumerReply>; kill: () => void }
function spawnConsumer(): Consumer {
  const replies: ConsumerReply[] = []
  const waiting: Array<(r: ConsumerReply) => void> = []
  const proc = Bun.spawn(['bun', 'load/consumer.ts'], {
    stdout: 'inherit',
    stderr: 'inherit',
    ipc(message: ConsumerReply) {
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

const consumers = Array.from({ length: consumerCount }, spawnConsumer)
const all = <T>(fn: (w: Consumer, i: number) => Promise<T>) => Promise.all(consumers.map(fn))

function stop(code: number): never {
  for (const w of consumers) w.kill()
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
    churnPerSec: values.churnPerSec,
    storm: values.storm,
    stormJitterMs: values.stormJitterMs,
    channels: channelIds.length,
    slowPct: values.slowPct,
    slowMode: values.slowMode,
    holdSec,
    consumerCount,
    levels,
    baselineRssMb: baseline.rssMb,
    clockOffsetMs: offsetMs,
  }),
)
console.log(
  'clients | conn s | delivered | p50 ms | p99 ms |  max ms | cpu avg% | cpu max% | rss MB | KB/client | srv lag ms | consumer lag ms | consumer cpu% | dropped | egress MB/s | slow gone | reconnects | recon fails | recon max ms | result',
)

let opened = 0
const results = []

for (const target of levels) {
  const toOpen = target - opened
  const connectStart = performance.now()
  await all((w, i) => {
    const count = Math.floor(toOpen / consumerCount) + (i < toOpen % consumerCount ? 1 : 0)
    w.command({
      type: 'open',
      host,
      ports,
      tls: isPublic,
      channelIds,
      count,
      perSec: connectPerSec / consumerCount,
      consumer: i,
      first: Math.floor(opened / consumerCount),
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
  for (const w of consumers) w.command({ type: 'window', from, offsetMs })
  const windowStart = performance.now()
  const churnPerSec = Number(values.churnPerSec)
  if (churnPerSec) for (const w of consumers) w.command({ type: 'churn', perSec: churnPerSec / consumerCount })
  if (values.storm) {
    setTimeout(
      () => {
        for (const w of consumers) w.command({ type: 'storm', jitterMs: Number(values.stormJitterMs) })
      },
      (holdSec * 1000) / 2,
    )
  }
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
  let consumerLag = 0
  let consumerCpu = 0
  let rxBytes = 0
  let slowTotal = 0
  let reconnects = 0
  let reconnectFailed = 0
  let reconnectMsMax = 0
  for (const r of reports) {
    if (r.type !== 'report') continue
    live += r.live
    dropped += r.closed
    received += r.received
    gaps += r.gaps
    dups += r.dups
    behind += r.behind
    consumerLag = Math.max(consumerLag, r.lagMsMax)
    consumerCpu += r.cpuPct
    rxBytes += r.rxBytes
    slowTotal += r.slowTotal
    reconnects += r.reconnects
    reconnectFailed += r.reconnectFailed
    reconnectMsMax = Math.max(reconnectMsMax, r.reconnectMsMax)
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
    consumerLag,
    consumerCpu,
    dropped,
    egressMbPerSec,
    slowTotal,
    slowGone,
    reconnects,
    reconnectFailed,
    reconnectMsMax,
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
      consumerLag.toFixed(0).padStart(15),
      consumerCpu.toFixed(0).padStart(13),
      String(dropped).padStart(7),
      egressMbPerSec.toFixed(2).padStart(11),
      String(slowGone).padStart(9),
      String(reconnects).padStart(10),
      String(reconnectFailed).padStart(11),
      reconnectMsMax.toFixed(0).padStart(12),
      passed ? 'PASS' : 'FAIL',
    ].join(' | '),
  )
  console.log(JSON.stringify({ event: 'level', ...row }))

  if (!passed && !values.keepGoing) break
}

console.log(JSON.stringify({ event: 'done', maxPassing: results.filter(r => r.passed).at(-1)?.clients ?? 0 }))
stop(results.every(r => r.passed) ? 0 : 1)
