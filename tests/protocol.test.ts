import { describe, expect, it } from 'vitest'
import { isNetMessage } from '../src/net/protocol'

describe('isNetMessage', () => {
  it('accepts valid NetMessage types', () => {
    expect(isNetMessage({ type: 'action', action: {} })).toBe(true)
    expect(isNetMessage({ type: 'ack', actionId: 'a1', receiverId: 'p1' })).toBe(true)
    expect(isNetMessage({ type: 'syncRequest', requestId: 'r1' })).toBe(true)
    expect(isNetMessage({ type: 'syncResponse', requestId: 'r1', log: [] })).toBe(true)
    expect(isNetMessage({ type: 'presence', playerId: 'p1' })).toBe(true)
  })

  it('rejects WebRTC signal payloads that are not game messages', () => {
    expect(isNetMessage({ type: 'offer', sdp: 'v=0...' })).toBe(false)
    expect(isNetMessage({ type: 'answer', sdp: 'v=0...' })).toBe(false)
    expect(isNetMessage({ type: 'candidate', candidate: 'c1' })).toBe(false)
  })

  it('rejects non-object values', () => {
    expect(isNetMessage(null)).toBe(false)
    expect(isNetMessage(undefined)).toBe(false)
    expect(isNetMessage('string')).toBe(false)
    expect(isNetMessage(42)).toBe(false)
  })

  it('rejects objects without a type field', () => {
    expect(isNetMessage({ data: 'hello' })).toBe(false)
    expect(isNetMessage({})).toBe(false)
  })

  it('rejects unknown type values', () => {
    expect(isNetMessage({ type: 'unknown' })).toBe(false)
    expect(isNetMessage({ type: 'signal' })).toBe(false)
    expect(isNetMessage({ type: 'relay' })).toBe(false)
  })
})
