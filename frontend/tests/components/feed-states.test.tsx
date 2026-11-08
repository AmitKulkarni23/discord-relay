import { setupDom } from '../dom.ts'
import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { act, fireEvent, render } from '@testing-library/react'
import { DayDivider, EmptyState, NewMessagesPill } from '../../components/feed-states.tsx'
import type { Status } from '../../lib/stream.ts'

setupDom()

describe('EmptyState', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  const settled = (status: Status) => {
    const view = render(<EmptyState status={status} channelName="relay" />)
    act(() => {
      jest.advanceTimersByTime(1500)
    })
    return view
  }

  describe('when the feed has only just become empty', () => {
    it('should stay blank, so a replay in progress never flashes a wrong message', () => {
      const { queryByText } = render(<EmptyState status="live" channelName="relay" />)

      act(() => {
        jest.advanceTimersByTime(1499)
      })

      expect(queryByText('No messages yet')).toBeNull()
    })
  })

  describe('when the feed stays empty', () => {
    it('should name the channel to post in when the stream is live', () => {
      const { getByText } = settled('live')

      expect(getByText('No messages yet')).toBeDefined()
      expect(getByText('Post in #relay and it shows up here, live.')).toBeDefined()
    })

    for (const [status, title] of [
      ['connecting', 'Connecting to the relay'],
      ['reconnecting', 'Reconnecting to the relay'],
      ['discord', 'Waiting for Discord'],
      ['full', 'Connection limit reached'],
      ['channel', 'Channel unavailable'],
      ['failed', 'Relay is down'],
    ] as Array<[Status, string]>) {
      it(`should say ${title} when the status is ${status}`, () => {
        expect(settled(status).getByText(title)).toBeDefined()
      })
    }
  })
})

describe('NewMessagesPill', () => {
  describe('when messages land below the reader', () => {
    it('should count them and jump when clicked', () => {
      const onClick = mock(() => {})
      const { getByRole } = render(<NewMessagesPill count={3} onClick={onClick} />)

      fireEvent.click(getByRole('button', { name: '3 new messages' }))

      expect(onClick).toHaveBeenCalledTimes(1)
    })

    it('should use the singular when there is one', () => {
      expect(render(<NewMessagesPill count={1} onClick={() => {}} />).getByRole('button', { name: '1 new message' })).toBeDefined()
    })
  })
})

describe('DayDivider', () => {
  describe('when the page stays open past midnight', () => {
    afterEach(() => {
      jest.useRealTimers()
    })

    it('should stop calling yesterday Today', () => {
      jest.useFakeTimers()
      jest.setSystemTime(new Date(2026, 10, 3, 23, 59, 0))
      const { getByText } = render(<DayDivider date={new Date(2026, 10, 3, 12)} />)
      expect(getByText('Today')).toBeDefined()

      jest.setSystemTime(new Date(2026, 10, 4, 0, 0, 1))
      act(() => {
        jest.advanceTimersByTime(61_000)
      })

      expect(getByText('Yesterday')).toBeDefined()
    })
  })

  describe('when the day is recent', () => {
    it('should say Today and Yesterday rather than the date', () => {
      const yesterday = new Date()
      yesterday.setDate(yesterday.getDate() - 1)

      expect(render(<DayDivider date={new Date()} />).getByText('Today')).toBeDefined()
      expect(render(<DayDivider date={yesterday} />).getByText('Yesterday')).toBeDefined()
    })
  })

  describe('when the day is older', () => {
    it('should spell out the weekday and date', () => {
      const date = new Date(2021, 3, 20)

      expect(render(<DayDivider date={date} />).getByText(/April 20/)).toBeDefined()
    })
  })
})
