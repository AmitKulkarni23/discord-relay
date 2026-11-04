import { useMemo, type ReactElement } from 'react'
import Box from '@mui/material/Box'
import { compareIds, type Msg } from '../../backend/types.ts'
import { useStickToBottom } from '../hooks/use-stick-to-bottom.ts'
import { buildRows } from '../lib/messages.ts'
import type { Status } from '../lib/stream.ts'
import { BAR_HEIGHT } from '../theme.ts'
import { ErrorBoundary, MessageError } from './error-boundary.tsx'
import { DayDivider, EmptyState, NewMessagesPill } from './feed-states.tsx'
import { MessageRow } from './message-row.tsx'

type FeedProps = { messages: Msg[]; status: Status; channelName: string | null; attachmentsOn: boolean }

/** The message list, newest at the bottom. Keyed by channel, so a switch starts at the bottom with nothing unseen. */
export function Feed({ messages, status, channelName, attachmentsOn }: FeedProps): ReactElement {
  const rows = useMemo(() => buildRows(messages), [messages])
  const { seenId, scroll, jumpToNewest } = useStickToBottom(messages.at(-1)?.id ?? null)
  const unseen = seenId === null ? 0 : messages.filter(m => compareIds(m.id, seenId) > 0).length

  return (
    <>
      <Box
        component="main"
        sx={{
          maxWidth: 792,
          mx: 'auto',
          px: { xs: 1, sm: 2 },
          pt: 1,
          pb: 10,
          minHeight: `calc(100dvh - ${BAR_HEIGHT + 1}px)`,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {rows.length === 0 ? (
          <EmptyState key={status} status={status} channelName={channelName} />
        ) : (
          <Box role="log" aria-label={channelName ? `Messages in #${channelName}` : 'Messages'} sx={{ mt: 'auto' }}>
            {rows.map(r => (
              <ErrorBoundary key={r.key} fallback={<MessageError />}>
                {r.kind === 'day' ? <DayDivider date={r.date} /> : <MessageRow msg={r.msg} head={r.head} attachmentsOn={attachmentsOn} scroll={scroll} />}
              </ErrorBoundary>
            ))}
          </Box>
        )}
      </Box>
      {unseen > 0 ? <NewMessagesPill count={unseen} onClick={jumpToNewest} /> : null}
    </>
  )
}
