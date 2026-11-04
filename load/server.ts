/**
 * The real hub and HTTP server with a simulated producer instead of Discord, plus a control port
 * (PORT + 1) for the load runner: GET /stats, POST /rate?perSec=n.
 */
import { DEFAULT_FLAGS } from '../backend/flags.ts'
import { createHub } from '../backend/hub.ts'
import { startServer } from '../backend/server.ts'
import { createLoadControl } from './producer.ts'

const port = Number(process.env.PORT ?? 3100)
const bufferSize = Number(process.env.BUFFER_SIZE ?? 100)
const CHANNEL = '1301000000000000001'

const hub = createHub(bufferSize)

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

const control = createLoadControl(hub, CHANNEL, bufferSize)

Bun.serve({
  port: port + 1,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/stats') return control.stats()
    if (url.pathname === '/rate' && req.method === 'POST') {
      control.setRate(Number(url.searchParams.get('perSec')), Number(url.searchParams.get('msgBytes')))
      return new Response('ok')
    }
    return new Response('Not found', { status: 404 })
  },
})

console.log(JSON.stringify({ event: 'load_server_started', port, listeners, controlPort: port + 1, pid: process.pid }))
