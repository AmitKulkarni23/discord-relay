import { describe, expect, it, mock } from 'bun:test'
import { createHub } from '../hub.ts'
import type { Msg } from '../types.ts'

const GENERAL = '1301000000000000001'
const RANDOM = '1301000000000000002'

/** Builds a realistic message; override any field per test. */
function makeMsg(id: string, overrides: Partial<Msg> = {}): Msg {
  return {
    id,
    channelId: GENERAL,
    author: { id: '1290000000000000042', name: 'amit', avatarUrl: null, bot: false },
    content: `deploy finished for build ${id}`,
    createdAt: '2026-11-01T17:00:00.000Z',
    editedAt: null,
    attachments: [],
    ...overrides,
  }
}

describe('hub', () => {
  describe('when a message arrives out of ID order', () => {
    const LIVE = '1302000000000000900'
    const OLD = ['1302000000000000001', '1302000000000000002', '1302000000000000003'] as const

    it('should replay oldest first when a live message lands before history', () => {
      const hub = createHub(10)

      hub.publish(makeMsg(LIVE))
      for (const id of OLD) hub.publish(makeMsg(id))

      expect(hub.recent(GENERAL).map(m => m.id)).toEqual([...OLD, LIVE])
    })

    it('should keep the newest message when history overflows the buffer', () => {
      const hub = createHub(3)

      hub.publish(makeMsg(LIVE))
      for (const id of OLD) hub.publish(makeMsg(id))

      expect(hub.recent(GENERAL).map(m => m.id)).toEqual([OLD[1], OLD[2], LIVE])
    })

    it('should not store or send a message older than a full buffer', () => {
      const hub = createHub(2)
      hub.publish(makeMsg(OLD[1]))
      hub.publish(makeMsg(OLD[2]))
      const fn = mock(() => {})
      hub.subscribe(GENERAL, fn)

      hub.publish(makeMsg(OLD[0]))

      expect(fn).not.toHaveBeenCalled()
      expect(hub.recent(GENERAL).map(m => m.id)).toEqual([OLD[1], OLD[2]])
    })
  })

  describe('when a message is published', () => {
    it('should deliver it to subscribers of its channel when they are subscribed', () => {
      const hub = createHub()
      const fn = mock()
      hub.subscribe(GENERAL, fn)
      const msg = makeMsg('1302000000000000001')

      hub.publish(msg)

      expect(fn).toHaveBeenCalledTimes(1)
      expect(fn).toHaveBeenCalledWith(msg)
    })

    it("should add it to the channel's recent messages when published", () => {
      const hub = createHub()
      const msg = makeMsg('1302000000000000001')

      hub.publish(msg)

      expect(hub.recent(GENERAL)).toEqual([msg])
    })
  })

  describe('when the same ID is published twice', () => {
    it('should keep one copy when the IDs match', () => {
      const hub = createHub()
      hub.publish(makeMsg('1302000000000000001'))
      hub.publish(makeMsg('1302000000000000001'))

      expect(hub.recent(GENERAL)).toHaveLength(1)
    })

    it('should notify subscribers once when the IDs match', () => {
      const hub = createHub()
      const fn = mock()
      hub.subscribe(GENERAL, fn)

      hub.publish(makeMsg('1302000000000000001'))
      hub.publish(makeMsg('1302000000000000001'))

      expect(fn).toHaveBeenCalledTimes(1)
    })
  })

  describe('when the buffer is full', () => {
    it('should drop the oldest message when a new one is published', () => {
      const hub = createHub(3)
      for (const id of ['1302000000000000001', '1302000000000000002', '1302000000000000003', '1302000000000000004']) {
        hub.publish(makeMsg(id))
      }

      expect(hub.recent(GENERAL).map(m => m.id)).toEqual(['1302000000000000002', '1302000000000000003', '1302000000000000004'])
    })
  })

  describe('when a subscriber unsubscribes', () => {
    it('should stop receiving messages when unsubscribed', () => {
      const hub = createHub()
      const fn = mock()
      const unsubscribe = hub.subscribe(GENERAL, fn)

      unsubscribe()
      hub.publish(makeMsg('1302000000000000001'))

      expect(fn).not.toHaveBeenCalled()
    })

    it('should not throw or remove other subscribers when unsubscribe is called twice', () => {
      const hub = createHub()
      const other = mock()
      const unsubscribe = hub.subscribe(GENERAL, mock())
      hub.subscribe(GENERAL, other)

      unsubscribe()
      expect(() => unsubscribe()).not.toThrow()
      hub.publish(makeMsg('1302000000000000001'))

      expect(other).toHaveBeenCalledTimes(1)
    })
  })

  describe('when a subscriber throws', () => {
    it('should still deliver to the other subscribers when one throws', () => {
      const hub = createHub()
      const healthy = mock()
      hub.subscribe(GENERAL, () => {
        throw new Error('stream already closed')
      })
      hub.subscribe(GENERAL, healthy)

      hub.publish(makeMsg('1302000000000000001'))

      expect(healthy).toHaveBeenCalledTimes(1)
    })
  })

  describe('when messages belong to different channels', () => {
    it('should keep subscribers and buffers apart when channels differ', () => {
      const hub = createHub()
      const generalFn = mock()
      const randomFn = mock()
      hub.subscribe(GENERAL, generalFn)
      hub.subscribe(RANDOM, randomFn)
      const general = makeMsg('1302000000000000001')
      const random = makeMsg('1302000000000000002', { channelId: RANDOM })

      hub.publish(general)
      hub.publish(random)

      expect(generalFn).toHaveBeenCalledWith(general)
      expect(generalFn).toHaveBeenCalledTimes(1)
      expect(randomFn).toHaveBeenCalledWith(random)
      expect(randomFn).toHaveBeenCalledTimes(1)
      expect(hub.recent(GENERAL)).toEqual([general])
      expect(hub.recent(RANDOM)).toEqual([random])
    })
  })

  describe('when recent messages are read', () => {
    it('should return a copy when the caller changes the result', () => {
      const hub = createHub()
      hub.publish(makeMsg('1302000000000000001'))

      hub.recent(GENERAL).pop()

      expect(hub.recent(GENERAL)).toHaveLength(1)
    })

    it('should return an empty list when the channel has no messages', () => {
      expect(createHub().recent(GENERAL)).toEqual([])
    })
  })

  describe('when subscribers come and go', () => {
    it('should report the current count across channels when asked', () => {
      const hub = createHub()
      const unsubscribe = hub.subscribe(GENERAL, mock())
      hub.subscribe(GENERAL, mock())
      hub.subscribe(RANDOM, mock())
      expect(hub.subscriberCount()).toBe(3)

      unsubscribe()

      expect(hub.subscriberCount()).toBe(2)
    })
  })
})
