import { describe, expect, it } from 'vitest'
import { formatCardDisplay } from '../src/ui/components/Card'

describe('formatCardDisplay', () => {
  it('renders ten as 10', () => {
    expect(formatCardDisplay('TS')).toBe('10♠')
    expect(formatCardDisplay('TH')).toBe('10♥')
  })

  it('keeps non-ten ranks unchanged', () => {
    expect(formatCardDisplay('AS')).toBe('A♠')
    expect(formatCardDisplay('9D')).toBe('9♦')
  })
})
