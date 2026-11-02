import { useState, type ReactElement, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Link from '@mui/material/Link'
import SvgIcon from '@mui/material/SvgIcon'
import Typography from '@mui/material/Typography'
import type { Attachment } from '../backend/types.ts'
import { attachmentKind, fitBox, formatBytes, isDiscordCdn } from './media.ts'

/** Largest box an inline image or video takes in the feed. */
const MAX_W = 400
const MAX_H = 320

/**
 * Attachments under a message: images inline, video and audio with controls,
 * anything else as a file link. Rendered only when the `attachments` flag is on.
 */
export default function Attachments({ items }: { items: Attachment[] }): ReactElement {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, mt: 0.75 }}>
      {items.map(a => (
        <AttachmentItem key={a.url} a={a} />
      ))}
    </Box>
  )
}

/** One attachment, picked by type. URLs off Discord's CDN never get a src or href. */
function AttachmentItem({ a }: { a: Attachment }): ReactElement {
  const [failed, setFailed] = useState(false)
  const kind = attachmentKind(a.contentType)
  const safe = isDiscordCdn(a.url)

  if (!safe || kind === 'file') return <FileCard a={a} href={safe ? a.url : null} />
  if (failed) return <Unavailable a={a} />

  const box = fitBox(a.width, a.height, MAX_W, MAX_H)
  const sized = { width: box?.width ?? MAX_W, maxWidth: '100%', height: 'auto', aspectRatio: box ? `${box.width} / ${box.height}` : undefined }
  const onError = (): void => setFailed(true)

  if (kind === 'audio') {
    return <Box component="audio" controls preload="metadata" src={a.url} onError={onError} aria-label={a.name} sx={{ width: MAX_W, maxWidth: '100%' }} />
  }

  return (
    <Spoiler hidden={a.name.startsWith('SPOILER_')}>
      {kind === 'image' ? (
        <Link href={a.url} target="_blank" rel="noopener noreferrer" sx={{ display: 'block', borderRadius: 1 }}>
          <Box
            component="img"
            src={a.url}
            alt={a.name}
            loading="lazy"
            onError={onError}
            sx={{ ...sized, display: 'block', borderRadius: 1, bgcolor: 'background.paper', objectFit: 'cover' }}
          />
        </Link>
      ) : (
        <Box
          component="video"
          src={a.url}
          controls
          playsInline
          preload="metadata"
          onError={onError}
          aria-label={a.name}
          sx={{ ...sized, display: 'block', borderRadius: 1, bgcolor: 'background.paper' }}
        />
      )}
    </Spoiler>
  )
}

/** Blurs a SPOILER_ file until the reader chooses to see it. */
function Spoiler({ hidden, children }: { hidden: boolean; children: ReactNode }): ReactElement {
  const [shown, setShown] = useState(!hidden)
  if (shown) return <>{children}</>
  return (
    <Box sx={{ position: 'relative', borderRadius: 1, overflow: 'hidden' }}>
      <Box aria-hidden sx={{ filter: 'blur(28px)', pointerEvents: 'none' }} inert>
        {children}
      </Box>
      <ButtonBase
        onClick={() => setShown(true)}
        sx={{ position: 'absolute', inset: 0, color: 'text.primary', fontWeight: 600, fontSize: 14, bgcolor: 'action.hover', '&:focus-visible': { outlineOffset: -2 } }}
      >
        Spoiler: show
      </ButtonBase>
    </Box>
  )
}

/** A paper-clip glyph for file cards. */
function FileIcon(): ReactElement {
  return (
    <SvgIcon sx={{ fontSize: 20, color: 'text.secondary' }} viewBox="0 0 24 24">
      <path
        d="m21 11-8.6 8.6a5 5 0 0 1-7-7l8.5-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.3-2.4l7.9-7.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </SvgIcon>
  )
}

/** A file as a bordered row: name (a link when the URL is safe), size and type. */
function FileCard({ a, href }: { a: Attachment; href: string | null }): ReactElement {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 1.5, py: 1, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper', maxWidth: MAX_W, width: '100%' }}>
      <FileIcon />
      <Box sx={{ minWidth: 0 }}>
        {href ? (
          <Link href={href} target="_blank" rel="noopener noreferrer" underline="hover" sx={{ display: 'block', fontSize: 14, fontWeight: 500, color: 'primary.main', overflowWrap: 'anywhere' }}>
            {a.name}
          </Link>
        ) : (
          <Typography variant="body2" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
            {a.name}
          </Typography>
        )}
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {formatBytes(a.size)}
          {a.contentType ? ` · ${a.contentType}` : ''}
        </Typography>
      </Box>
    </Box>
  )
}

/** Shown when the CDN link no longer loads; Discord's signed URLs expire after about a day. */
function Unavailable({ a }: { a: Attachment }): ReactElement {
  return (
    <Box sx={{ px: 1.5, py: 1, border: 1, borderColor: 'divider', borderRadius: 1, maxWidth: MAX_W }}>
      <Typography variant="body2" sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
        {a.name}: no longer available
      </Typography>
    </Box>
  )
}
