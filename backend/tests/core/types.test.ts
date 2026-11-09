import { describe, expect, it } from 'bun:test'
import { compareIds } from '../../core/types.ts'

describe('compareIds', () => {
  describe('when snowflakes have different lengths', () => {
    it('should order the shorter ID first when compared as numbers', () => {
      expect(compareIds('999999999999999999', '1000000000000000000')).toBeLessThan(0)
    })
  })

  describe('when snowflakes have the same length', () => {
    it('should order by digits when lengths match', () => {
      expect(compareIds('1566588496691400002', '1566588496691400001')).toBeGreaterThan(0)
      expect(compareIds('1566588496691400001', '1566588496691400001')).toBe(0)
    })
  })
})
