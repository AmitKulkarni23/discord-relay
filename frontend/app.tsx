import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import AppBar from '@mui/material/AppBar'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CssBaseline from '@mui/material/CssBaseline'
import Divider from '@mui/material/Divider'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import SvgIcon from '@mui/material/SvgIcon'
import Toolbar from '@mui/material/Toolbar'
import Typography from '@mui/material/Typography'
import { alpha, keyframes, ThemeProvider } from '@mui/material/styles'
import type { ChannelInfo, Msg } from '../backend/types.ts'
// ponytail: Bun's HTML bundler does not code-split, so this ships in the main bundle even with
// the `attachments` flag off (a few KB). It only renders when the flag is on; split with Bun.build if it grows.
import Attachments from './attachments.tsx'
import { addMsg, buildRows, compareIds, parseConfig, parseMsg, sortMsgs } from './feed.ts'
import { isDiscordCdn } from './media.ts'
import { theme } from './theme.ts'

/** The browser's view of the /events stream. */
type Status = 'connecting' | 'live' | 'reconnecting'

/** A message younger than this when its row mounts gets the arrival tint. */
const FRESH_MS = 15_000
/** How close to the bottom (px) still counts as reading the newest message. */
const BOTTOM_SLACK = 80
/** Longest wait between manual reconnects after the browser gives up on a stream. */
const MAX_RETRY_MS = 30_000

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

const arrive = keyframes`
  from { background-color: var(--arrive-tint); }
  to { background-color: transparent; }
`

/** "Today", "Yesterday", or the weekday and date. */
function dayLabel(date: Date): string {
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return dayFmt.format(date)
}

/** True when the window is scrolled to (or near) the bottom of the page. */
function isAtBottom(): boolean {
  const el = document.documentElement
  return el.scrollHeight - (window.scrollY + window.innerHeight) <= BOTTOM_SLACK
}

/** `# name`, or the bare ID while the bot has not loaded the channel yet. */
function channelLabel(c: ChannelInfo): string {
  return `# ${c.name ?? c.id}`
}

const STATUS_LABEL: Record<Status, string> = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting' }

/** The connection chip: green when the stream is open, amber while it retries. */
function StatusChip({ status }: { status: Status }): ReactElement {
  const dot = status === 'live' ? 'success.main' : status === 'reconnecting' ? 'warning.main' : 'text.secondary'
  return (
    <Box role="status" aria-live="polite">
      <Chip
        size="small"
        variant="outlined"
        label={STATUS_LABEL[status]}
        icon={<Box component="span" sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: dot }} />}
        sx={{ borderColor: 'divider', color: 'text.primary', fontWeight: 500, height: 28, px: 0.25, '& .MuiChip-icon': { ml: 1.25, mr: -0.25 } }}
      />
    </Box>
  )
}

type TopBarProps = { channels: ChannelInfo[]; activeId: string | null; onSelect: (id: string) => void; status: Status }

/** Sticky top bar: product name, the channel (tabs when there are several), connection state. */
function TopBar({ channels, activeId, onSelect, status }: TopBarProps): ReactElement {
  const active = channels.find(c => c.id === activeId)
  return (
    <AppBar position="sticky" elevation={0} sx={{ bgcolor: 'background.default', borderBottom: 1, borderColor: 'divider', backgroundImage: 'none' }}>
      <Toolbar sx={{ minHeight: { xs: 56 }, px: { xs: 2, sm: 3 }, gap: 1.5 }}>
        <Typography component="h1" variant="subtitle2" sx={{ fontSize: 15, color: 'text.primary', flexShrink: 0 }}>
          DiscordRelay
        </Typography>
        <Divider orientation="vertical" flexItem sx={{ my: 2, display: channels.length > 1 || active ? { xs: 'none', sm: 'block' } : 'none' }} />
        {channels.length > 1 ? (
          <Tabs
            value={activeId ?? false}
            onChange={(_, id: string) => onSelect(id)}
            variant="scrollable"
            scrollButtons={false}
            aria-label="Channels"
            sx={{ minHeight: 56, flex: 1, minWidth: 0, '& .MuiTabs-indicator': { height: 2 } }}
          >
            {channels.map(c => (
              <Tab
                key={c.id}
                value={c.id}
                label={channelLabel(c)}
                disableRipple
                sx={{ minHeight: 56, minWidth: 0, px: 1.5, textTransform: 'none', fontSize: 14, fontWeight: 500, color: 'text.secondary', '&.Mui-selected': { color: 'text.primary' } }}
              />
            ))}
          </Tabs>
        ) : active ? (
          <Typography variant="body2" noWrap sx={{ color: 'text.secondary', display: { xs: 'none', sm: 'block' } }}>
            {channelLabel(active)}
          </Typography>
        ) : null}
        <Box sx={{ ml: 'auto' }}>
          <StatusChip status={status} />
        </Box>
      </Toolbar>
    </AppBar>
  )
}

/** A centred date line between messages from different days. */
function DayDivider({ date }: { date: Date }): ReactElement {
  return (
    <Divider sx={{ my: 2, '&::before, &::after': { borderColor: 'divider' } }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
        {dayLabel(date)}
      </Typography>
    </Divider>
  )
}

/** The text of a message, or an honest note when there is none to show. */
function MessageBody({ msg, attachmentsOn }: { msg: Msg; attachmentsOn: boolean }): ReactElement | null {
  const empty = msg.content === ''
  // With attachments rendered below, an attachment-only message needs no text line.
  if (empty && attachmentsOn && msg.attachments.length > 0 && !msg.editedAt) return null
  return (
    <Typography
      variant="body1"
      sx={{ m: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: empty ? 'text.secondary' : 'text.primary', fontStyle: empty ? 'italic' : 'normal' }}
    >
      {empty ? (msg.attachments.length > 0 ? 'Attachment' : 'Message text unavailable') : msg.content}
      {msg.editedAt ? (
        <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 0.75, fontStyle: 'normal' }}>
          (edited)
        </Typography>
      ) : null}
    </Typography>
  )
}

/**
 * One message. A `head` row starts an author group with avatar, name and
 * time; a continuation shows its time in the gutter on hover.
 */
const MessageRow = memo(function MessageRow({ msg, head, attachmentsOn }: { msg: Msg; head: boolean; attachmentsOn: boolean }): ReactElement {
  const [fresh] = useState(() => Date.now() - Date.parse(msg.createdAt) < FRESH_MS)
  const at = new Date(msg.createdAt)
  const time = (
    <time dateTime={msg.createdAt} title={fullFmt.format(at)}>
      {timeFmt.format(at)}
    </time>
  )

  return (
    <Box
      component="article"
      sx={{
        display: 'grid',
        gridTemplateColumns: '40px minmax(0, 1fr)',
        columnGap: 1.5,
        px: 1.5,
        pt: head ? 1.25 : 0.25,
        pb: 0.25,
        mt: head ? 0.75 : 0,
        borderRadius: 1,
        '--arrive-tint': (t) => alpha(t.palette.primary.main, 0.16),
        animation: fresh ? `${arrive} 1.2s cubic-bezier(0.16, 1, 0.3, 1)` : 'none',
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        '&:hover': { bgcolor: 'action.hover' },
        '&:hover .relay-gutter-time': { opacity: 1 },
      }}
    >
      {head ? (
        <Avatar
          src={isDiscordCdn(msg.author.avatarUrl) ? msg.author.avatarUrl : undefined}
          alt=""
          aria-hidden
          slotProps={{ img: { loading: 'lazy' } }}
          sx={{ width: 40, height: 40, mt: 0.25, bgcolor: 'divider', color: 'text.secondary', fontSize: 16 }}
        >
          {msg.author.name.slice(0, 1).toUpperCase()}
        </Avatar>
      ) : (
        <Typography
          variant="caption"
          className="relay-gutter-time"
          sx={{ color: 'text.secondary', textAlign: 'right', pt: '3px', opacity: 0, transition: 'opacity 120ms', fontSize: 11 }}
        >
          {time}
        </Typography>
      )}
      <Box sx={{ minWidth: 0 }}>
        {head ? (
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0 }}>
            <Typography component="h2" variant="subtitle2" noWrap sx={{ color: 'text.primary' }}>
              {msg.author.name}
            </Typography>
            {msg.author.bot ? (
              <Chip label="BOT" size="small" variant="outlined" sx={{ height: 18, fontSize: 11, fontWeight: 600, borderRadius: 1, borderColor: 'divider', alignSelf: 'center', '& .MuiChip-label': { px: 0.75 } }} />
            ) : null}
            <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
              {time}
            </Typography>
          </Box>
        ) : null}
        <MessageBody msg={msg} attachmentsOn={attachmentsOn} />
        {attachmentsOn && msg.attachments.length > 0 ? (
          <Attachments items={msg.attachments} />
        ) : null}
      </Box>
    </Box>
  )
})

/** Shown in place of the feed before any message has arrived. */
function EmptyState({ status, channelName }: { status: Status; channelName: string | null }): ReactElement {
  const where = channelName ? `#${channelName}` : 'the channel'
  const [title, body] =
    status === 'live'
      ? ['No messages yet', `Post in ${where} and it shows up here, live.`]
      : [status === 'connecting' ? 'Connecting to the relay' : 'Reconnecting to the relay', 'Messages appear as soon as the stream opens.']
  return (
    <Box sx={{ m: 'auto', textAlign: 'center', py: 8, px: 2 }}>
      <Typography variant="subtitle2" component="p" sx={{ fontSize: 15, color: 'text.primary', mb: 0.5 }}>
        {title}
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {body}
      </Typography>
    </Box>
  )
}

/** Floating button that appears when messages land below where the reader is. */
function NewMessagesPill({ count, onClick }: { count: number; onClick: () => void }): ReactElement {
  return (
    <Button
      variant="contained"
      size="small"
      onClick={onClick}
      startIcon={
        <SvgIcon fontSize="small" viewBox="0 0 24 24">
          <path d="M12 4v14m0 0-6-6m6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </SvgIcon>
      }
      sx={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        borderRadius: 999,
        px: 2,
        textTransform: 'none',
        fontWeight: 600,
        boxShadow: (t) => `0 6px 20px ${alpha(t.palette.common.black, 0.45)}`,
      }}
    >
      {count} new message{count === 1 ? '' : 's'}
    </Button>
  )
}

/** The page: one EventSource, up to 500 messages keyed by ID, newest at the bottom. */
function App(): ReactElement {
  const [msgs, setMsgs] = useState<Map<string, Msg>>(() => new Map())
  const [status, setStatus] = useState<Status>('connecting')
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [attachmentsOn, setAttachmentsOn] = useState(false)
  /** The channel picked in the URL or the tabs; null means the server's default. */
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get('channel'))
  /** Newest message ID the reader has seen at the bottom of the page. */
  const [seenId, setSeenId] = useState<string | null>(null)
  const atBottom = useRef(true)

  const sorted = useMemo(() => sortMsgs(msgs), [msgs])
  const rows = useMemo(() => buildRows(sorted), [sorted])
  const newestId = sorted.at(-1)?.id ?? null
  const newestRef = useRef(newestId)
  newestRef.current = newestId
  const unseen = seenId === null ? 0 : sorted.filter(m => compareIds(m.id, seenId) > 0).length

  // Until /config answers, trust the URL; after, an unknown ID falls back to the default channel.
  const streamChannel = channels.length === 0 || channels.some(c => c.id === selected) ? selected : null
  const activeId = streamChannel ?? channels[0]?.id ?? null
  const active = channels.find(c => c.id === activeId)
  const channelName = active ? (active.name ?? active.id) : null

  // One stream per selected channel: switching closes the old stream and starts a fresh list.
  useEffect(() => {
    setMsgs(new Map())
    setStatus('connecting')
    setSeenId(null)
    atBottom.current = true
    const src = streamChannel ? `/events?channel=${encodeURIComponent(streamChannel)}` : '/events'
    let es: EventSource | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let delay = 1000
    let stopped = false

    // EventSource retries on its own after a dropped stream, but gives up for
    // good on an HTTP error (e.g. a 502 mid-deploy); then we reconnect ourselves.
    const connect = (): void => {
      es = new EventSource(src)
      es.onopen = () => {
        delay = 1000
        setStatus('live')
      }
      es.onmessage = e => {
        const m = parseMsg(String(e.data))
        if (m) setMsgs(prev => addMsg(prev, m))
      }
      es.onerror = () => {
        setStatus('reconnecting')
        if (es?.readyState === EventSource.CLOSED && !stopped) {
          retry = setTimeout(connect, delay)
          delay = Math.min(delay * 2, MAX_RETRY_MS)
        }
      }
    }

    connect()
    return () => {
      stopped = true
      clearTimeout(retry)
      es?.close()
    }
  }, [streamChannel])

  useEffect(() => {
    fetch('/config')
      .then(res => res.json())
      .then((v: unknown) => {
        const config = parseConfig(v)
        setChannels(config.channels)
        setAttachmentsOn(config.attachments)
      })
      .catch(() => setChannels([]))
  }, [])

  const selectChannel = (id: string): void => {
    if (id === activeId) return
    setSelected(id)
    const url = new URL(window.location.href)
    url.searchParams.set('channel', id)
    window.history.replaceState(null, '', url)
  }

  useEffect(() => {
    document.title = channelName ? `#${channelName} · DiscordRelay` : 'DiscordRelay'
  }, [channelName])

  useEffect(() => {
    const onScroll = (): void => {
      atBottom.current = isAtBottom()
      if (atBottom.current) setSeenId(newestRef.current)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  // Keep a reader who is at the bottom pinned there as messages land.
  useLayoutEffect(() => {
    if (!atBottom.current) return
    window.scrollTo({ top: document.documentElement.scrollHeight })
    setSeenId(newestId)
  }, [newestId])

  const jumpToNewest = (): void => {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <TopBar channels={channels} activeId={activeId} onSelect={selectChannel} status={status} />
      <Box
        component="main"
        sx={{ maxWidth: 792, mx: 'auto', px: { xs: 1, sm: 2 }, pt: 1, pb: 10, minHeight: 'calc(100dvh - 57px)', display: 'flex', flexDirection: 'column' }}
      >
        {rows.length === 0 ? (
          <EmptyState status={status} channelName={channelName} />
        ) : (
          <Box role="log" aria-label={channelName ? `Messages in #${channelName}` : 'Messages'} sx={{ mt: 'auto' }}>
            {rows.map(r => (r.kind === 'day' ? <DayDivider key={r.key} date={r.date} /> : <MessageRow key={r.key} msg={r.msg} head={r.head} attachmentsOn={attachmentsOn} />))}
          </Box>
        )}
      </Box>
      {unseen > 0 ? <NewMessagesPill count={unseen} onClick={jumpToNewest} /> : null}
    </ThemeProvider>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing #root')
createRoot(root).render(<App />)
