/**
 * A running copy of load-tests/consumer.ts, and the clock check every machine needs. Used by load-tests/run.ts
 * for processes on its own machine, and by load-tests/agent.ts for processes on another one.
 */
import type { ConsumerCommand, ConsumerReply } from './consumer.ts'

/** A process's replies arrive on one queue, in order. */
export type ConsumerProcess = { command: (command: ConsumerCommand) => void; next: () => Promise<ConsumerReply>; kill: () => void }

export function spawnProcess(): ConsumerProcess {
  const replies: ConsumerReply[] = []
  const waiting: Array<(reply: ConsumerReply) => void> = []
  const proc = Bun.spawn(['bun', 'load-tests/consumer.ts'], {
    stdout: 'inherit',
    stderr: 'inherit',
    ipc(message: ConsumerReply) {
      const resolve = waiting.shift()
      if (resolve) resolve(message)
      else replies.push(message)
    },
  })
  return {
    command: cmd => proc.send(cmd),
    next: () => {
      const queued = replies.shift()
      return queued ? Promise.resolve(queued) : new Promise(resolve => waiting.push(resolve))
    },
    kill: () => proc.kill(),
  }
}

/** The server's clock minus this machine's, so delivery times hold across machines. */
export async function clockOffset(control: string): Promise<number> {
  let best = { rtt: Number.POSITIVE_INFINITY, offset: 0 }
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now()
    const { now } = (await (await fetch(`${control}/clock`, { signal: AbortSignal.timeout(30_000) })).json()) as { now: number }
    const t1 = Date.now()
    if (t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: now - (t0 + t1) / 2 }
  }
  return best.offset
}
