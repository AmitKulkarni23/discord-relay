/**
 * Catches a render error so one broken message shows a fallback instead of a blank page.
 */
import { Component, type ReactElement, type ReactNode } from 'react'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'

type BoundaryProps = { fallback: ReactNode; children: ReactNode }

/** Shows `fallback` when a child throws while rendering. A class, because React has no hook for this. */
export class ErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    console.error('render_failed', error)
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

/** Replaces the page when something outside a message row fails to render. */
export function PageError(): ReactElement {
  return (
    <Box
      sx={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        px: 2,
        textAlign: 'center',
      }}
    >
      <Typography variant="subtitle1" component="h1" sx={{ color: 'text.primary' }}>
        This page hit an error
      </Typography>
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        The channel is unaffected in Discord. Reload to reconnect.
      </Typography>
      <Button variant="contained" size="small" onClick={() => window.location.reload()} sx={{ textTransform: 'none', fontWeight: 600 }}>
        Reload
      </Button>
    </Box>
  )
}

/** Replaces one message that failed to render, so the rest of the feed keeps going. */
export function MessageError(): ReactElement {
  return (
    <Typography variant="body2" sx={{ color: 'text.secondary', fontStyle: 'italic', px: 1.5, py: 0.5 }}>
      This message could not be displayed.
    </Typography>
  )
}
