import { setupDom } from './dom.ts'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { ThemeProvider } from '@mui/material/styles'
import App from '../app.tsx'
import { theme } from '../theme.ts'
import { FakeEventSource, makeMsg } from './fixtures.ts'

setupDom()

const RELAY = '1566584977829900002'
const NEWS = '1566584977829900003'

function serveConfig(config: unknown, status = 200): ReturnType<typeof mock> {
  const fetchMock = mock(async () => new globalThis.Response(JSON.stringify(config), { status }))
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

const renderApp = () =>
  render(
    <ThemeProvider theme={theme} defaultMode="dark" noSsr>
      <App />
    </ThemeProvider>,
  )

const CONFIG = {
  attachments: false,
  channels: [
    { id: RELAY, name: 'relay' },
    { id: NEWS, name: 'announcements' },
  ],
}

describe('App', () => {
  beforeEach(() => {
    FakeEventSource.opened = []
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    window.scrollTo = (() => {}) as typeof window.scrollTo
    window.history.replaceState(null, '', '/')
  })

  describe('when /config answers', () => {
    it('should show a tab per channel and title the page after the active one', async () => {
      serveConfig(CONFIG)
      const { findByRole } = renderApp()

      expect(await findByRole('tab', { name: '# announcements' })).toBeDefined()
      expect(document.title).toBe('#relay · DiscordRelay')
    })
  })

  describe('when a message arrives', () => {
    it('should show it in the feed and in the status chip as live', async () => {
      serveConfig(CONFIG)
      const { findByRole, getByText, container } = renderApp()
      await findByRole('tab', { name: '# relay' })
      const es = FakeEventSource.latest()

      act(() => {
        es.onopen?.()
        es.sendMessage(makeMsg())
      })

      expect(getByText('deploy finished for build 482')).toBeDefined()
      expect(container.querySelector('[role="status"] .MuiChip-label')?.textContent).toBe('Live')
    })
  })

  describe('when the reader picks a channel', () => {
    it('should switch stream, URL and title, without losing the tabs', async () => {
      serveConfig(CONFIG)
      const { findByRole, getByRole } = renderApp()
      const tab = await findByRole('tab', { name: '# announcements' })
      const first = FakeEventSource.latest()

      fireEvent.click(tab)

      await waitFor(() => expect(first.closed).toBe(true))
      expect(FakeEventSource.latest().url).toBe(`/events?channel=${NEWS}`)
      expect(window.location.search).toBe(`?channel=${NEWS}`)
      expect(document.title).toBe('#announcements · DiscordRelay')
      expect(getByRole('tab', { name: '# announcements' })).toBe(tab)
    })
  })

  describe('when the URL names a channel', () => {
    it('should open that channel', async () => {
      window.history.replaceState(null, '', `/?channel=${NEWS}`)
      serveConfig(CONFIG)
      const { findByRole } = renderApp()
      await findByRole('tab', { name: '# announcements' })

      expect(FakeEventSource.latest().url).toBe(`/events?channel=${NEWS}`)
    })

    it('should fall back to the default when the channel does not exist', async () => {
      window.history.replaceState(null, '', '/?channel=999')
      serveConfig(CONFIG)
      const { findByRole } = renderApp()
      await findByRole('tab', { name: '# relay' })

      await waitFor(() => expect(FakeEventSource.latest().url).toBe('/events'))
    })
  })

  describe('when attachments are on', () => {
    it('should render them', async () => {
      serveConfig({ ...CONFIG, attachments: true })
      const { findByRole, container } = renderApp()
      await findByRole('tab', { name: '# relay' })
      await waitFor(() => expect(FakeEventSource.opened.length).toBeGreaterThan(0))

      act(() =>
        FakeEventSource.latest().sendMessage(
          makeMsg({
            attachments: [
              { url: 'https://cdn.discordapp.com/attachments/1/2/shot.png', name: 'shot.png', contentType: 'image/png', size: 10, width: 10, height: 10 },
            ],
          }),
        ),
      )

      await waitFor(() => expect(container.querySelector('img[alt="shot.png"]')).not.toBeNull())
    })
  })
})
