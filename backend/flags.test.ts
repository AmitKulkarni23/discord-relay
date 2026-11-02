import { describe, expect, it } from 'bun:test'
import { DEFAULT_FLAGS, startFlags } from './flags.ts'

describe('startFlags', () => {
  describe('when there is no Railway token', () => {
    it('should resolve to a reader that returns the defaults when the SDK cannot start', async () => {
      const read = await startFlags({})

      expect(read()).toEqual(DEFAULT_FLAGS)
      expect(DEFAULT_FLAGS).toEqual({ attachments: false, editsDeletes: false, debugPanel: false })
    })
  })
})
