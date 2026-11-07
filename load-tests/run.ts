/** Ramps /events consumers until a step fails; `bun load-tests/run.ts --help` lists every knob. */
import { parseArgs } from 'node:util'
import { clockOffset, spawnProcess, type ConsumerProcess } from './consumer-process.ts'
import type { ConsumerCommand, ConsumerReply } from './consumer.ts'
import { classifyStep, summarizeRamp, type Verdict } from './verdict.ts'

const HELP = `Finds how many consumers (open /events connections, each standing in for one browser) the server holds: tries each
count in turn and stops at the first step that fails. Exits 1 if any step failed. Local only unless you mean otherwise: never point it at production.

  bun load-tests/run.ts --consumers 1000,5000,10000 --rate 5 --hold 60 --processes 4

Load
  --consumers <n,n>      consumer counts to try, one step each (default 100,1000,2000,5000,10000)
  --rate <n>             messages per second, per channel (default 5)
  --hold <sec>           how long each step holds (default 60)
  --msgBytes <n>         size of each SSE event; 0 keeps about 470 (default 0). About 10000 is the realistic top
  --channels <n>         spread consumers evenly across this many channels (default 1). A remote server sets CHANNELS instead

Traffic shape
  --burst <n>            publish this many at once every --burstEverySec, instead of --rate (default 0, off)
  --burstEverySec <sec>  time between bursts (default 10). --hold must be at least 3 times this
  --slowPct <n>          percent of consumers that read slowly (default 0). Left out of delivery figures, so a step
                         passes only if everyone else is unaffected
  --slowMode <mode>      stop never reads after the headers, crawl takes one read per second (default stop)
  --churnPerSec <n>      close and reconnect this many consumers every second (default 0). A 15 minute cut of N consumers is N / 900
  --storm                close every client at once halfway through the hold, as a deploy does
  --stormJitterMs <ms>   consumers return over this window (default 1000). Raise --maxP99Ms to about this for a storm

Pass or fail
  --maxP99Ms <ms>        latency limit for a step (default 1000)
  --maxSlowestMs <ms>    limit on the single slowest delivery (default 5000)
  --findHardMax          keep going through SLOW steps, stopping at the first BROKEN one
  --keepGoing            run every step even after one fails
  --maxSec <sec>         abort the whole run after this long (default 900)

Consumers
  --processes <n>        processes per machine running the consumers, split evenly. Test rig only: the server is unaffected (default 4)
  --machines <url,url>   load-tests/agent.ts on other machines, which then hold the consumers instead of this one
  --connectPerSec <n>    how fast consumers connect (default 1000)
  --listeners <n>        ports the server listens on (default 1)

Target
  --port <n>             local server port; control runs on port + 1 (default 3100)
  --host <host>          use this server instead of spawning load-tests/server.ts
  --public               the host is a deploy behind HTTPS, with its control routes under --controlPath
  --controlPath <path>   control route prefix with --public (default /__load)
  --controlUrl <url>     full control URL, overriding the above
  --generator <url>      load-tests/generator.ts on another service sends the messages, on its own clock, instead of the server's own timer
  --ignoreClients <n>    start even with this many connections already open, such as a page left open on a live service (default 0)

A step is PASS, SLOW (nothing lost, too late), BROKEN (messages lost, consumers dropped or refused), or INVALID (did not pass
and a process was overloaded, so add processes or machines). Each step prints its window, for load-tests/railway-metrics.ts.

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
    generator: { type: 'string' },
    ignoreClients: { type: 'string', default: '0' },
    port: { type: 'string', default: '3100' },
    consumers: { type: 'string', default: '100,1000,2000,5000,10000' },
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
    processes: { type: 'string', default: '4' },
    machines: { type: 'string', default: '' },
    listeners: { type: 'string', default: '1' },
    connectPerSec: { type: 'string', default: '1000' },
    maxP99Ms: { type: 'string', default: '1000' },
    maxSlowestMs: { type: 'string', default: '5000' },
    findHardMax: { type: 'boolean', default: false },
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
const machines = (values.machines as string).split(',').filter(Boolean)
const processesPerMachine = Number(values.processes)
const processCount = processesPerMachine * Math.max(1, machines.length)
const connectPerSec = Number(values.connectPerSec)
const limits = { maxP99Ms: Number(values.maxP99Ms), maxSlowestMs: Number(values.maxSlowestMs) }
const listeners = Number(values.listeners)
const isPublic = values.public as boolean
const ignoreClients = Number(values.ignoreClients)
const consumerLevels = (values.consumers as string).split(',').map(Number)
const GRACE_MS = 10_000
/** Longer than any step takes, even at the highest counts. */
const MACHINE_TIMEOUT_MS = 30 * 60_000
// The window skips at least one burst and needs a few more to measure.
if (burst && holdSec < burstEverySec * 3) throw new Error('--hold must be at least 3 times --burstEverySec')

const localServer = values.host
  ? null
  : Bun.spawn(['bun', 'load-tests/server.ts'], {
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
  eventsPort: number
  clients: number
  cpuPct: number
  rssMb: number
  rssMaxMb: number
  lagMsMax: number
  publishes: number
  publishMsAvg: number
  publishMsMax: number
}
/** Whoever makes the messages holds their sequence number and the clock they are timed against. */
const source = values.generator ?? control
type GeneratorStats = { seq: number; failed: number; lagMsMax: number; sendMsMax: number }
const getGenerator = async (): Promise<GeneratorStats> =>
  (await fetch(`${source}/stats`, { signal: AbortSignal.timeout(30_000) })).json() as Promise<GeneratorStats>
const getStats = async (): Promise<Stats> => (await fetch(`${control}/stats`, { signal: AbortSignal.timeout(30_000) })).json() as Promise<Stats>

/** A process on another machine, driven through its load-tests/agent.ts. Commands stay in order, as they do over IPC. */
function remoteProcess(machine: string, i: number): ConsumerProcess {
  let sent: Promise<unknown> = Promise.resolve()
  return {
    command: c => {
      sent = sent.then(() => fetch(`${machine}/command?i=${i}`, { method: 'POST', body: JSON.stringify(c) }))
    },
    next: async () => (await (await fetch(`${machine}/next?i=${i}`, { signal: AbortSignal.timeout(MACHINE_TIMEOUT_MS) })).json()) as ConsumerReply,
    kill: () => {},
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

for (const machine of machines) await fetch(`${machine}/start?count=${processesPerMachine}`, { method: 'POST' })
const processes = machines.length
  ? machines.flatMap(machine => Array.from({ length: processesPerMachine }, (_, i) => remoteProcess(machine, i)))
  : Array.from({ length: processCount }, spawnProcess)
const all = <T>(fn: (w: ConsumerProcess, i: number) => Promise<T>) => Promise.all(processes.map(fn))

/** Stops every process, here and on other machines, so no connection outlives the run. */
async function stop(code: number): Promise<never> {
  for (const w of processes) w.kill()
  // A server on another service outlives the run, and it must not keep receiving messages.
  await Promise.allSettled([fetch(`${source}/rate?perSec=0`, { method: 'POST', signal: AbortSignal.timeout(5000) })])
  await Promise.allSettled(machines.map(machine => fetch(`${machine}/stop`, { method: 'POST', signal: AbortSignal.timeout(5000) })))
  localServer?.kill()
  process.exit(code)
}

// Nothing here may wait forever: a hard deadline, and every process exits together if one part dies.
setTimeout(
  () => {
    console.error(JSON.stringify({ event: 'deadline_exceeded', maxSec: values.maxSec }))
    void stop(1)
  },
  Number(values.maxSec) * 1000,
)
process.on('uncaughtException', err => {
  console.error(err)
  void stop(1)
})
process.on('unhandledRejection', err => {
  console.error(err)
  void stop(1)
})
void localServer?.exited.then(code => {
  console.error(JSON.stringify({ event: 'load_server_exited', code }))
  void stop(1)
})

const { channelIds, eventsPort } = await waitForServer()
const ports = isPublic ? [443] : Array.from({ length: listeners }, (_, i) => (i === 0 ? eventsPort : eventsPort + 1 + i))
// Each machine has its own clock, and delivery times are measured on the machine that receives them.
const localOffset = machines.length ? 0 : await clockOffset(source)
const machineOffsets = await Promise.all(
  machines.map(async machine => ((await (await fetch(`${machine}/offset?control=${encodeURIComponent(source)}`)).json()) as { offsetMs: number }).offsetMs),
)
const offsets = machines.length
  ? machines.flatMap((_, m) => Array.from({ length: processesPerMachine }, () => machineOffsets[m] ?? 0))
  : processes.map(() => localOffset)
await fetch(`${source}/rate?perSec=0`, { method: 'POST' })
await Bun.sleep(1000)
// A leftover connection would be counted as a consumer it is not, and it costs the server work.
for (let i = 0; (await getStats()).clients > ignoreClients; i++) {
  if (i === 60) throw new Error('the load server still has open connections: restart it, or wait for them to close')
  await Bun.sleep(1000)
}
const baseline = await getStats()
const generatorTarget = values.generator ? `&target=${encodeURIComponent(control)}&channels=${channelIds.join(',')}` : ''
await fetch(`${source}/rate?perSec=${rate}&msgBytes=${msgBytes}&burst=${burst}&everySec=${burstEverySec}${generatorTarget}`, { method: 'POST' })
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
    processCount,
    consumers: consumerLevels,
    baselineRssMb: baseline.rssMb,
    clockOffsetsMs: offsets,
    machines: machines.length,
  }),
)
console.log(
  'consumers | conn s | delivered | p50 ms | p99 ms |  max ms | cpu avg% | cpu max% | rss MB | KB/client | srv lag ms | process lag ms | process cpu% | dropped | egress MB/s | slow gone | reconnects | recon fails | recon max ms | result',
)

let opened = 0
const results = []

for (const target of consumerLevels) {
  const toOpen = target - opened
  const connectStart = performance.now()
  await all((w, i) => {
    const count = Math.floor(toOpen / processCount) + (i < toOpen % processCount ? 1 : 0)
    w.command({
      type: 'open',
      host,
      ports,
      tls: isPublic,
      channelIds,
      count,
      perSec: connectPerSec / processCount,
      processIndex: i,
      first: Math.floor(opened / processCount),
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

  // Reading the generator here also clears what it counted before the window.
  const from =
    (values.generator ? await getGenerator() : await getStats()).seq + (burst ? burst * Math.max(1, Math.ceil(2 / burstEverySec)) : Math.ceil(rate * 2))
  processes.forEach((w, i) => w.command({ type: 'window', from, offsetMs: offsets[i] ?? 0 }))
  const windowStart = performance.now()
  const windowStartIso = new Date().toISOString()
  const churnPerSec = Number(values.churnPerSec)
  if (churnPerSec) for (const w of processes) w.command({ type: 'churn', perSec: churnPerSec / processCount })
  if (values.storm) {
    setTimeout(
      () => {
        for (const w of processes) w.command({ type: 'storm', jitterMs: Number(values.stormJitterMs) })
      },
      (holdSec * 1000) / 2,
    )
  }
  const samples: Stats[] = []
  let generatorFailed = 0
  let generatorLagMs = 0
  let generatorSendMsMax = 0
  const readGenerator = async (): Promise<number> => {
    const g = await getGenerator()
    generatorFailed += g.failed
    generatorLagMs = Math.max(generatorLagMs, g.lagMsMax)
    generatorSendMsMax = Math.max(generatorSendMsMax, g.sendMsMax)
    return g.seq
  }
  const holdEnd = performance.now() + holdSec * 1000
  while (performance.now() < holdEnd) {
    await Bun.sleep(5000)
    samples.push(await getStats())
    if (values.generator) await readGenerator()
  }
  const last = await getStats()
  samples.push(last)
  const windowEndIso = new Date().toISOString()
  const to = values.generator ? await readGenerator() : last.seq
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
  let processLag = 0
  let busiestProcessCpu = 0
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
    processLag = Math.max(processLag, r.lagMsMax)
    busiestProcessCpu = Math.max(busiestProcessCpu, r.cpuPct)
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
  const verdict: Verdict = classifyStep(
    { received, expected, dropped, gaps, live, healthy, p99, slowest: max, busiestProcessCpu, processLagMs: processLag, generatorFailed, generatorLagMs },
    limits,
  )
  const row = {
    consumers: target,
    messages: to - from,
    generatorFailed,
    generatorLagMs,
    generatorSendMsMax,
    windowStartIso,
    windowEndIso,
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
    processLag,
    busiestProcessCpu,
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
    verdict,
  }
  results.push(row)

  console.log(
    [
      String(target).padStart(9),
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
      processLag.toFixed(0).padStart(14),
      busiestProcessCpu.toFixed(0).padStart(12),
      String(dropped).padStart(7),
      egressMbPerSec.toFixed(2).padStart(11),
      String(slowGone).padStart(9),
      String(reconnects).padStart(10),
      String(reconnectFailed).padStart(11),
      reconnectMsMax.toFixed(0).padStart(12),
      verdict,
    ].join(' | '),
  )
  console.log(JSON.stringify({ event: 'step', ...row }))

  if (!values.keepGoing && verdict !== 'PASS' && !(verdict === 'SLOW' && values.findHardMax)) break
}

console.log(JSON.stringify({ event: 'done', ...summarizeRamp(results) }))
await stop(results.every(r => r.verdict === 'PASS') ? 0 : 1)
