import type { Attachment, Msg } from '../../backend/core/types.ts'

/** A realistic message; override what a test cares about. */
export function makeMsg(overrides: Partial<Msg> = {}): Msg {
  return {
    id: '1566588496691400001',
    channelId: '1566584977829900002',
    author: { id: '961675715634400003', name: 'relay_tester', avatarUrl: null, bot: false },
    content: 'deploy finished for build 482',
    note: null,
    createdAt: '2026-11-01T23:03:23.418Z',
    editedAt: null,
    attachments: [],
    ...overrides,
  }
}

/** A realistic attachment; override what a test cares about. */
export function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    url: 'https://cdn.discordapp.com/attachments/1/2/build-log.png',
    name: 'build-log.png',
    contentType: 'image/png',
    size: 2048,
    width: 640,
    height: 480,
    ...overrides,
  }
}

/** Stands in for the browser's EventSource and records every stream the code under test opens. */
export class FakeEventSource {
  static opened: FakeEventSource[] = []
  static latest(): FakeEventSource {
    const es = FakeEventSource.opened.at(-1)
    if (!es) throw new Error('no EventSource was opened')
    return es
  }

  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  private listeners = new Map<string, (e: { data: unknown }) => void>()

  constructor(readonly url: string) {
    FakeEventSource.opened.push(this)
  }
  addEventListener(type: string, listener: (e: { data: unknown }) => void): void {
    this.listeners.set(type, listener)
  }
  close(): void {
    this.closed = true
  }
  sendMessage(m: Msg): void {
    this.onmessage?.({ data: JSON.stringify(m) })
  }
  sendRaw(data: string): void {
    this.onmessage?.({ data })
  }
  sendPing(): void {
    this.listeners.get('ping')?.({ data: '1' })
  }
  sendDelete(id: string): void {
    this.listeners.get('delete')?.({ data: JSON.stringify({ id, channelId: '1566584977829900002' }) })
  }
  sendDiscord(state: 'connected' | 'disconnected' | 'unavailable' | 'failed'): void {
    this.listeners.get('discord')?.({ data: state })
  }
}
