import { useState, type ReactElement } from 'react'
import Box from '@mui/material/Box'
import ButtonBase from '@mui/material/ButtonBase'
import Link from '@mui/material/Link'
import type { Part } from '../lib/markup.ts'
import { MONO } from '../theme.ts'

const fullFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' })

/** How each kind of Discord formatting looks. */
const FORMAT = {
  bold: { fontWeight: 700 },
  italic: { fontStyle: 'italic' },
  underline: { textDecoration: 'underline' },
  strike: { textDecoration: 'line-through' },
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
export function MessageParts({ parts }: { parts: Part[] }): ReactElement {
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
              <Box key={i} component="code" sx={{ fontFamily: MONO, fontSize: '0.9em', bgcolor: 'action.selected', borderRadius: 0.5, px: 0.5 }}>
                {part.text}
              </Box>
            )
          case 'block':
            return (
              <Box
                key={i}
                component="pre"
                sx={{ fontFamily: MONO, fontSize: '0.9em', m: 0, my: 0.5, p: 1, overflowX: 'auto', border: 1, borderColor: 'divider', borderRadius: 1 }}
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
