import { describe, expect, it, vi } from 'vitest'
import { RoomClient, MeshNetworkLike, SignalingClientLike } from '../src/net/roomClient'
import type { SignalEvent, SignalMessage } from '../src/net/signaling'

class FakeSignaling implements SignalingClientLike {
  sent: SignalMessage[] = []
  handler?: (event: SignalEvent) => void
  disconnected = false

  connect(onEvent: (event: SignalEvent) => void) {
    this.handler = onEvent
  }

  send(message: SignalMessage) {
    this.sent.push(message)
  }

  disconnect() {
    this.disconnected = true
  }

  emit(event: SignalEvent) {
    this.handler?.(event)
  }
}

class FakeMesh implements MeshNetworkLike {
  peers = new Map<string, { id: string; initiator: boolean }>()
  offers: string[] = []
  signals: Array<{ id: string; type: string }> = []
  created: Array<{ id: string; initiator: boolean }> = []
  broadcasts: unknown[] = []
  sentTo: Array<{ peerId: string; data: unknown }> = []
  offerFailures = 0
  openChannels = new Set<string>()
  destroyed = false

  createPeer(id: string, isInitiator: boolean) {
    const peer = { id, initiator: isInitiator }
    this.created.push(peer)
    this.peers.set(id, peer)
    return { id, connection: {} as RTCPeerConnection }
  }

  getPeer(id: string) {
    const peer = this.peers.get(id)
    return peer ? ({ id, connection: {} as RTCPeerConnection } as const) : undefined
  }

  async createOffer(id: string) {
    if (this.offerFailures > 0) {
      this.offerFailures -= 1
      throw new Error('offer failed')
    }
    this.offers.push(id)
  }

  async handleSignal(id: string, payload: { type: string }) {
    this.signals.push({ id, type: payload.type })
  }

  broadcast(data: unknown) {
    this.broadcasts.push(data)
  }

  sendTo(peerId: string, data: unknown): boolean {
    this.sentTo.push({ peerId, data })
    return this.openChannels.has(peerId)
  }

  hasOpenChannel(peerId: string): boolean {
    return this.openChannels.has(peerId)
  }

  destroy() {
    this.destroyed = true
  }
}

describe('RoomClient signaling', () => {
  it('sends createRoom when hosting', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage: () => undefined
      },
      { signaling, mesh }
    )

    client.connect(true)

    expect(signaling.sent[0]).toEqual({ type: 'createRoom', roomId: 'room', clientId: 'b' })
  })

  it('creates peers from peerList and initiates offers deterministically', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage: () => undefined
      },
      { signaling, mesh }
    )

    client.connect(false)
    signaling.emit({ type: 'peerList', clientIds: ['a', 'c'] })

    expect(mesh.peers.has('a')).toBe(true)
    expect(mesh.peers.has('c')).toBe(true)

    // b < c so b initiates offer to c, but not to a.
    expect(mesh.offers).toEqual(['c'])
  })

  it('filters local client id out of peerList', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const onPeerList = vi.fn()
    const onPeerJoined = vi.fn()
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage: () => undefined,
        onPeerList,
        onPeerJoined
      },
      { signaling, mesh }
    )

    client.connect(false)
    signaling.emit({ type: 'peerList', clientIds: ['b', 'c'] })

    expect(onPeerList).toHaveBeenCalledWith(['c'])
    expect(onPeerJoined).toHaveBeenCalledTimes(1)
    expect(onPeerJoined).toHaveBeenCalledWith('c')
    expect(mesh.peers.has('b')).toBe(false)
    expect(mesh.peers.has('c')).toBe(true)
  })

  it('creates peer on signal when missing', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage: () => undefined
      },
      { signaling, mesh }
    )

    client.connect(false)
    signaling.emit({ type: 'signal', fromId: 'a', payload: { type: 'offer', sdp: 'x' } })

    expect(mesh.peers.has('a')).toBe(true)
    expect(mesh.signals[0]?.type).toBe('offer')
  })

  it('ignores signal events from local client id', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage: () => undefined
      },
      { signaling, mesh }
    )

    client.connect(false)
    signaling.emit({ type: 'signal', fromId: 'b', payload: { type: 'offer', sdp: 'x' } })

    expect(mesh.peers.size).toBe(0)
    expect(mesh.signals).toEqual([])
  })

  it('broadcasts via mesh and falls back to relay when no direct channel', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage: () => undefined
      },
      { signaling, mesh }
    )

    // Discover a peer so knownPeers is populated
    client.connect(false)
    signaling.emit({ type: 'peerJoined', clientId: 'c' })

    const message = { type: 'presence', playerId: 'p1' } as const
    client.send(message)

    expect(mesh.broadcasts).toEqual([message])
    // Relay fires because peer 'c' has no open data channel
    const relaySent = signaling.sent.find((m) => m.type === 'relay')
    expect(relaySent).toEqual({ type: 'relay', roomId: 'room', payload: message })
  })

  it('skips relay when all peers have open data channels', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage: () => undefined
      },
      { signaling, mesh }
    )

    client.connect(false)
    signaling.emit({ type: 'peerJoined', clientId: 'c' })
    mesh.openChannels.add('c')

    const message = { type: 'presence', playerId: 'p1' } as const
    client.send(message)

    expect(mesh.broadcasts).toEqual([message])
    const relaySent = signaling.sent.find((m) => m.type === 'relay')
    expect(relaySent).toBeUndefined()
  })

  it('sends direct message and falls back to relay when channel closed', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage: () => undefined
      },
      { signaling, mesh }
    )

    const message = { type: 'presence', playerId: 'p2' } as const
    client.sendTo('peer-1', message)

    expect(mesh.sentTo).toEqual([{ peerId: 'peer-1', data: message }])
    // sendTo returned false (no open channel), so relay fires
    expect(signaling.sent[0]).toEqual({ type: 'relayTo', roomId: 'room', targetId: 'peer-1', payload: message })
  })

  it('skips relay on sendTo when direct channel is open', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    mesh.openChannels.add('peer-1')
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage: () => undefined
      },
      { signaling, mesh }
    )

    const message = { type: 'presence', playerId: 'p2' } as const
    client.sendTo('peer-1', message)

    expect(mesh.sentTo).toEqual([{ peerId: 'peer-1', data: message }])
    expect(signaling.sent).toEqual([])
  })

  it('disconnects signaling and mesh on destroy', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage: () => undefined
      },
      { signaling, mesh }
    )

    client.destroy()

    expect(signaling.disconnected).toBe(true)
    expect(mesh.destroyed).toBe(true)
  })

  it('initiates offer on peerJoined when deterministically the initiator', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const onPeerJoined = vi.fn()
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage: () => undefined,
        onPeerJoined
      },
      { signaling, mesh }
    )

    client.connect(false)
    signaling.emit({ type: 'peerJoined', clientId: 'c' })

    expect(onPeerJoined).toHaveBeenCalledWith('c')
    expect(mesh.offers).toEqual(['c'])
  })

  it('does not recreate existing peer on peerJoined', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage: () => undefined
      },
      { signaling, mesh }
    )

    mesh.createPeer('a', true)
    client.connect(false)
    signaling.emit({ type: 'peerJoined', clientId: 'a' })

    expect(mesh.created.filter((peer) => peer.id === 'a')).toHaveLength(1)
  })

  it('ignores relay payloads that are not NetMessage', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const onMessage = vi.fn()
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage
      },
      { signaling, mesh }
    )

    client.connect(false)
    signaling.emit({ type: 'relay', fromId: 'a', payload: { nope: true } })

    expect(onMessage).not.toHaveBeenCalled()
  })

  it('ignores malformed signal payloads', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const client = new RoomClient(
      {
        signalingUrl: 'ws://test',
        roomId: 'room',
        clientId: 'b',
        onMessage: () => undefined
      },
      { signaling, mesh }
    )

    client.connect(false)
    signaling.emit({ type: 'signal', fromId: 'a', payload: { bad: true } })

    expect(mesh.signals).toEqual([])
  })

  it('retries offer creation when initial attempt fails', async () => {
    vi.useFakeTimers()
    try {
      const signaling = new FakeSignaling()
      const mesh = new FakeMesh()
      mesh.offerFailures = 1
      const client = new RoomClient(
        {
          signalingUrl: 'ws://test',
          roomId: 'room',
          clientId: 'b',
          onMessage: () => undefined
        },
        { signaling, mesh }
      )

      client.connect(false)
      signaling.emit({ type: 'peerJoined', clientId: 'c' })

      await vi.advanceTimersByTimeAsync(250)
      expect(mesh.offers).toEqual(['c'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('RoomClient ACK system', () => {
  it('sends ack back when receiving an action via relay', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const onMessage = vi.fn()
    const client = new RoomClient(
      { signalingUrl: 'ws://test', roomId: 'room', clientId: 'b', onMessage },
      { signaling, mesh }
    )

    client.connect(false)
    signaling.emit({
      type: 'relay',
      fromId: 'a',
      payload: { type: 'action', action: { id: 'a1', type: 'ready', playerId: 'a' } }
    })

    expect(onMessage).toHaveBeenCalledTimes(1)
    const ackSent = mesh.sentTo.find((m) => (m.data as { type: string }).type === 'ack')
      ?? signaling.sent.find((m) => m.type === 'relayTo' && (m as { payload: { type: string } }).payload.type === 'ack')
    expect(ackSent).toBeTruthy()
  })

  it('does not forward ack messages to onMessage', () => {
    const signaling = new FakeSignaling()
    const mesh = new FakeMesh()
    const onMessage = vi.fn()
    const client = new RoomClient(
      { signalingUrl: 'ws://test', roomId: 'room', clientId: 'b', onMessage },
      { signaling, mesh }
    )

    client.connect(false)
    signaling.emit({
      type: 'relay',
      fromId: 'a',
      payload: { type: 'ack', actionId: 'a1', receiverId: 'a' }
    })

    expect(onMessage).not.toHaveBeenCalled()
  })

  it('tracks pending acks when sending an action with known peers', async () => {
    vi.useFakeTimers()
    try {
      const signaling = new FakeSignaling()
      const mesh = new FakeMesh()
      const client = new RoomClient(
        { signalingUrl: 'ws://test', roomId: 'room', clientId: 'b', onMessage: () => undefined },
        { signaling, mesh }
      )

      client.connect(false)
      signaling.emit({ type: 'peerJoined', clientId: 'c' })
      mesh.sentTo = []
      signaling.sent = []

      const action = { type: 'action', action: { id: 'act-1', type: 'ready', playerId: 'b' } } as const
      client.send(action)

      // After 1s, first retry fires targeting peer 'c'
      await vi.advanceTimersByTimeAsync(1000)
      const retries = mesh.sentTo.filter((m) => (m.data as { type: string }).type === 'action' && m.peerId === 'c')
      expect(retries.length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops retrying after receiving an ack', async () => {
    vi.useFakeTimers()
    try {
      const signaling = new FakeSignaling()
      const mesh = new FakeMesh()
      const client = new RoomClient(
        { signalingUrl: 'ws://test', roomId: 'room', clientId: 'b', onMessage: () => undefined },
        { signaling, mesh }
      )

      client.connect(false)
      signaling.emit({ type: 'peerJoined', clientId: 'c' })

      const action = { type: 'action', action: { id: 'act-2', type: 'ready', playerId: 'b' } } as const
      client.send(action)

      // Simulate ack from peer 'c'
      signaling.emit({
        type: 'relay',
        fromId: 'c',
        payload: { type: 'ack', actionId: 'act-2', receiverId: 'c' }
      })

      mesh.sentTo = []
      signaling.sent = []

      // Advance past all retry intervals - no retries should fire
      await vi.advanceTimersByTimeAsync(30000)
      const retries = mesh.sentTo.filter((m) => (m.data as { type: string }).type === 'action')
      expect(retries).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to syncRequest after all retries exhausted', async () => {
    vi.useFakeTimers()
    try {
      const signaling = new FakeSignaling()
      const mesh = new FakeMesh()
      const client = new RoomClient(
        { signalingUrl: 'ws://test', roomId: 'room', clientId: 'b', onMessage: () => undefined },
        { signaling, mesh }
      )

      client.connect(false)
      signaling.emit({ type: 'peerJoined', clientId: 'c' })

      const action = { type: 'action', action: { id: 'act-3', type: 'ready', playerId: 'b' } } as const
      client.send(action)

      // Advance through all retries: 1s + 2s + 4s + 8s + 15s + final 0ms
      await vi.advanceTimersByTimeAsync(31000)

      // Should have sent a syncRequest to peer 'c'
      const syncSent = signaling.sent.filter(
        (m) => m.type === 'relayTo' && (m as { payload: { type: string } }).payload.type === 'syncRequest'
      )
      expect(syncSent.length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears pending acks on destroy', async () => {
    vi.useFakeTimers()
    try {
      const signaling = new FakeSignaling()
      const mesh = new FakeMesh()
      const client = new RoomClient(
        { signalingUrl: 'ws://test', roomId: 'room', clientId: 'b', onMessage: () => undefined },
        { signaling, mesh }
      )

      client.connect(false)
      signaling.emit({ type: 'peerJoined', clientId: 'c' })

      client.send({ type: 'action', action: { id: 'act-4', type: 'ready', playerId: 'b' } })
      client.destroy()

      mesh.sentTo = []
      signaling.sent = []

      await vi.advanceTimersByTimeAsync(31000)
      const retries = mesh.sentTo.filter((m) => (m.data as { type: string }).type === 'action')
      expect(retries).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not track acks for non-action messages', () => {
    vi.useFakeTimers()
    try {
      const signaling = new FakeSignaling()
      const mesh = new FakeMesh()
      const client = new RoomClient(
        { signalingUrl: 'ws://test', roomId: 'room', clientId: 'b', onMessage: () => undefined },
        { signaling, mesh }
      )

      client.connect(false)
      signaling.emit({ type: 'peerJoined', clientId: 'c' })
      mesh.sentTo = []
      signaling.sent = []

      client.send({ type: 'presence', playerId: 'b' })

      // No retries should be scheduled
      vi.advanceTimersByTime(5000)
      const retries = mesh.sentTo.filter((m) => (m.data as { type: string }).type === 'presence')
      expect(retries).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries with exponential backoff timing', async () => {
    vi.useFakeTimers()
    try {
      const signaling = new FakeSignaling()
      const mesh = new FakeMesh()
      const client = new RoomClient(
        { signalingUrl: 'ws://test', roomId: 'room', clientId: 'b', onMessage: () => undefined },
        { signaling, mesh }
      )

      client.connect(false)
      signaling.emit({ type: 'peerJoined', clientId: 'c' })
      mesh.sentTo = []

      client.send({ type: 'action', action: { id: 'act-5', type: 'ready', playerId: 'b' } })

      const countRetries = () => mesh.sentTo.filter((m) => (m.data as { type: string }).type === 'action').length

      expect(countRetries()).toBe(0) // no retries yet

      await vi.advanceTimersByTimeAsync(1000) // 1s: first retry
      expect(countRetries()).toBe(1)

      await vi.advanceTimersByTimeAsync(2000) // +2s: second retry
      expect(countRetries()).toBe(2)

      await vi.advanceTimersByTimeAsync(4000) // +4s: third retry
      expect(countRetries()).toBe(3)

      await vi.advanceTimersByTimeAsync(8000) // +8s: fourth retry
      expect(countRetries()).toBe(4)

      await vi.advanceTimersByTimeAsync(15000) // +15s: fifth retry
      expect(countRetries()).toBe(5)
    } finally {
      vi.useRealTimers()
    }
  })
})
