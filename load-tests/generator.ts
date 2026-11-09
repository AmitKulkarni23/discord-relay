/**
 * Sends simulated messages to a server's control port, on its own clock and from its own service, so a
 * busy server cannot slow the test down without it showing. Each message is timestamped when it is due,
 * so time spent waiting for the server counts as delivery time. Driven by load-tests/run.ts --generator.
 *
 *   PORT=4100 bun load-tests/generator.ts
 */
import type { Msg } from '../backend/core/types.ts'
import { loadContent, makeLoadMsg } from './producer.ts'

const bufferSize = Number(process.env.BUFFER_SIZE ?? 100)
const SEND_TIMEOUT_MS = 30_000

// Starts from the time, so a restarted generator's IDs stay above those a server still holds.
let seq = Math.floor(Date.now() / 1000)
let target = ''
let channelIds: string[] = []
let content = loadContent(0)
let publisher: ReturnType<typeof setInterval> | undefined
let queue: Msg[] = []
let sending = false

// Everything below resets when /stats reads it, so each sample covers one window.
let failed = 0
let sendMsMax = 0
let lagMsMax = 0

/** One request at a time keeps messages in order. Whatever comes due meanwhile goes in the next request. */
async function flush(): Promise<void> {
  if (sending || queue.length === 0) return
  sending = true
  const batch = queue
  queue = []
  const start = performance.now()
  try {
    const res = await fetch(`${target}/publish`, { method: 'POST', body: JSON.stringify(batch), signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
    if (!res.ok) failed += batch.length
  } catch {
    failed += batch.length
  }
  sendMsMax = Math.max(sendMsMax, performance.now() - start)
  sending = false
  void flush()
}

function enqueue(count: number): void {
  for (let i = 0; i < count; i++) {
    seq++
    for (const channelId of channelIds) queue.push(makeLoadMsg(seq, channelId, content))
  }
  void flush()
}

/** Starts sending, or stops at perSec=0. Works out what is owed from the elapsed time, so a late timer catches up. */
function setRate(query: URLSearchParams): void {
  clearInterval(publisher)
  const perSec = Number(query.get('perSec'))
  if (perSec <= 0) return
  target = query.get('target') ?? ''
  channelIds = (query.get('channels') ?? '').split(',')
  content = loadContent(Number(query.get('msgBytes')))
  // Fills the server's buffer, so a new client's replay is full size.
  enqueue(bufferSize)
  const burst = Number(query.get('burst'))
  if (burst) {
    publisher = setInterval(() => enqueue(burst), Number(query.get('everySec')) * 1000)
    return
  }
  const startedAt = performance.now()
  let sent = 0
  publisher = setInterval(
    () => {
      const owed = Math.floor(((performance.now() - startedAt) / 1000) * perSec) - sent
      sent += owed
      enqueue(owed)
    },
    Math.min(1000 / perSec, 50),
  )
}

let expected = performance.now() + 50
setInterval(() => {
  const now = performance.now()
  lagMsMax = Math.max(lagMsMax, now - expected)
  expected = now + 50
}, 50)

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4100),
  hostname: '::',
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/clock') return Response.json({ now: Date.now() })
    if (url.pathname === '/rate' && req.method === 'POST') {
      setRate(url.searchParams)
      return new Response('ok')
    }
    if (url.pathname === '/stats') {
      const body = { seq, failed, lagMsMax, sendMsMax }
      failed = lagMsMax = sendMsMax = 0
      return Response.json(body)
    }
    return new Response('Not found', { status: 404 })
  },
})

console.log(JSON.stringify({ event: 'generator_started', port: server.port, pid: process.pid }))
