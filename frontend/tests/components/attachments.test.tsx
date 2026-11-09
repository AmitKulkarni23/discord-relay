import { setupDom } from '../dom.ts'
import { describe, expect, it } from 'bun:test'
import { fireEvent, render } from '@testing-library/react'
import Attachments from '../../components/attachments.tsx'
import { makeAttachment } from '../fixtures.ts'

const OFF_CDN = 'https://cdn.discordapp.com.evil.example/build-log.png'

setupDom()

describe('Attachments', () => {
  describe('when a URL is off the Discord CDN', () => {
    it('should give an image neither a src nor a link', () => {
      const { container, getByText } = render(<Attachments items={[makeAttachment({ url: OFF_CDN })]} />)

      expect(getByText('build-log.png')).toBeDefined()
      expect(container.querySelector('img')).toBeNull()
      expect(container.querySelector('a')).toBeNull()
    })

    it('should give a video or audio file no src', () => {
      const items = [
        makeAttachment({ url: OFF_CDN, name: 'demo.mp4', contentType: 'video/mp4' }),
        makeAttachment({ url: OFF_CDN, name: 'demo.ogg', contentType: 'audio/ogg' }),
      ]
      const { container } = render(<Attachments items={items} />)

      expect(container.querySelector('video')).toBeNull()
      expect(container.querySelector('audio')).toBeNull()
    })

    it('should not link a script URL', () => {
      const { container } = render(<Attachments items={[makeAttachment({ url: 'javascript:alert(1)', contentType: 'application/pdf' })]} />)

      expect(container.querySelector('a')).toBeNull()
    })
  })

  describe('when a URL is on the Discord CDN', () => {
    it('should load an image lazily and open it safely', () => {
      const attachment = makeAttachment()
      const { container } = render(<Attachments items={[attachment]} />)
      const link = container.querySelector('a')

      expect(container.querySelector('img')?.getAttribute('src')).toBe(attachment.url)
      expect(container.querySelector('img')?.getAttribute('loading')).toBe('lazy')
      expect(link?.getAttribute('target')).toBe('_blank')
      expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    })

    it('should never autoplay a video', () => {
      const { container } = render(<Attachments items={[makeAttachment({ name: 'demo.mp4', contentType: 'video/mp4' })]} />)

      expect(container.querySelector('video')?.hasAttribute('autoplay')).toBe(false)
    })

    it('should show other files as a card with their size', () => {
      const attachment = makeAttachment({ name: 'report.pdf', contentType: 'application/pdf' })
      const { getByRole, getByText } = render(<Attachments items={[attachment]} />)

      expect(getByRole('link', { name: 'report.pdf' }).getAttribute('href')).toBe(attachment.url)
      expect(getByText('2.0 KB · application/pdf')).toBeDefined()
    })
  })

  describe('when a file is marked as a spoiler', () => {
    for (const [name, contentType, tag] of [
      ['SPOILER_shot.png', 'image/png', 'img'],
      ['SPOILER_demo.mp4', 'video/mp4', 'video'],
      ['SPOILER_demo.ogg', 'audio/ogg', 'audio'],
    ] as const) {
      it(`should keep ${tag} out of reach until the reader chooses to see it`, () => {
        const { container, getByRole, queryByRole } = render(<Attachments items={[makeAttachment({ name, contentType })]} />)

        expect(container.querySelector(tag)?.closest('[inert]')).not.toBeNull()

        fireEvent.click(getByRole('button', { name: 'Spoiler: show' }))

        expect(queryByRole('button', { name: 'Spoiler: show' })).toBeNull()
        expect(container.querySelector(tag)?.closest('[inert]')).toBeNull()
      })
    }
  })

  describe('when a file no longer loads', () => {
    it('should say so instead of showing broken media', () => {
      const { container, getByText } = render(<Attachments items={[makeAttachment()]} />)

      fireEvent.error(container.querySelector('img') as Element)

      expect(getByText('build-log.png: no longer available')).toBeDefined()
      expect(container.querySelector('img')).toBeNull()
    })
  })
})
