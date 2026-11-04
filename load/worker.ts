/**
 * One load generator process: holds raw TCP connections to /events and records, for every
 * message in the measured window, its delivery time and whether any were missed. Raw sockets
 * because Bun's fetch allows 256 concurrent requests by default. Driven over IPC by run.ts.
 */
type Conn = { tail: string; responded: boolean; live: boolean; last: number; inWindow: number; gaps: number; dups: number }
type Socket = Bun.Socket<Conn>

export type WorkerCommand =
  | { type: 'open'; host: string; ports: number[]; tls: boolean; channelIds: string[]; count: number; perSec: number; worker: number; first: number }
  | { type: 'window'; from: number; offsetMs: number }
  | { type: 'end'; to: number; graceMs: number }
  | { type: 'close' }

export type WorkerReply =
  | { type: 'opened'; ok: number; failed: number; statuses: Record<string, number> }
  | {
      type: 'report'
      live: number
      closed: number
      received: number
      gaps: number
      dups: number
      behind: number
      histMs: Record<string, number>
      lagMsMax: number
      cpuPct: number
      rxBytes: number
    }

const send = (reply: WorkerReply) => process.send?.(reply)

// Simulated messages only: on the live service the buffer can also hold real Discord history.
const EVENT = /id: 1900000000(\d{10})\ndata: [^\n]*?"createdAt":"([^"]+)"[^\n]*\n\n/g
/** HTTP chunk framing. A proxy may split an event across chunks, which would otherwise hide it from EVENT. */
const CHUNK_FRAMING = /\r\n[0-9a-f]+\r\n/g

const conns = new Set<Socket>()
let closed = 0
let statuses: Record<string, number> = {}
let awaitingResponse = 0
let failedOpen = 0
let opening = false

let from = Number.POSITIVE_INFINITY
let to = Number.POSITIVE_INFINITY
let offsetMs = 0
let hist = new Map<number, number>()
let rxBytes = 0
/** Date.parse once per message: every socket sees the same one or two messages in turn. */
let cachedSeq = -1
let cachedSentAt = 0

function maybeOpened(): void {
  if (opening || awaitingResponse > 0) return
  send({ type: 'opened', ok: conns.size, failed: failedOpen, statuses })
}

function responded(conn: Conn, status: string): void {
  conn.responded = true
  conn.live = status === '200'
  statuses[status] = (statuses[status] ?? 0) + 1
  awaitingResponse--
  maybeOpened()
}

function onData(s: Socket, buf: Buffer): void {
  const conn = s.data
  rxBytes += buf.length
  const text = conn.tail + buf.toString('latin1')
  if (!conn.responded) {
    if (!text.includes('\r\n')) {
      conn.tail = text
      return
    }
    responded(conn, text.slice(9, 12))
    if (!conn.live) {
      conn.tail = ''
      s.end()
      return
    }
  }

  const body = text.replace(CHUNK_FRAMING, '')
  const now = Date.now()
  let end = 0
  EVENT.lastIndex = 0
  for (let m = EVENT.exec(body); m; m = EVENT.exec(body)) {
    end = EVENT.lastIndex
    const seq = Number(m[1])
    if (conn.last && seq <= conn.last) conn.dups++
    else if (conn.last && seq !== conn.last + 1) conn.gaps += seq - conn.last - 1
    conn.last = Math.max(conn.last, seq)
    if (seq <= from || seq > to) continue
    conn.inWindow++
    if (seq !== cachedSeq) {
      cachedSeq = seq
      cachedSentAt = Date.parse(m[2] as string)
    }
    const ms = Math.max(0, now + offsetMs - cachedSentAt)
    hist.set(ms, (hist.get(ms) ?? 0) + 1)
  }
  // Keep a partial event for the next chunk. Pings between events stay here until the next match, which is harmless.
  conn.tail = end ? body.slice(end) : body
}

function onGone(s: Socket): void {
  if (!s.data.responded) {
    s.data.responded = true
    failedOpen++
    awaitingResponse--
  }
  if (conns.delete(s)) closed++
  maybeOpened()
}

async function open(cmd: Extract<WorkerCommand, { type: 'open' }>): Promise<void> {
  statuses = {}
  failedOpen = 0
  opening = true
  const pause = 1000 / cmd.perSec
  const started = performance.now()
  for (let i = 0; i < cmd.count; i++) {
    const n = cmd.first + i
    const request =
      `GET /events?channel=${cmd.channelIds[n % cmd.channelIds.length]} HTTP/1.1\r\nHost: ${cmd.host}\r\nAccept: text/event-stream\r\n` +
      // Unique per connection so the per-IP cap does not apply. Only works without Railway's proxy in the path, which sets this header itself.
      `X-Real-IP: 10.${cmd.worker}.${(n >> 8) & 255}.${n & 255}\r\nConnection: keep-alive\r\n\r\n`
    awaitingResponse++
    Bun.connect<Conn>({
      hostname: cmd.host,
      tls: cmd.tls,
      port: cmd.ports[n % cmd.ports.length] as number,
      data: { tail: '', responded: false, live: false, last: 0, inWindow: 0, gaps: 0, dups: 0 },
      socket: {
        open(s) {
          conns.add(s)
          s.write(request)
        },
        data: onData,
        close: onGone,
        error(_s, err) {
          console.error(JSON.stringify({ event: 'socket_error', error: err.message }))
        },
        connectError(s) {
          onGone(s)
        },
      },
    }).catch(() => {})
    const due = started + (i + 1) * pause
    const wait = due - performance.now()
    if (wait > 1) await Bun.sleep(wait)
  }
  opening = false
  maybeOpened()
}

let lagMsMax = 0
let expected = performance.now() + 50
setInterval(() => {
  const now = performance.now()
  lagMsMax = Math.max(lagMsMax, now - expected)
  expected = now + 50
}, 50)
let cpuFrom = process.cpuUsage()
let cpuAt = performance.now()

async function report(cmd: Extract<WorkerCommand, { type: 'end' }>): Promise<void> {
  to = cmd.to
  const deadline = performance.now() + cmd.graceMs
  const lagging = () => {
    let n = 0
    for (const s of conns) if (s.data.last < to) n++
    return n
  }
  while (lagging() > 0 && performance.now() < deadline) await Bun.sleep(100)

  let received = 0
  let gaps = 0
  let dups = 0
  for (const s of conns) {
    received += s.data.inWindow
    gaps += s.data.gaps
    dups += s.data.dups
    s.data.inWindow = s.data.gaps = s.data.dups = 0
  }
  const cpu = process.cpuUsage(cpuFrom)
  const cpuPct = ((cpu.user + cpu.system) / 1000 / (performance.now() - cpuAt)) * 100
  send({ type: 'report', live: conns.size, closed, received, gaps, dups, behind: lagging(), histMs: Object.fromEntries(hist), lagMsMax, cpuPct, rxBytes })
  closed = 0
  hist = new Map()
  from = to = Number.POSITIVE_INFINITY
  lagMsMax = 0
}

process.on('message', (cmd: WorkerCommand) => {
  if (cmd.type === 'open') void open(cmd)
  if (cmd.type === 'window') {
    from = cmd.from
    to = Number.POSITIVE_INFINITY
    offsetMs = cmd.offsetMs
    cpuFrom = process.cpuUsage()
    cpuAt = performance.now()
    lagMsMax = 0
    rxBytes = 0
  }
  if (cmd.type === 'end') void report(cmd)
  if (cmd.type === 'close') process.exit(0)
})

// Exit with the runner, so a crashed run leaves nothing behind.
process.on('disconnect', () => process.exit(0))
