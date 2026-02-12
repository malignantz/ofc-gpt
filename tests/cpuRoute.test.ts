import { describe, expect, it } from 'vitest'
import { resolveRoute } from '../src/ui/utils/routeResolution'

describe('resolveRoute', () => {
  it('resolves /cpu to cpu mode', () => {
    expect(resolveRoute('/cpu', new URLSearchParams())).toEqual({ kind: 'cpu' })
  })

  it('resolves /CPU to cpu mode case-insensitively', () => {
    expect(resolveRoute('/CPU', new URLSearchParams())).toEqual({ kind: 'cpu' })
  })

  it('resolves root to lobby', () => {
    expect(resolveRoute('/', new URLSearchParams())).toEqual({ kind: 'lobby' })
  })

  it('resolves pathname room to room route', () => {
    expect(resolveRoute('/my-room', new URLSearchParams())).toEqual({ kind: 'room', room: 'my-room', join: false })
  })

  it('resolves query room and join flag', () => {
    expect(resolveRoute('/', new URLSearchParams('room=abc&join=1'))).toEqual({ kind: 'room', room: 'abc', join: true })
  })

  it('prefers /cpu pathname over room query param', () => {
    expect(resolveRoute('/cpu', new URLSearchParams('room=other'))).toEqual({ kind: 'cpu' })
  })
})
