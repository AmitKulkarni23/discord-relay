import { useEffect, type ReactElement, type ReactNode } from 'react'
import AppBar from '@mui/material/AppBar'
import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import SvgIcon from '@mui/material/SvgIcon'
import Tab from '@mui/material/Tab'
import Tabs from '@mui/material/Tabs'
import Toolbar from '@mui/material/Toolbar'
import Tooltip from '@mui/material/Tooltip'
import Typography from '@mui/material/Typography'
import { keyframes, useColorScheme } from '@mui/material/styles'
import type { ChannelInfo } from '../../backend/types.ts'
import { recoveredLabel, type Status } from '../lib/stream.ts'
import { BAR_HEIGHT, COARSE, GROUND, NARROW, VISUALLY_HIDDEN } from '../theme.ts'

const beat = keyframes`
  from { transform: scale(1); opacity: 0.6; }
  to { transform: scale(3); opacity: 0; }
`

/** `# name`, or the bare ID while the bot has not loaded the channel yet. */
function channelLabel(channel: ChannelInfo): string {
  return `# ${channel.name ?? channel.id}`
}

const STATUS_DOT: Record<Status, string> = {
  connecting: 'text.secondary',
  live: 'success.main',
  reconnecting: 'warning.main',
  discord: 'warning.main',
  full: 'warning.main',
  channel: 'warning.main',
  failed: 'error.main',
}
const STATUS_LABEL: Record<Status, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  discord: 'Waiting for Discord',
  full: 'Connection limit',
  channel: 'Channel unavailable',
  failed: 'Relay down',
}

type StatusChipProps = { status: Status; newestId: string | null; recovered: number | null }

/**
 * The connection chip: green only when messages can really flow; amber while the stream retries or the bot has
 * lost Discord. The dot beats once per newest message, and after a reconnect the chip says what came back.
 */
export function StatusChip({ status, newestId, recovered }: StatusChipProps): ReactElement {
  const dot = STATUS_DOT[status]
  return (
    <Box role="status" aria-live="polite">
      <Chip
        size="small"
        variant="outlined"
        label={status === 'live' && recovered !== null ? recoveredLabel(recovered) : STATUS_LABEL[status]}
        icon={
          <Box component="span" sx={{ position: 'relative', width: 8, height: 8, borderRadius: '50%', bgcolor: dot }}>
            {status === 'live' && newestId ? (
              <Box
                key={newestId}
                component="span"
                sx={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '50%',
                  bgcolor: dot,
                  opacity: 0,
                  animation: `${beat} 900ms cubic-bezier(0.16, 1, 0.3, 1)`,
                  '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
                }}
              />
            ) : null}
          </Box>
        }
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
        sx={{ width: 36, height: 36, color: 'text.secondary', '&:hover': { color: 'text.primary' }, [COARSE]: { width: 44, height: 44 } }}
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

const TAB_SX = {
  minHeight: BAR_HEIGHT,
  minWidth: 0,
  px: 1.5,
  // The tab strip clips anything outside a tab.
  '&.Mui-focusVisible': { outlineOffset: -2 },
  textTransform: 'none',
  fontSize: 14,
  fontWeight: 500,
  color: 'text.secondary',
  '&.Mui-selected': { color: 'text.primary' },
}

type TopBarProps = { channels: ChannelInfo[]; activeId: string | null; onSelect: (id: string) => void; children: ReactNode }

/** Sticky top bar: product name, the channel (tabs when there are several), `children` for the status, theme. */
export function TopBar({ channels, activeId, onSelect, children }: TopBarProps): ReactElement {
  const active = channels.find(channel => channel.id === activeId)
  return (
    <AppBar position="sticky" elevation={0} sx={{ bgcolor: 'background.default', borderBottom: 1, borderColor: 'divider', backgroundImage: 'none' }}>
      <Toolbar sx={{ minHeight: { xs: BAR_HEIGHT }, px: { xs: 2, sm: 3 }, gap: 1.5 }}>
        <Typography component="h1" variant="subtitle1" sx={{ color: 'text.primary', flexShrink: 0, [NARROW]: VISUALLY_HIDDEN }}>
          DiscordRelay
        </Typography>
        <Divider
          orientation="vertical"
          flexItem
          sx={{ my: 2, display: channels.length > 1 ? { xs: 'none', sm: 'block' } : active ? 'block' : 'none', [NARROW]: { display: 'none' } }}
        />
        {channels.length > 1 ? (
          <Tabs
            value={activeId ?? false}
            onChange={(_, id: string) => onSelect(id)}
            variant="scrollable"
            scrollButtons={false}
            aria-label="Channels"
            sx={{ minHeight: BAR_HEIGHT, flex: 1, minWidth: 0, '& .MuiTabs-indicator': { height: 2 } }}
          >
            {channels.map(channel => (
              <Tab key={channel.id} value={channel.id} label={channelLabel(channel)} disableRipple sx={TAB_SX} />
            ))}
          </Tabs>
        ) : active ? (
          <Typography variant="body2" noWrap sx={{ color: 'text.secondary' }}>
            {channelLabel(active)}
          </Typography>
        ) : null}
        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
          {children}
          <ThemeToggle />
        </Box>
      </Toolbar>
    </AppBar>
  )
}
