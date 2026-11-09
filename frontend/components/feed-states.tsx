import { useEffect, useState, type ReactElement } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import SvgIcon from '@mui/material/SvgIcon'
import Typography from '@mui/material/Typography'
import { alpha } from '@mui/material/styles'
import type { Status } from '../lib/stream.ts'

/** How long an empty feed waits before saying why, so a replay in progress never flashes a wrong message. */
const EMPTY_DELAY_MS = 1_500

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

/** "Today", "Yesterday", or the weekday and date. */
function dayLabel(date: Date): string {
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return dayFmt.format(date)
}

/** A centred date line between messages from different days. */
export function DayDivider({ date }: { date: Date }): ReactElement {
  // "Today" turns into "Yesterday" at midnight, even on a page with no new messages.
  const [, refresh] = useState(0)
  useEffect(() => {
    const now = new Date()
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const timer = setTimeout(() => refresh(count => count + 1), midnight.getTime() - now.getTime())
    return () => clearTimeout(timer)
  })

  return (
    <Divider sx={{ my: 2 }}>
      <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 600 }}>
        {dayLabel(date)}
      </Typography>
    </Divider>
  )
}

/** The heading and line for an empty feed. */
function emptyCopy(status: Status, where: string): [string, string] {
  switch (status) {
    case 'live':
      return ['No messages yet', `Post in ${where} and it shows up here, live.`]
    case 'discord':
      return ['Waiting for Discord', 'The relay is reconnecting to Discord. Messages appear as soon as it is back.']
    case 'channel':
      return ['Channel unavailable', 'The relay cannot read this channel right now. It keeps trying.']
    case 'failed':
      return ['Relay is down', 'The relay cannot sign in to Discord. The project maintainer has been notified.']
    case 'full':
      return ['Connection limit reached', 'This network has too many streams open to this page. Close a tab or wait; it retries on its own.']
    case 'connecting':
      return ['Connecting to the relay', 'Messages appear as soon as the stream opens.']
    case 'reconnecting':
      return ['Reconnecting to the relay', 'Messages appear as soon as the stream opens.']
  }
}

/** Shown in place of the feed before any message has arrived. */
export function EmptyState({ status, channelName }: { status: Status; channelName: string | null }): ReactElement | null {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), EMPTY_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])
  const where = channelName ? `#${channelName}` : 'the channel'
  const [title, body] = emptyCopy(status, where)
  if (!ready) return null
  return (
    <Box sx={{ m: 'auto', textAlign: 'center', py: 8, px: 2 }}>
      <Typography variant="subtitle1" component="p" sx={{ color: 'text.primary', mb: 0.5 }}>
        {title}
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {body}
      </Typography>
    </Box>
  )
}

/** Floating button that appears when messages land below where the reader is. */
export function NewMessagesPill({ count, onClick }: { count: number; onClick: () => void }): ReactElement {
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
        theme => ({ boxShadow: `0 6px 20px ${alpha(theme.palette.common.black, 0.45)}` }),
        theme => theme.applyStyles('light', { boxShadow: `0 6px 20px ${alpha(theme.palette.common.black, 0.18)}` }),
      ]}
    >
      {count} new message{count === 1 ? '' : 's'}
    </Button>
  )
}
