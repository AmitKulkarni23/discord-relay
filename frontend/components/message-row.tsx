import { memo, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { flushSync } from 'react-dom'
import Avatar from '@mui/material/Avatar'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import Typography from '@mui/material/Typography'
import { keyframes } from '@mui/material/styles'
import type { Msg } from '../../backend/core/types.ts'
import type { FeedScroll } from '../hooks/use-stick-to-bottom.ts'
import { parseMarkup } from '../lib/markup.ts'
import { isDiscordCdn } from '../lib/media.ts'
import { BAR_HEIGHT, COARSE } from '../theme.ts'
// Bun's HTML bundler does not code-split, so this ships in the main bundle even with
// the `attachments` flag off (a few KB). It only renders when the flag is on; split with Bun.build if it grows.
import Attachments from './attachments.tsx'
import { MessageParts } from './message-text.tsx'

/** A message younger than this when its row mounts gets the arrival tint. */
const FRESH_MS = 15_000
/** A message taller than this many lines, wrapping included, collapses behind Show more. */
const COLLAPSE_LINES = 15

/** One observer for every row: a page can hold 500 messages. */
let rowObserver: ResizeObserver | undefined
const rowWatchers = new WeakMap<Element, () => void>()

/** Calls `onResize` when `el` changes size. Returns a function that stops watching. */
function watchSize(el: Element, onResize: () => void): () => void {
  rowObserver ??= new ResizeObserver(entries => {
    for (const entry of entries) rowWatchers.get(entry.target)?.()
  })
  rowWatchers.set(el, onResize)
  rowObserver.observe(el)
  return () => {
    rowObserver?.unobserve(el)
    rowWatchers.delete(el)
  }
}

/** The honest note for a message with no text to show. */
function placeholder(msg: Msg): string {
  return msg.attachments.length > 0 ? 'Attachment' : 'Message text unavailable'
}

const GUTTER_TIME_SX = {
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
}

const BOT_CHIP_SX = {
  height: 18,
  fontSize: 11,
  fontWeight: 600,
  borderRadius: 1,
  borderColor: 'divider',
  alignSelf: 'center',
  '& .MuiChip-label': { px: 0.75 },
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })

const arrive = keyframes`
  from { background-color: var(--arrive-tint); }
  to { background-color: transparent; }
`

type MessageBodyProps = { msg: Msg; attachmentsOn: boolean; scroll: FeedScroll }

/**
 * The text of a message, or an honest note when there is none to show. Text past COLLAPSE_LINES is
 * clipped behind Show more; it is measured, not counted, because long lines wrap differently per screen.
 */
function MessageBody({ msg, attachmentsOn, scroll }: MessageBodyProps): ReactElement | null {
  const [expanded, setExpanded] = useState(false)
  const [clipped, setClipped] = useState(false)
  const text = useRef<HTMLDivElement>(null)

  // A resize can clip a message that fitted, so keep measuring while it is collapsed.
  useLayoutEffect(() => {
    const el = text.current
    if (!el || expanded) return
    const measure = (): void => setClipped(el.scrollHeight - el.clientHeight > 1)
    measure()
    return watchSize(el, measure)
  }, [expanded, msg.content])

  const toggle = (): void => {
    flushSync(() => setExpanded(wasExpanded => !wasExpanded))
    // Collapsing can leave the reader far below the message, so bring it back into view.
    if (expanded) text.current?.closest('article')?.scrollIntoView({ block: 'nearest' })
    // The page changed height without a scroll event, and a reader mid-message must not be pinned by the next one.
    scroll.recheck()
  }

  const showToggle = clipped || expanded
  const edited = msg.editedAt ? (
    <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 0.75, fontStyle: 'normal' }}>
      (edited)
    </Typography>
  ) : null
  const empty = msg.content === ''
  const hasFiles = msg.attachments.length > 0
  const note = msg.note ? (
    <Typography variant="caption" component="p" sx={{ m: 0, color: 'text.secondary', fontStyle: 'italic' }}>
      {msg.note}
    </Typography>
  ) : null
  // Attachments rendered below, or a note saying what the message is, already explain a message with no text.
  if (empty && !msg.editedAt && (attachmentsOn ? hasFiles : msg.note !== null && !hasFiles)) return note
  return (
    <>
      {note}
      <Typography
        ref={text}
        component="div"
        dir="auto"
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
        {empty ? placeholder(msg) : <MessageParts parts={parseMarkup(msg.content)} />}
        {showToggle ? null : edited}
      </Typography>
      {showToggle ? (
        // A clipped message would hide (edited), so it moves down beside the button.
        <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.25 }}>
          <Button
            size="small"
            aria-expanded={expanded}
            onClick={toggle}
            sx={{
              ml: -0.75,
              px: 0.75,
              minWidth: 0,
              textTransform: 'none',
              fontWeight: 600,
              color: 'text.secondary',
              '&:hover': { color: 'text.primary' },
              [COARSE]: { minHeight: 44 },
            }}
          >
            {expanded ? 'Show less' : 'Show more'}
          </Button>
          {edited}
        </Box>
      ) : null}
    </>
  )
}

/**
 * One message. A `head` row starts an author group with avatar, name and
 * time; a continuation shows its time in the gutter, on hover where hover exists.
 */
export const MessageRow = memo(function MessageRow({ msg, head, attachmentsOn, scroll }: MessageBodyProps & { head: boolean }): ReactElement {
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
        scrollMarginTop: BAR_HEIGHT + 8,
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
        <Typography variant="caption" className="relay-gutter-time" sx={GUTTER_TIME_SX}>
          {time}
        </Typography>
      )}
      <Box sx={{ minWidth: 0 }}>
        {head ? (
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0 }}>
            <Typography component="h2" variant="subtitle2" noWrap sx={{ color: 'text.primary' }}>
              {msg.author.name}
            </Typography>
            {msg.author.bot ? <Chip label="BOT" size="small" variant="outlined" sx={BOT_CHIP_SX} /> : null}
            <Typography variant="caption" sx={{ color: 'text.secondary', flexShrink: 0 }}>
              {time}
            </Typography>
          </Box>
        ) : null}
        <MessageBody msg={msg} attachmentsOn={attachmentsOn} scroll={scroll} />
        {attachmentsOn && msg.attachments.length > 0 ? <Attachments items={msg.attachments} /> : null}
      </Box>
    </Box>
  )
})
