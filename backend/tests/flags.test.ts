import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { flags } from 'railway'
import { DEFAULT_FLAGS, startFlags } from '../flags.ts'

describe('startFlags', () => {
  describe('when there is no Railway token', () => {
    it('should resolve to a reader that returns the defaults when the SDK cannot start', async () => {
      const read = await startFlags({})

      expect(read()).toEqual(DEFAULT_FLAGS)
      expect(DEFAULT_FLAGS).toEqual({ attachments: false, editsDeletes: false, debugPanel: false })
    })
  })

  describe('when the SDK has started', () => {
    const spies: Array<{ mockRestore: () => void }> = []
    afterEach(() => {
      for (const spy of spies.splice(0)) spy.mockRestore()
    })
    const start = (getBoolean: (name: string) => boolean) => {
      spies.push(
        spyOn(console, 'log').mockImplementation(() => {}),
        spyOn(flags, 'init').mockResolvedValue(undefined as never),
        spyOn(flags, 'list').mockReturnValue([]),
        spyOn(flags, 'getBoolean').mockImplementation(getBoolean),
      )
      return startFlags({ RAILWAY_TOKEN: 'project-token' })
    }

    it('should read each flag from Railway', async () => {
      const read = await start(name => name === 'edits-deletes')

      expect(read()).toEqual({ attachments: false, editsDeletes: true, debugPanel: false })
    })

    it('should fall back to the defaults instead of throwing, because event listeners read flags', async () => {
      const read = await start(() => {
        throw new Error('flags not ready')
      })

      expect(read()).toEqual(DEFAULT_FLAGS)
    })
  })
})
