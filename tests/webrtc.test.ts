import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MeshNetwork } from '../src/net/webrtc'

class FakeDataChannel {
  sent: string[] = []
  readyState: RTCDataChannelState = 'open'
  onmessage?: (event: MessageEvent) => void

  constructor(public label: string) {}

  send(data: string) {
    this.sent.push(data)
  }

  emitMessage(data: unknown) {
    this.onmessage?.({ data } as MessageEvent)
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = []
  config?: RTCConfiguration
  connectionState: RTCPeerConnectionState = 'new'
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null
  localDescription?: RTCSessionDescriptionInit
  remoteDescription?: RTCSessionDescriptionInit
  createdDataChannel?: FakeDataChannel
  addedCandidates: RTCIceCandidateInit[] = []

  constructor(config?: RTCConfiguration) {
    this.config = config
    FakePeerConnection.instances.push(this)
  }

  createDataChannel(label: string) {
    const channel = new FakeDataChannel(label)
    this.createdDataChannel = channel
    return channel as unknown as RTCDataChannel
  }

  createOffer() {
    return Promise.resolve({ type: 'offer', sdp: 'offer-sdp' } as RTCSessionDescriptionInit)
  }

  createAnswer() {
    return Promise.resolve({ type: 'answer', sdp: 'answer-sdp' } as RTCSessionDescriptionInit)
  }

  setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description
    return Promise.resolve()
  }

  setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description
    return Promise.resolve()
  }

  addIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.remoteDescription) {
      return Promise.reject(new Error('Remote description not set'))
    }
    this.addedCandidates.push(candidate)
    return Promise.resolve()
  }

  emitIceCandidate(candidate: RTCIceCandidate) {
    this.onicecandidate?.({ candidate } as RTCPeerConnectionIceEvent)
  }

  emitConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }

  emitDataChannel(channel: FakeDataChannel) {
    this.ondatachannel?.({ channel } as unknown as RTCDataChannelEvent)
  }

  static reset() {
    FakePeerConnection.instances = []
  }
}

describe('MeshNetwork WebRTC flow', () => {
  let hadPeerConnection = false
  let originalPeerConnection: typeof RTCPeerConnection | undefined

  beforeEach(() => {
    hadPeerConnection = 'RTCPeerConnection' in globalThis
    originalPeerConnection = globalThis.RTCPeerConnection
    FakePeerConnection.reset()
    ;(globalThis as unknown as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection =
      FakePeerConnection as unknown as typeof RTCPeerConnection
  })

  afterEach(() => {
    if (hadPeerConnection) {
      ;(globalThis as unknown as { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection =
        originalPeerConnection as typeof RTCPeerConnection
    } else {
      delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection
    }
  })

  it('creates an initiator data channel and parses JSON payloads', () => {
    const onPeerData = vi.fn()
    const mesh = new MeshNetwork({ onPeerData, onSignal: vi.fn() })
    const peer = mesh.createPeer('peer-a', true)
    const connection = peer.connection as unknown as FakePeerConnection
    const channel = connection.createdDataChannel

    if (!channel) throw new Error('Expected data channel to be created for initiator')

    channel.emitMessage(JSON.stringify({ type: 'ping' }))
    channel.emitMessage('raw-text')

    expect(onPeerData).toHaveBeenCalledWith('peer-a', { type: 'ping' })
    expect(onPeerData).toHaveBeenLastCalledWith('peer-a', 'raw-text')
  })

  it('attaches incoming data channels for non-initiators', () => {
    const onPeerData = vi.fn()
    const mesh = new MeshNetwork({ onPeerData, onSignal: vi.fn() })
    const peer = mesh.createPeer('peer-b', false)
    const connection = peer.connection as unknown as FakePeerConnection
    const channel = new FakeDataChannel('actions')

    connection.emitDataChannel(channel)
    channel.emitMessage(JSON.stringify({ type: 'hello' }))

    expect(onPeerData).toHaveBeenCalledWith('peer-b', { type: 'hello' })
  })

  it('forwards ICE candidates via onSignal', () => {
    const onSignal = vi.fn()
    const mesh = new MeshNetwork({ onPeerData: () => undefined, onSignal })
    const peer = mesh.createPeer('peer-c', true)
    const connection = peer.connection as unknown as FakePeerConnection

    const candidate = {
      toJSON: () => ({ candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 })
    } as unknown as RTCIceCandidate

    connection.emitIceCandidate(candidate)

    expect(onSignal).toHaveBeenCalledWith('peer-c', {
      type: 'candidate',
      candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }
    })
  })

  it('emits connection state callbacks', () => {
    const onPeerConnected = vi.fn()
    const onPeerDisconnected = vi.fn()
    const mesh = new MeshNetwork({
      onPeerData: () => undefined,
      onSignal: () => undefined,
      onPeerConnected,
      onPeerDisconnected
    })
    const peer = mesh.createPeer('peer-d', true)
    const connection = peer.connection as unknown as FakePeerConnection

    connection.emitConnectionState('connected')
    connection.emitConnectionState('disconnected')
    connection.emitConnectionState('closed')
    connection.emitConnectionState('failed')

    expect(onPeerConnected).toHaveBeenCalledWith('peer-d')
    expect(onPeerDisconnected).toHaveBeenCalledTimes(3)
  })

  it('creates and signals an offer with local description', async () => {
    const onSignal = vi.fn()
    const mesh = new MeshNetwork({ onPeerData: () => undefined, onSignal })
    const peer = mesh.createPeer('peer-e', true)
    const connection = peer.connection as unknown as FakePeerConnection

    await mesh.createOffer('peer-e')

    expect(connection.localDescription?.type).toBe('offer')
    expect(onSignal).toHaveBeenCalledWith('peer-e', { type: 'offer', sdp: 'offer-sdp' })
  })

  it('handles incoming offer and responds with answer', async () => {
    const onSignal = vi.fn()
    const mesh = new MeshNetwork({ onPeerData: () => undefined, onSignal })
    const peer = mesh.createPeer('peer-f', false)
    const connection = peer.connection as unknown as FakePeerConnection

    await mesh.handleSignal('peer-f', { type: 'offer', sdp: 'remote-offer' })

    expect(connection.remoteDescription?.type).toBe('offer')
    expect(connection.localDescription?.type).toBe('answer')
    expect(onSignal).toHaveBeenCalledWith('peer-f', { type: 'answer', sdp: 'answer-sdp' })
  })

  it('handles answers without emitting new signals', async () => {
    const onSignal = vi.fn()
    const mesh = new MeshNetwork({ onPeerData: () => undefined, onSignal })
    const peer = mesh.createPeer('peer-g', true)
    const connection = peer.connection as unknown as FakePeerConnection

    await mesh.handleSignal('peer-g', { type: 'answer', sdp: 'remote-answer' })

    expect(connection.remoteDescription?.type).toBe('answer')
    expect(onSignal).not.toHaveBeenCalled()
  })

  it('queues ICE candidates until remote description exists', async () => {
    const onSignal = vi.fn()
    const mesh = new MeshNetwork({ onPeerData: () => undefined, onSignal })
    mesh.createPeer('peer-h', true)

    const candidate = { candidate: 'candidate:2', sdpMid: '0', sdpMLineIndex: 0 }
    await mesh.handleSignal('peer-h', { type: 'candidate', candidate })

    const peer = mesh.getPeer('peer-h')
    const connection = FakePeerConnection.instances[0]
    expect(connection?.addedCandidates).toEqual([])
    expect(peer?.pendingCandidates).toEqual([candidate])

    await mesh.handleSignal('peer-h', { type: 'answer', sdp: 'remote-answer' })
    expect(connection?.addedCandidates).toEqual([candidate])
    expect(peer?.pendingCandidates).toEqual([])
  })

  it('flushes queued candidates when handling an offer', async () => {
    const onSignal = vi.fn()
    const mesh = new MeshNetwork({ onPeerData: () => undefined, onSignal })
    mesh.createPeer('peer-i', false)
    const candidate = { candidate: 'candidate:3', sdpMid: '0', sdpMLineIndex: 0 }

    await mesh.handleSignal('peer-i', { type: 'candidate', candidate })
    await mesh.handleSignal('peer-i', { type: 'offer', sdp: 'remote-offer' })

    const connection = FakePeerConnection.instances[0]
    expect(connection?.addedCandidates).toEqual([candidate])
    expect(onSignal).toHaveBeenCalledWith('peer-i', { type: 'answer', sdp: 'answer-sdp' })
  })

  it('broadcasts only to open data channels', () => {
    const mesh = new MeshNetwork({ onPeerData: () => undefined, onSignal: () => undefined })
    const peerOpen = mesh.createPeer('peer-open', true)
    const peerClosed = mesh.createPeer('peer-closed', true)

    const openChannel = (peerOpen.connection as unknown as FakePeerConnection).createdDataChannel
    const closedChannel = (peerClosed.connection as unknown as FakePeerConnection).createdDataChannel

    if (!openChannel || !closedChannel) throw new Error('Expected data channels to be created')

    closedChannel.readyState = 'closed'
    mesh.broadcast({ type: 'ping' })

    expect(openChannel.sent).toHaveLength(1)
    expect(closedChannel.sent).toHaveLength(0)
  })

  it('sends to a specific peer when the channel is open', () => {
    const mesh = new MeshNetwork({ onPeerData: () => undefined, onSignal: () => undefined })
    const peer = mesh.createPeer('peer-target', true)
    const channel = (peer.connection as unknown as FakePeerConnection).createdDataChannel

    if (!channel) throw new Error('Expected data channel to be created')

    channel.readyState = 'open'
    mesh.sendTo('peer-target', { type: 'direct' })

    expect(channel.sent).toEqual([JSON.stringify({ type: 'direct' })])
  })

  it('sendTo returns true when channel is open, false when closed', () => {
    const mesh = new MeshNetwork({ onPeerData: () => undefined, onSignal: () => undefined })
    const peer = mesh.createPeer('peer-ret', true)
    const channel = (peer.connection as unknown as FakePeerConnection).createdDataChannel

    if (!channel) throw new Error('Expected data channel to be created')

    channel.readyState = 'closed'
    expect(mesh.sendTo('peer-ret', { type: 'test' })).toBe(false)

    channel.readyState = 'open'
    expect(mesh.sendTo('peer-ret', { type: 'test' })).toBe(true)
  })

  it('sendTo returns false for unknown peer', () => {
    const mesh = new MeshNetwork({ onPeerData: () => undefined, onSignal: () => undefined })
    expect(mesh.sendTo('unknown', { type: 'test' })).toBe(false)
  })

  it('hasOpenChannel returns correct state', () => {
    const mesh = new MeshNetwork({ onPeerData: () => undefined, onSignal: () => undefined })
    expect(mesh.hasOpenChannel('nonexistent')).toBe(false)

    const peer = mesh.createPeer('peer-ch', true)
    const channel = (peer.connection as unknown as FakePeerConnection).createdDataChannel
    if (!channel) throw new Error('Expected data channel to be created')

    channel.readyState = 'connecting'
    expect(mesh.hasOpenChannel('peer-ch')).toBe(false)

    channel.readyState = 'open'
    expect(mesh.hasOpenChannel('peer-ch')).toBe(true)
  })
})
