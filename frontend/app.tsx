/**
 * The page's top-level component. Reads /config for the channel list and flags, picks the channel
 * (from the URL or the tabs), opens its stream, and hands messages and status to the top bar and the feed.
 */
import { useEffect, useState, type ReactElement } from 'react'
import { Feed } from './components/feed.tsx'
import { StatusChip, TopBar } from './components/top-bar.tsx'
import { useEventStream } from './hooks/use-event-stream.ts'
import { usePageConfig } from './hooks/use-page-config.ts'

/** The page: wires the channel picked in the URL or the tabs to its stream, its feed and the top bar. */
export default function App(): ReactElement {
  const { channels, attachments } = usePageConfig()
  /** The channel picked in the URL or the tabs; null means the server's default. */
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get('channel'))

  // Until /config answers, trust the URL; after, an unknown ID falls back to the default channel.
  const streamChannel = channels.length === 0 || channels.some(channel => channel.id === selected) ? selected : null
  const { messages, status, recovered } = useEventStream(streamChannel)

  const activeId = streamChannel ?? channels[0]?.id ?? null
  const active = channels.find(channel => channel.id === activeId)
  const channelName = active ? (active.name ?? active.id) : null

  useEffect(() => {
    document.title = channelName ? `#${channelName} · DiscordRelay` : 'DiscordRelay'
  }, [channelName])

  const selectChannel = (id: string): void => {
    if (id === activeId) return
    setSelected(id)
    const url = new URL(window.location.href)
    url.searchParams.set('channel', id)
    window.history.replaceState(null, '', url)
  }

  return (
    <>
      <TopBar channels={channels} activeId={activeId} onSelect={selectChannel}>
        <StatusChip status={status} newestId={messages.at(-1)?.id ?? null} recovered={recovered} />
      </TopBar>
      <Feed key={streamChannel} messages={messages} status={status} channelName={channelName} attachmentsOn={attachments} />
    </>
  )
}
