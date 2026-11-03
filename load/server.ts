/**
 * The real hub and HTTP server with a fake producer instead of Discord, plus a control port
 * (PORT + 1) for the load runner: GET /stats, POST /rate?perSec=n. Never run against production.
 */
import { DEFAULT_FLAGS } from '../backend/flags.ts'
import { createHub } from '../backend/hub.ts'
import { startServer } from '../backend/server.ts'
import type { Msg } from '../backend/types.ts'

const port = Number(process.env.PORT ?? 3100)
const bufferSize = Number(process.env.BUFFER_SIZE ?? 100)
const CHANNEL = '1301000000000000001'
const ID_BASE = 1_301_000_000n * 10_000_000_000n
const CONTENT = 'Deploy finished for the relay service, health checks are green and the new replica has taken traffic. '.repeat(2)

const hub = createHub(bufferSize)
let seq = 0

/** A typical text message, about 400 bytes as an SSE event. The ID's last 10 digits are its sequence number. */
function nextMsg(): Msg {
  seq++
  return {
    id: String(ID_BASE + BigInt(seq)),
    channelId: CHANNEL,
    author: { id: '1290000000000000042', name: 'load-producer', avatarUrl: null, bot: true },
    content: CONTENT,
    createdAt: new Date().toISOString(),
    editedAt: null,
    attachments: [],
  }
}

for (let i = 0; i < bufferSize; i++) hub.publish(nextMsg())

// One generator IP gets at most about 16k (macOS) or 28k (Linux) connections per destination port.
// Extra listeners at PORT + 2 onwards, sharing the one hub and event loop, lift that limit.
const listeners = Number(process.env.LISTENERS ?? 1)
for (let i = 0; i < listeners; i++) {
  startServer({
    port: i === 0 ? port : port + 1 + i,
    hub,
    channelIds: [CHANNEL],
    flags: () => DEFAULT_FLAGS,
    isDiscordConnected: () => true,
    channels: () => [{ id: CHANNEL, name: 'load-test' }],
  })
}

// Everything below resets when /stats reads it, so each sample covers one window.
let publishes = 0
let publishMsTotal = 0
let publishMsMax = 0
let lagMsMax = 0
let rssMaxBytes = 0
let lastCpu = process.cpuUsage()
let lastAt = performance.now()

let publisher: ReturnType<typeof setInterval> | undefined
function setRate(perSec: number): void {
  clearInterval(publisher)
  if (perSec <= 0) return
  publisher = setInterval(() => {
    const start = performance.now()
    hub.publish(nextMsg())
    const ms = performance.now() - start
    publishes++
    publishMsTotal += ms
    publishMsMax = Math.max(publishMsMax, ms)
  }, 1000 / perSec)
}

// Event-loop lag: how late a 50 ms timer fires. A busy loop delays every client's messages.
let expected = performance.now() + 50
setInterval(() => {
  const now = performance.now()
  lagMsMax = Math.max(lagMsMax, now - expected)
  expected = now + 50
  rssMaxBytes = Math.max(rssMaxBytes, process.memoryUsage.rss())
}, 50)

function stats(): Response {
  const now = performance.now()
  const cpu = process.cpuUsage(lastCpu)
  const body = {
    now: Date.now(),
    seq,
    clients: hub.subscriberCount(),
    /** Percent of one core since the last read; may pass 100 on several cores. */
    cpuPct: ((cpu.user + cpu.system) / 1000 / (now - lastAt)) * 100,
    rssMb: process.memoryUsage.rss() / 2 ** 20,
    rssMaxMb: rssMaxBytes / 2 ** 20,
    lagMsMax,
    publishes,
    publishMsAvg: publishes ? publishMsTotal / publishes : 0,
    publishMsMax,
  }
  lastCpu = process.cpuUsage()
  lastAt = now
  publishes = publishMsTotal = publishMsMax = lagMsMax = rssMaxBytes = 0
  return Response.json(body)
}

Bun.serve({
  port: port + 1,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/stats') return stats()
    if (url.pathname === '/rate' && req.method === 'POST') {
      setRate(Number(url.searchParams.get('perSec')))
      return new Response('ok')
    }
    return new Response('Not found', { status: 404 })
  },
})

console.log(JSON.stringify({ event: 'load_server_started', port, listeners, controlPort: port + 1, pid: process.pid }))
