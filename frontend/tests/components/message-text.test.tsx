import { setupDom } from '../dom.ts'
import { describe, expect, it } from 'bun:test'
import { fireEvent, render } from '@testing-library/react'
import { MessageParts } from '../../components/message-text.tsx'
import { parseMarkup } from '../../lib/markup.ts'

const renderText = (text: string) => render(<MessageParts parts={parseMarkup(text)} />)

setupDom()

describe('MessageParts', () => {
  describe('when the text has a link', () => {
    it('should open it in a new tab without giving that tab access to this page', () => {
      const { getByRole } = renderText('see https://railway.com/docs now')
      const link = getByRole('link', { name: 'https://railway.com/docs' })

      expect(link.getAttribute('href')).toBe('https://railway.com/docs')
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    })

    it('should leave a script URL as plain text', () => {
      const { container } = renderText('javascript:alert(1)')

      expect(container.querySelector('a')).toBeNull()
      expect(container.textContent).toBe('javascript:alert(1)')
    })
  })

  describe('when the text contains HTML', () => {
    it('should show it as text and never as elements', () => {
      const html = '<img src=x onerror=alert(1)><script>alert(1)</script>'
      const { container } = renderText(html)

      expect(container.querySelector('img, script')).toBeNull()
      expect(container.textContent).toBe(html)
    })
  })

  describe('when the text has a spoiler', () => {
    it('should hide it from sight and screen readers until clicked', () => {
      const { getByRole, getByText, queryByRole } = renderText('the answer is ||forty two||')
      const hidden = getByText('forty two')

      expect(hidden.closest('[aria-hidden="true"]')).not.toBeNull()

      fireEvent.click(getByRole('button', { name: 'Spoiler: show' }))

      expect(queryByRole('button', { name: 'Spoiler: show' })).toBeNull()
      expect(getByText('forty two').closest('[aria-hidden="true"]')).toBeNull()
    })
  })

  describe('when the text has formatting', () => {
    it('should keep bold, code and blocks in their own elements', () => {
      const { container, getByText } = renderText('**ship** it with `bun test`\n```\nbun run dev\n```')

      expect(getByText('ship').tagName).toBe('SPAN')
      expect(container.querySelector('code')?.textContent).toBe('bun test')
      expect(container.querySelector('pre')?.textContent).toBe('bun run dev')
    })

    it('should show a Discord timestamp as a machine-readable time', () => {
      const { container } = renderText('<t:1618953630:R>')

      expect(container.querySelector('time')?.getAttribute('datetime')).toBe('2021-04-20T21:20:30.000Z')
    })
  })
})
