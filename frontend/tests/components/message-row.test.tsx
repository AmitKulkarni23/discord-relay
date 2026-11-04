import { setupDom } from '../dom.ts'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { fireEvent, render } from '@testing-library/react'
import { MessageRow } from '../../components/message-row.tsx'
import type { FeedScroll } from '../../hooks/use-stick-to-bottom.ts'
import { makeAttachment, makeMsg } from '../fixtures.ts'

setupDom()

const makeScroll = () => ({ keepPinned: mock(() => {}), recheck: mock(() => {}) }) satisfies FeedScroll

/** happy-dom has no layout, so say how tall the text is and how much of it fits. */
function pretendTextIs(scrollHeight: number, clientHeight: number): void {
  const element = globalThis.HTMLElement.prototype
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: clientHeight })
}
afterEach(() => {
  const element = globalThis.HTMLElement.prototype as unknown as Record<string, unknown>
  delete element.scrollHeight
  delete element.clientHeight
})

const renderRow = (msg = makeMsg(), scroll: FeedScroll = makeScroll(), { head = true, attachmentsOn = false } = {}) =>
  render(<MessageRow msg={msg} head={head} attachmentsOn={attachmentsOn} scroll={scroll} />)

describe('MessageRow', () => {
  describe('when a row starts an author group', () => {
    it('should show the author and the text', () => {
      const { getByRole, getByText } = renderRow()

      expect(getByRole('heading', { name: 'relay_tester' })).toBeDefined()
      expect(getByText('deploy finished for build 482')).toBeDefined()
    })

    it('should mark a bot', () => {
      const msg = makeMsg({ author: { id: '961675715634400004', name: 'Deploy Bot', avatarUrl: null, bot: true } })

      expect(renderRow(msg).getByText('BOT')).toBeDefined()
    })
  })

  describe('when a row continues an author group', () => {
    it('should leave out the author', () => {
      expect(renderRow(makeMsg(), makeScroll(), { head: false }).queryByRole('heading')).toBeNull()
    })
  })

  describe('when an avatar is off the Discord CDN', () => {
    it('should never load it', () => {
      const msg = makeMsg({ author: { id: '961675715634400004', name: 'relay_tester', avatarUrl: 'https://evil.example/a.png', bot: false } })

      expect(renderRow(msg).container.querySelector('img')).toBeNull()
    })
  })

  describe('when a message has no text', () => {
    it('should say the text is unavailable', () => {
      expect(renderRow(makeMsg({ content: '' })).getByText('Message text unavailable')).toBeDefined()
    })

    it('should name the attachment when attachments are off', () => {
      expect(renderRow(makeMsg({ content: '', attachments: [makeAttachment()] })).getByText('Attachment')).toBeDefined()
    })

    it('should show only the attachment when attachments are on', () => {
      const { container, queryByText } = renderRow(makeMsg({ content: '', attachments: [makeAttachment()] }), makeScroll(), { attachmentsOn: true })

      expect(queryByText('Attachment')).toBeNull()
      expect(container.querySelector('img[loading="lazy"]')).not.toBeNull()
    })
  })

  describe('when a message has a note', () => {
    it('should show the note in place of a placeholder when there is no text', () => {
      const { getByText, queryByText } = renderRow(makeMsg({ content: '', note: 'Sticker: party parrot' }))

      expect(getByText('Sticker: party parrot')).toBeDefined()
      expect(queryByText('Message text unavailable')).toBeNull()
    })

    it('should show the note and the text together', () => {
      const { getByText } = renderRow(makeMsg({ note: 'Forwarded' }))

      expect(getByText('Forwarded')).toBeDefined()
      expect(getByText('deploy finished for build 482')).toBeDefined()
    })

    it('should show it on an attachment-only message', () => {
      const { getByText, container } = renderRow(makeMsg({ content: '', note: 'Forwarded', attachments: [makeAttachment()] }), makeScroll(), {
        attachmentsOn: true,
      })

      expect(getByText('Forwarded')).toBeDefined()
      expect(container.querySelector('img[alt="build-log.png"]')).not.toBeNull()
    })

    it('should still mention the attachment when attachments are off', () => {
      const { getByText } = renderRow(makeMsg({ content: '', note: 'Forwarded', attachments: [makeAttachment()] }))

      expect(getByText('Attachment')).toBeDefined()
    })

    it('should treat the note as text, never as markup or a link', () => {
      const { container, getByText } = renderRow(makeMsg({ content: '', note: 'Poll: <img src=x> https://evil.example' }))

      expect(getByText('Poll: <img src=x> https://evil.example')).toBeDefined()
      expect(container.querySelector('a')).toBeNull()
      expect(container.querySelector('img[src="x"]')).toBeNull()
    })
  })

  describe('when a message fits', () => {
    it('should offer no Show more and keep (edited) with the text', () => {
      pretendTextIs(100, 100)
      const { getByText, queryByRole } = renderRow(makeMsg({ editedAt: '2026-11-01T23:05:00.000Z' }))

      expect(queryByRole('button', { name: 'Show more' })).toBeNull()
      expect(getByText('(edited)').parentElement?.textContent).toContain('deploy finished')
    })
  })

  describe('when a message is taller than the limit', () => {
    it('should offer Show more and stay pinned for the button that just appeared', () => {
      pretendTextIs(1000, 338)
      const scroll = makeScroll()
      const { getByRole } = renderRow(makeMsg(), scroll)

      expect(getByRole('button', { name: 'Show more' }).getAttribute('aria-expanded')).toBe('false')
      expect(scroll.keepPinned).toHaveBeenCalled()
    })

    it('should move (edited) beside the button, out of the clipped text', () => {
      pretendTextIs(1000, 338)
      const { getByRole, getByText } = renderRow(makeMsg({ editedAt: '2026-11-01T23:05:00.000Z' }))

      expect(getByText('(edited)').parentElement).toBe(getByRole('button', { name: 'Show more' }).parentElement)
    })

    it('should expand and collapse, rechecking where the reader is each time', () => {
      pretendTextIs(1000, 338)
      const scroll = makeScroll()
      const { getByRole } = renderRow(makeMsg(), scroll)

      fireEvent.click(getByRole('button', { name: 'Show more' }))
      expect(getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true')
      expect(scroll.recheck).toHaveBeenCalledTimes(1)

      fireEvent.click(getByRole('button', { name: 'Show less' }))
      expect(getByRole('button', { name: 'Show more' })).toBeDefined()
      expect(scroll.recheck).toHaveBeenCalledTimes(2)
    })
  })
})
