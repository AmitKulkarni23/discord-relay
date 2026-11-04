/**
 * Runs on each consumer machine and lets load/run.ts on another machine drive its processes, so one
 * runner can coordinate them all: every machine moves through the steps together, the results add up,
 * and only the runner reads the server's stats, which reset when read.
 *
 *   PORT=4000 bun load/agent.ts
 *
 * Holds no state between runs: each run starts by replacing the processes, which closes their connections.
 */
import { clockOffset, spawnProcess, type ConsumerProcess } from './consumer-process.ts'

let processes: ConsumerProcess[] = []

function stopAll(): void {
  for (const p of processes) p.kill()
  processes = []
}

function processAt(url: URL): ConsumerProcess | undefined {
  return processes[Number(url.searchParams.get('i'))]
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4000),
  // /next waits for a process to reply, which can take as long as a whole step.
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/start') {
      stopAll()
      processes = Array.from({ length: Number(url.searchParams.get('count')) }, spawnProcess)
      return new Response('ok')
    }
    if (url.pathname === '/stop') {
      stopAll()
      return new Response('ok')
    }
    if (url.pathname === '/offset') return Response.json({ offsetMs: await clockOffset(url.searchParams.get('control') ?? '') })
    const target = processAt(url)
    if (!target) return new Response('No such process', { status: 404 })
    if (url.pathname === '/command') {
      target.command((await req.json()) as Parameters<ConsumerProcess['command']>[0])
      return new Response('ok')
    }
    if (url.pathname === '/next') return Response.json(await target.next())
    return new Response('Not found', { status: 404 })
  },
})

console.log(JSON.stringify({ event: 'agent_started', port: server.port, pid: process.pid }))
