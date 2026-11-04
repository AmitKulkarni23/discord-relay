import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import AppBar from '@mui/material/AppBar'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import ButtonBase from '@mui/material/ButtonBase'
import Chip from '@mui/material/Chip'
import CssBaseline from '@mui/material/CssBaseline'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import Link from '@mui/material/Link'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import SvgIcon from '@mui/material/SvgIcon'
import Toolbar from '@mui/material/Toolbar'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { alpha, keyframes, ThemeProvider, useColorScheme } from '@mui/material/styles'
import type { ChannelInfo, Msg } from '../backend/types.ts'
// Bun's HTML bundler does not code-split, so this ships in the main bundle even with
// the `attachments` flag off (a few KB). It only renders when the flag is on; split with Bun.build if it grows.
import Attachments from './attachments.tsx'
import { addMsg, buildRows, compareIds, eventsUrl, fetchConfig, parseMarkup, parseMsg, retryDelay, sortMsgs, type Part } from './feed.ts'
import { isDiscordCdn } from './media.ts'
import { GROUND, theme } from './theme.ts'

/** The browser's view of the /events stream and, once it is open, of the bot's Discord connection. */
type Status = 'connecting' | 'live' | 'reconnecting' | 'discord'

/** A message younger than this when its row mounts gets the arrival tint. */
const FRESH_MS = 15_000
/** How close to the bottom (px) still counts as reading the newest message. */
const BOTTOM_SLACK = 80
/** How long a stream must stay open before reconnect backoff starts over. */
const STABLE_MS = 30_000
/** A message taller than this many lines, wrapping included, collapses behind Show more. */
const COLLAPSE_LINES = 15

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

/** How each kind of Discord formatting looks. */
const FORMAT = {
  bold: { fontWeight: 700 },
  italic: { fontStyle: 'italic' },
  underline: { textDecoration: 'underline' },
  strike: { textDecoration: 'line-through' },
}

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

/** Scrolls to the newest message. */
function pinToBottom(): void {
  window.scrollTo({ top: document.documentElement.scrollHeight })
}

/** `# name`, or the bare ID while the bot has not loaded the channel yet. */
function channelLabel(c: ChannelInfo): string {
  return `# ${c.name ?? c.id}`
}

const STATUS_LABEL: Record<Status, string> = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', discord: 'Waiting for Discord' }

/** The connection chip: green only when messages can really flow; amber while the stream retries or the bot has lost Discord. */
function StatusChip({ status }: { status: Status }): ReactElement {
  const dot = status === 'live' ? 'success.main' : status === 'connecting' ? 'text.secondary' : 'warning.main'
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

/** Switches between light and dark. Follows the OS until the reader picks; MUI stores the pick and syncs other tabs. */
function ThemeToggle(): ReactElement {
  const { mode, systemMode, setMode } = useColorScheme()
  const current = (mode === 'system' ? systemMode : mode) ?? 'dark'
  const next = current === 'dark' ? 'light' : 'dark'
  const label = `Switch to ${next} mode`

  // The browser's own toolbar colour on mobile.
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', GROUND[current])
  }, [current])

  return (
    <Tooltip title={label}>
      <IconButton
        aria-label={label}
        onClick={() => setMode(next)}
        sx={{ width: 36, height: 36, color: 'text.secondary', '&:hover': { color: 'text.primary' } }}
      >
        <SvgIcon sx={{ fontSize: 20 }} viewBox="0 0 24 24">
          <g fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {next === 'light' ? (
              <>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </>
            ) : (
              <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
            )}
          </g>
        </SvgIcon>
      </IconButton>
    </Tooltip>
  )
}

type TopBarProps = { channels: ChannelInfo[]; activeId: string | null; onSelect: (id: string) => void; status: Status }

/** Sticky top bar: product name, the channel (tabs when there are several), connection state, theme. */
function TopBar({ channels, activeId, onSelect, status }: TopBarProps): ReactElement {
  const active = channels.find(c => c.id === activeId)
  return (
    <AppBar position="sticky" elevation={0} sx={{ bgcolor: 'background.default', borderBottom: 1, borderColor: 'divider', backgroundImage: 'none' }}>
      <Toolbar sx={{ minHeight: { xs: 56 }, px: { xs: 2, sm: 3 }, gap: 1.5 }}>
        <Typography component="h1" variant="subtitle2" sx={{ fontSize: 15, color: 'text.primary', flexShrink: 0 }}>
          DiscordRelay
        </Typography>
        <Divider orientation="vertical" flexItem sx={{ my: 2, display: channels.length > 1 ? { xs: 'none', sm: 'block' } : active ? 'block' : 'none' }} />
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
                sx={{
                  minHeight: 56,
                  minWidth: 0,
                  px: 1.5,
                  textTransform: 'none',
                  fontSize: 14,
                  fontWeight: 500,
                  color: 'text.secondary',
                  '&.Mui-selected': { color: 'text.primary' },
                }}
              />
            ))}
          </Tabs>
        ) : active ? (
          <Typography variant="body2" noWrap sx={{ color: 'text.secondary' }}>
            {channelLabel(active)}
          </Typography>
        ) : null}
        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
          <StatusChip status={status} />
          <ThemeToggle />
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

/** Spoiler text: hidden from sight and screen readers until the reader clicks it. */
function TextSpoiler({ parts }: { parts: Part[] }): ReactElement {
  const [shown, setShown] = useState(false)
  if (shown) {
    return (
      <Box component="span" sx={{ bgcolor: 'action.selected', borderRadius: 0.5, px: 0.25 }}>
        <MessageParts parts={parts} />
      </Box>
    )
  }
  return (
    <ButtonBase
      component="span"
      disableRipple
      aria-label="Spoiler: show"
      onClick={() => setShown(true)}
      sx={{ display: 'inline', font: 'inherit', bgcolor: 'text.secondary', borderRadius: 0.5, px: 0.25, verticalAlign: 'baseline' }}
    >
      <Box component="span" aria-hidden sx={{ visibility: 'hidden' }}>
        <MessageParts parts={parts} />
      </Box>
    </ButtonBase>
  )
}

/** Parsed message text as React nodes, never as HTML. */
function MessageParts({ parts }: { parts: Part[] }): ReactElement {
  return (
    <>
      {parts.map((part, i) => {
        switch (part.kind) {
          case 'text':
            return part.text
          case 'link':
            return (
              <Link key={i} href={part.href} target="_blank" rel="noopener noreferrer" color="inherit" underline="always">
                {part.href}
              </Link>
            )
          case 'code':
            return (
              <Box key={i} component="code" sx={{ fontFamily: 'monospace', fontSize: '0.9em', bgcolor: 'action.selected', borderRadius: 0.5, px: 0.5 }}>
                {part.text}
              </Box>
            )
          case 'block':
            return (
              <Box
                key={i}
                component="pre"
                sx={{ fontFamily: 'monospace', fontSize: '0.9em', m: 0, my: 0.5, p: 1, overflowX: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}
              >
                {part.text}
              </Box>
            )
          case 'time': {
            const at = new Date(part.iso)
            return (
              <time key={i} dateTime={part.iso} title={fullFmt.format(at)}>
                {fullFmt.format(at)}
              </time>
            )
          }
          case 'spoiler':
            return <TextSpoiler key={i} parts={part.parts} />
          default:
            return (
              <Box key={i} component="span" sx={FORMAT[part.kind]}>
                <MessageParts parts={part.parts} />
              </Box>
            )
        }
      })}
    </>
  )
}

type MessageBodyProps = { msg: Msg; attachmentsOn: boolean; atBottom: RefObject<boolean> }

/**
 * The text of a message, or an honest note when there is none to show. Text past COLLAPSE_LINES is
 * clipped behind Show more; it is measured, not counted, because long lines wrap differently per screen.
 */
function MessageBody({ msg, attachmentsOn, atBottom }: MessageBodyProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const [clipped, setClipped] = useState(false)
  const text = useRef<HTMLDivElement>(null)

  // A resize can clip a message that fitted, so keep measuring while it is collapsed.
  useLayoutEffect(() => {
    const el = text.current
    if (!el || expanded) return
    const measure = (): void => setClipped(el.scrollHeight - el.clientHeight > 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [expanded, msg.content])

  // The button appears after App has pinned the page, so pin again or the button lands below the fold.
  useLayoutEffect(() => {
    if (clipped && atBottom.current) pinToBottom()
  }, [clipped, atBottom])

  const toggle = (): void => {
    flushSync(() => setExpanded(v => !v))
    // Collapsing can leave the reader far below the message, so bring it back into view.
    if (expanded) text.current?.closest('article')?.scrollIntoView({ block: 'nearest' })
    // The page changed height without a scroll event, and a reader mid-message must not be pinned by the next one.
    atBottom.current = isAtBottom()
  }

  const empty = msg.content === ''
  // With attachments rendered below, an attachment-only message needs no text line.
  if (empty && attachmentsOn && msg.attachments.length > 0 && !msg.editedAt) return null
  return (
    <>
      <Typography
        ref={text}
        component="div"
        variant="body1"
        sx={{
          m: 0,
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          color: empty ? 'text.secondary' : 'text.primary',
          fontStyle: empty ? 'italic' : 'normal',
          ...(expanded ? {} : { maxHeight: `${COLLAPSE_LINES}lh`, overflow: 'hidden' }),
          ...(clipped && !expanded ? { maskImage: 'linear-gradient(to bottom, black calc(100% - 2lh), transparent)' } : {}),
        }}
      >
        {empty ? msg.attachments.length > 0 ? 'Attachment' : 'Message text unavailable' : <MessageParts parts={parseMarkup(msg.content)} />}
        {msg.editedAt ? (
          <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 0.75, fontStyle: 'normal' }}>
            (edited)
          </Typography>
        ) : null}
      </Typography>
      {clipped || expanded ? (
        <Button
          size="small"
          aria-expanded={expanded}
          onClick={toggle}
          sx={{
            display: 'block',
            mt: 0.25,
            ml: -0.75,
            px: 0.75,
            minWidth: 0,
            textTransform: 'none',
            fontWeight: 600,
            color: 'text.secondary',
            '&:hover': { color: 'text.primary' },
          }}
        >
          {expanded ? 'Show less' : 'Show more'}
        </Button>
      ) : null}
    </>
  )
}

/**
 * One message. A `head` row starts an author group with avatar, name and
 * time; a continuation shows its time in the gutter on hover.
 */
const MessageRow = memo(function MessageRow({ msg, head, attachmentsOn, atBottom }: MessageBodyProps & { head: boolean }): ReactElement {
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
        scrollMarginTop: 64,
        '--arrive-tint': 'rgba(var(--mui-palette-primary-mainChannel) / 0.16)',
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
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            whiteSpace: 'nowrap',
            color: 'text.secondary',
            pt: '3px',
            opacity: 0,
            transition: 'opacity 120ms',
            fontSize: 11,
            // Touch screens have no hover, so a grouped message would never show its time.
            '@media (hover: none)': { opacity: 1, fontSize: 10 },
          }}
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
              <Chip
                label="BOT"
                size="small"
                variant="outlined"
                sx={{
                  height: 18,
                  fontSize: 11,
                  fontWeight: 600,
                  borderRadius: 1,
                  borderColor: 'divider',
                  alignSelf: 'center',
                  '& .MuiChip-label': { px: 0.75 },
                }}
              />
            ) : null}
            <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
              {time}
            </Typography>
          </Box>
        ) : null}
        <MessageBody msg={msg} attachmentsOn={attachmentsOn} atBottom={atBottom} />
        {attachmentsOn && msg.attachments.length > 0 ? <Attachments items={msg.attachments} /> : null}
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
      : status === 'discord'
        ? ['Waiting for Discord', 'The relay is reconnecting to Discord. Messages appear as soon as it is back.']
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
      sx={[
        {
          position: 'fixed',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          borderRadius: 999,
          px: 2,
          textTransform: 'none',
          fontWeight: 600,
        },
        t => ({ boxShadow: `0 6px 20px ${alpha(t.palette.common.black, 0.45)}` }),
        t => t.applyStyles('light', { boxShadow: `0 6px 20px ${alpha(t.palette.common.black, 0.18)}` }),
      ]}
    >
      {count} new message{count === 1 ? '' : 's'}
    </Button>
  )
}

/** The page: one EventSource, up to 500 messages keyed by ID, newest at the bottom. */
function App(): ReactElement {
  const [msgs, setMsgs] = useState<Map<string, Msg>>(() => new Map())
  const [stream, setStream] = useState<Status>('connecting')
  /** What the server last said about Discord; only meaningful while the stream is open. */
  const [discordUp, setDiscordUp] = useState(true)
  const [channels, setChannels] = useState<ChannelInfo[]>([])
  const [attachmentsOn, setAttachmentsOn] = useState(false)
  /** The channel picked in the URL or the tabs; null means the server's default. */
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(window.location.search).get('channel'))
  /** Newest message ID the reader has seen at the bottom of the page. */
  const [seenId, setSeenId] = useState<string | null>(null)
  const atBottom = useRef(true)

  const status: Status = stream === 'live' && !discordUp ? 'discord' : stream

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
    setStream('connecting')
    setSeenId(null)
    atBottom.current = true
    let es: EventSource | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let stable: ReturnType<typeof setTimeout> | undefined
    let attempt = 0
    let since: string | null = null

    // EventSource's own retry has a fixed delay and stops for good on an HTTP error (e.g. a 502
    // mid-deploy), so every error closes it and this loop reconnects with backoff and jitter.
    const connect = (): void => {
      es = new EventSource(eventsUrl(streamChannel, since))
      es.onopen = () => {
        setStream('live')
        // Not on open alone: a server that accepts and then dies must keep backing off.
        stable = setTimeout(() => {
          attempt = 0
        }, STABLE_MS)
      }
      es.addEventListener('discord', e => setDiscordUp(e.data !== 'disconnected'))
      es.onmessage = e => {
        const m = parseMsg(String(e.data))
        if (!m) return
        if (since === null || compareIds(m.id, since) > 0) since = m.id
        setMsgs(prev => addMsg(prev, m))
      }
      es.onerror = () => {
        es?.close()
        clearTimeout(stable)
        setStream('reconnecting')
        retry = setTimeout(connect, retryDelay(attempt++))
      }
    }

    connect()
    return () => {
      clearTimeout(retry)
      clearTimeout(stable)
      es?.close()
    }
  }, [streamChannel])

  useEffect(() => {
    const abort = new AbortController()
    void fetchConfig(abort.signal).then(config => {
      if (!config) return
      setChannels(config.channels)
      setAttachmentsOn(config.attachments)
    })
    return () => abort.abort()
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
    pinToBottom()
    setSeenId(newestId)
  }, [newestId])

  const jumpToNewest = (): void => {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  return (
    <ThemeProvider theme={theme} defaultMode="system" noSsr>
      <CssBaseline enableColorScheme />
      <TopBar channels={channels} activeId={activeId} onSelect={selectChannel} status={status} />
      <Box
        component="main"
        sx={{ maxWidth: 792, mx: 'auto', px: { xs: 1, sm: 2 }, pt: 1, pb: 10, minHeight: 'calc(100dvh - 57px)', display: 'flex', flexDirection: 'column' }}
      >
        {rows.length === 0 ? (
          <EmptyState status={status} channelName={channelName} />
        ) : (
          <Box role="log" aria-label={channelName ? `Messages in #${channelName}` : 'Messages'} sx={{ mt: 'auto' }}>
            {rows.map(r =>
              r.kind === 'day' ? (
                <DayDivider key={r.key} date={r.date} />
              ) : (
                <MessageRow key={r.key} msg={r.msg} head={r.head} attachmentsOn={attachmentsOn} atBottom={atBottom} />
              ),
            )}
          </Box>
        )}
      </Box>
      {unseen > 0 ? <NewMessagesPill count={unseen} onClick={jumpToNewest} /> : null}
    </ThemeProvider>
  )
}

// A page always lands on the newest message and follows it, even on reload: the browser restoring
// an old offset would leave the reader mid-history, and the stick-to-bottom logic would then hold them there.
window.history.scrollRestoration = 'manual'

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing #root')
createRoot(root).render(<App />)
