import { setupDom } from '../dom.ts'
import { describe, expect, it, mock } from 'bun:test'
import { fireEvent, render } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import type { ChannelInfo } from '../../../backend/types.ts'
import { StatusChip, TopBar } from '../../components/top-bar.tsx'
import type { Status } from '../../lib/stream.ts'
import { theme } from '../../theme.ts'

const RELAY: ChannelInfo = { id: '1566584977829900002', name: 'relay' }
const NEWS: ChannelInfo = { id: '1566584977829900003', name: 'announcements' }

/** The chip's text; its whole `textContent` also holds the style tags Emotion renders under test. */
const chipLabel = (container: HTMLElement): string | null | undefined => container.querySelector('[role="status"] .MuiChip-label')?.textContent

function renderBar(channels: ChannelInfo[], onSelect: (id: string) => void = () => {}) {
  return render(
    <ThemeProvider theme={theme} defaultMode="dark" noSsr>
      <TopBar channels={channels} activeId={channels[0]?.id ?? null} onSelect={onSelect}>
        <span>status slot</span>
      </TopBar>
    </ThemeProvider>,
  )
}

setupDom()

describe('StatusChip', () => {
  describe('when the connection changes', () => {
    for (const [status, label] of [
      ['connecting', 'Connecting'],
      ['live', 'Live'],
      ['reconnecting', 'Reconnecting'],
      ['discord', 'Waiting for Discord'],
    ] as Array<[Status, string]>) {
      it(`should say ${label} when the status is ${status}`, () => {
        const { container } = render(<StatusChip status={status} newestId={null} recovered={null} />)

        expect(chipLabel(container)).toBe(label)
      })
    }
  })

  describe('when a reconnect has just recovered messages', () => {
    it('should say how many while the stream is live', () => {
      const { container } = render(<StatusChip status="live" newestId={null} recovered={3} />)

      expect(chipLabel(container)).toBe('Back · 3 caught up')
    })

    it('should not claim to be back when Discord is down', () => {
      const { container } = render(<StatusChip status="discord" newestId={null} recovered={3} />)

      expect(chipLabel(container)).toBe('Waiting for Discord')
    })
  })
})

describe('TopBar', () => {
  describe('when there is one channel', () => {
    it('should show its name without tabs', () => {
      const { getByText, queryByRole } = renderBar([RELAY])

      expect(getByText('# relay')).toBeDefined()
      expect(queryByRole('tab')).toBeNull()
    })

    it('should show the ID while the name has not loaded', () => {
      const { getByText } = renderBar([{ id: RELAY.id, name: null }])

      expect(getByText(`# ${RELAY.id}`)).toBeDefined()
    })
  })

  describe('when there are several channels', () => {
    it('should report the channel the reader picks', () => {
      const onSelect = mock((_id: string) => {})
      const { getByRole } = renderBar([RELAY, NEWS], onSelect)

      fireEvent.click(getByRole('tab', { name: '# announcements' }))

      expect(onSelect).toHaveBeenCalledWith(NEWS.id)
    })
  })

  describe('when the reader changes the theme', () => {
    it('should offer the opposite mode next', () => {
      const { getByRole } = renderBar([RELAY])

      fireEvent.click(getByRole('button', { name: 'Switch to light mode' }))

      expect(getByRole('button', { name: 'Switch to dark mode' })).toBeDefined()
    })
  })
})
