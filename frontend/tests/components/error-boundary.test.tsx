import { setupDom } from '../dom.ts'
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { fireEvent, render } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { ErrorBoundary, PageError } from '../../components/error-boundary.tsx'
import { Feed } from '../../components/feed.tsx'
import { makeMsg } from '../fixtures.ts'

setupDom()

function Bomb(): ReactElement {
  throw new Error('render failed')
}

function Toggled(): ReactElement {
  const [armed, setArmed] = useState(false)
  if (armed) throw new Error('render failed')
  return <button onClick={() => setArmed(true)}>arm</button>
}

describe('ErrorBoundary', () => {
  let quiet: ReturnType<typeof spyOn>
  beforeEach(() => {
    window.scrollTo = (() => {}) as typeof window.scrollTo
    quiet = spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => quiet.mockRestore())

  describe('when its children render', () => {
    it('should show them', () => {
      const { getByRole, queryByText } = render(
        <ErrorBoundary fallback={<p>failed</p>}>
          <Toggled />
        </ErrorBoundary>,
      )

      expect(getByRole('button', { name: 'arm' })).toBeDefined()
      expect(queryByText('failed')).toBeNull()
    })
  })

  describe('when a child throws', () => {
    it('should show the fallback instead of a blank page', () => {
      const { getByText } = render(
        <ErrorBoundary fallback={<p>failed</p>}>
          <Bomb />
        </ErrorBoundary>,
      )

      expect(getByText('failed')).toBeDefined()
    })

    it('should catch a throw from a later render too', () => {
      const { getByRole, getByText } = render(
        <ErrorBoundary fallback={<p>failed</p>}>
          <Toggled />
        </ErrorBoundary>,
      )

      fireEvent.click(getByRole('button', { name: 'arm' }))

      expect(getByText('failed')).toBeDefined()
    })

    it('should log the error for whoever opens the console', () => {
      render(
        <ErrorBoundary fallback={<p>failed</p>}>
          <Bomb />
        </ErrorBoundary>,
      )

      expect(quiet.mock.calls.some((call: unknown[]) => call.includes('render_failed'))).toBe(true)
    })
  })

  describe('when the whole page fails', () => {
    it('should say what happened and offer a reload', () => {
      const { getByRole, getByText } = render(<PageError />)

      expect(getByText('This page hit an error')).toBeDefined()
      expect(getByRole('button', { name: 'Reload' })).toBeDefined()
    })
  })

  describe('when one message cannot render', () => {
    it('should lose only that message and keep the feed', () => {
      const good = makeMsg({ id: '1566588496691400002', content: 'deploy finished for build 482' })
      const bad = makeMsg({ id: '1566588496691400001', createdAt: 'not a date' })
      const { getAllByText, getByText } = render(<Feed messages={[bad, good]} status="live" channelName="relay" attachmentsOn={false} />)

      expect(getAllByText('This message could not be displayed.').length).toBeGreaterThan(0)
      expect(getByText('deploy finished for build 482')).toBeDefined()
    })
  })
})
