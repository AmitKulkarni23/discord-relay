import { setupDom } from '../dom.ts'
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { useStickToBottom } from '../../hooks/use-stick-to-bottom.ts'

setupDom()

const FIRST = '1566588496691400001'
const SECOND = '1566588496691400002'

describe('useStickToBottom', () => {
  let scrollTo: ReturnType<typeof mock>

  /** happy-dom has no layout, so set how far the reader is from the bottom. */
  const pretendGapIs = (gap: number): void => {
    Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: window.innerHeight + window.scrollY + gap })
  }
  const scrollWithGap = (gap: number): void => {
    pretendGapIs(gap)
    act(() => {
      window.dispatchEvent(new Event('scroll'))
    })
  }

  beforeEach(() => {
    pretendGapIs(0)
    scrollTo = mock(() => {})
    window.scrollTo = scrollTo as unknown as typeof window.scrollTo
  })
  afterEach(() => {
    delete (document.documentElement as unknown as Record<string, unknown>).scrollHeight
  })

  const start = () => renderHook(({ newest }) => useStickToBottom(newest), { initialProps: { newest: FIRST as string | null } })

  describe('when the reader is at the bottom', () => {
    it('should pin to each new message and mark it seen', () => {
      const { result, rerender } = start()
      expect(result.current.seenId).toBe(FIRST)
      scrollTo.mockClear()

      rerender({ newest: SECOND })

      expect(scrollTo).toHaveBeenCalledTimes(1)
      expect(result.current.seenId).toBe(SECOND)
    })

    it('should still count as at the bottom within the slack', () => {
      const { rerender } = start()
      scrollWithGap(80)
      scrollTo.mockClear()

      rerender({ newest: SECOND })

      expect(scrollTo).toHaveBeenCalledTimes(1)
    })
  })

  describe('when the reader has scrolled up', () => {
    it('should leave them where they are and not mark the new message seen', () => {
      const { result, rerender } = start()
      scrollWithGap(500)
      scrollTo.mockClear()

      rerender({ newest: SECOND })

      expect(scrollTo).not.toHaveBeenCalled()
      expect(result.current.seenId).toBe(FIRST)
    })

    it('should mark the newest seen once they scroll back down', () => {
      const { result, rerender } = start()
      scrollWithGap(500)
      rerender({ newest: SECOND })

      scrollWithGap(0)

      expect(result.current.seenId).toBe(SECOND)
    })
  })

  describe('when the page changes height on its own, as an image loads or a Show more appears', () => {
    /** Stands in for the browser's ResizeObserver, whose callback happy-dom never fires without layout. */
    let resized = (): void => {}
    let realObserver: typeof ResizeObserver
    afterEach(() => {
      globalThis.ResizeObserver = realObserver
    })
    beforeEach(() => {
      realObserver = globalThis.ResizeObserver
      globalThis.ResizeObserver = class {
        constructor(callback: () => void) {
          resized = callback
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {
          resized = () => {}
        }
      } as unknown as typeof ResizeObserver
    })

    it('should keep a pinned reader pinned', () => {
      start()
      scrollTo.mockClear()

      resized()

      expect(scrollTo).toHaveBeenCalledTimes(1)
    })

    it('should not move a reader who has scrolled up', () => {
      start()
      scrollWithGap(500)
      scrollTo.mockClear()

      resized()

      expect(scrollTo).not.toHaveBeenCalled()
    })

    it('should stop watching when the feed goes away', () => {
      const { unmount } = start()
      unmount()
      scrollTo.mockClear()

      resized()

      expect(scrollTo).not.toHaveBeenCalled()
    })

    it('should stop pinning a reader whom an expanded message left mid-page, without a scroll event', () => {
      const { result, rerender } = start()
      pretendGapIs(2000)
      result.current.scroll.recheck()
      scrollTo.mockClear()

      rerender({ newest: SECOND })

      expect(scrollTo).not.toHaveBeenCalled()
    })

    it('should keep the same callbacks between renders, so memoised rows do not re-render', () => {
      const { result, rerender } = start()
      const { scroll } = result.current

      rerender({ newest: SECOND })

      expect(result.current.scroll).toBe(scroll)
    })
  })

  describe('when the reader jumps to the newest message', () => {
    it('should scroll smoothly unless they prefer reduced motion', () => {
      const media = spyOn(window, 'matchMedia')
      const { result } = start()

      media.mockReturnValue({ matches: false } as MediaQueryList)
      result.current.jumpToNewest()
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'smooth' }))

      media.mockReturnValue({ matches: true } as MediaQueryList)
      result.current.jumpToNewest()
      expect(scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'auto' }))
      media.mockRestore()
    })
  })
})
