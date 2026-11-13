/**
 * Chat-style scrolling: a reader at the bottom follows new messages; a reader who scrolled
 * up stays put and the feed counts what they have not seen yet, for the "N new messages" pill.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

/** How close to the bottom (px) still counts as reading the newest message. */
const BOTTOM_SLACK = 80

/** True when the window is scrolled to (or near) the bottom of the page. */
function isAtBottom(): boolean {
  const el = document.documentElement
  return el.scrollHeight - (window.scrollY + window.innerHeight) <= BOTTOM_SLACK
}

/** Scrolls to the newest message. */
function pinToBottom(): void {
  window.scrollTo({ top: document.documentElement.scrollHeight })
}

/** What a row tells the feed when it changes height on its own, which fires no scroll event. */
export type FeedScroll = {
  /** The reader resized the row: work out afresh whether they are still at the bottom. */
  recheck: () => void
}

type StickToBottom = {
  /** Newest message ID the reader has seen at the bottom of the page. */
  seenId: string | null
  scroll: FeedScroll
  jumpToNewest: () => void
}

/** Keeps a reader who is at the bottom pinned there as messages land, and tracks what they have seen. */
export function useStickToBottom(newestId: string | null): StickToBottom {
  const atBottom = useRef(true)
  const [seenId, setSeenId] = useState<string | null>(null)

  useEffect(() => {
    const onScroll = (): void => {
      atBottom.current = isAtBottom()
      if (atBottom.current) setSeenId(newestId)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [newestId])

  useLayoutEffect(() => {
    if (!atBottom.current) return
    pinToBottom()
    setSeenId(newestId)
  }, [newestId])

  // An image loading or a Show more appearing grows the page with no new message and no scroll event.
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      if (atBottom.current) pinToBottom()
    })
    observer.observe(document.body)
    return () => observer.disconnect()
  }, [])

  const scroll = useMemo<FeedScroll>(
    () => ({
      recheck() {
        atBottom.current = isAtBottom()
      },
    }),
    [],
  )

  const jumpToNewest = (): void => {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }

  return { seenId, scroll, jumpToNewest }
}
