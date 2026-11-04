/**
 * Simulated message producer and resource stats for a load test. load/server.ts uses it, and a
 * test of the live service wires it into a temporary, uncommitted deploy (see README, Load test).
 */
import type { Hub } from '../backend/hub.ts'
import type { Msg } from '../backend/types.ts'

/** Above any real snowflake, so simulated messages sort last. The last 10 digits are the sequence number. */
const ID_BASE = 1_900_000_000n * 10_000_000_000n
/** The bytes of an SSE event that are not the message content. */
const EVENT_OVERHEAD = 308
const CONTENT = 'Simulated load test message from the DiscordRelay harness, not a real Discord message. '.repeat(2)

export type LoadControl = { stats: () => Response; setRate: (perSec: number, msgBytes: number, burst: number, everySec: number) => void }

export function createLoadControl(hub: Hub, channelIds: string[], bufferSize: number): LoadControl {
  let seq = 0
  let content = CONTENT

  /** By default a typical text message, about 470 bytes as an SSE event. */
  function makeMsg(channelId: string): Msg {
    return {
      id: String(ID_BASE + BigInt(seq)),
      channelId,
      author: { id: '1290000000000000042', name: 'load-producer', avatarUrl: null, bot: true },
      content,
      note: null,
      createdAt: new Date().toISOString(),
      editedAt: null,
      attachments: [],
    }
  }

  /** One message per channel under one sequence number, so a client's gap check works in any channel. */
  function publishToAll(): void {
    seq++
    for (const channelId of channelIds) hub.publish(makeMsg(channelId))
  }

  // Everything below resets when stats() reads it, so each sample covers one window.
  let publishes = 0
  let publishMsTotal = 0
  let publishMsMax = 0
  let lagMsMax = 0
  let rssMaxBytes = 0
  let lastCpu = process.cpuUsage()
  let lastAt = performance.now()

  // Event-loop lag: how late a 50 ms timer fires. A busy loop delays every client's messages.
  let expected = performance.now() + 50
  setInterval(() => {
    const now = performance.now()
    lagMsMax = Math.max(lagMsMax, now - expected)
    expected = now + 50
    rssMaxBytes = Math.max(rssMaxBytes, process.memoryUsage.rss())
  }, 50)

  let publisher: ReturnType<typeof setInterval> | undefined

  return {
    /**
     * Fills the buffer on first use, so a new client's replay is full size, then publishes at this rate.
     * With `burst`, publishes that many messages in one go every `everySec` instead, with silence between.
     */
    setRate(perSec, msgBytes, burst, everySec) {
      clearInterval(publisher)
      if (msgBytes > 0) content = 'x'.repeat(Math.max(0, msgBytes - EVENT_OVERHEAD))
      if (perSec <= 0) return
      if (seq === 0) for (let i = 0; i < bufferSize; i++) publishToAll()
      publisher = setInterval(
        () => {
          const start = performance.now()
          for (let i = 0; i < (burst || 1); i++) publishToAll()
          const ms = performance.now() - start
          publishes++
          publishMsTotal += ms
          publishMsMax = Math.max(publishMsMax, ms)
        },
        burst ? everySec * 1000 : 1000 / perSec,
      )
    },

    stats() {
      const now = performance.now()
      const cpu = process.cpuUsage(lastCpu)
      const body = {
        now: Date.now(),
        seq,
        channelIds,
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
    },
  }
}
