import { SignalingClient, SignalEvent, SignalMessage } from './signaling'
import { MeshNetwork, PeerConnection, SignalPayload } from './webrtc'
import { NetMessage, isNetMessage } from './protocol'

export type RoomClientOptions = {
  signalingUrl: string
  roomId: string
  clientId: string
  onMessage: (fromId: string, message: NetMessage) => void
  onPeerJoined?: (peerId: string) => void
  onPeerList?: (peerIds: string[]) => void
  onPeerConnected?: (peerId: string) => void
  onPeerDisconnected?: (peerId: string) => void
  onConnectionError?: (message: string) => void
}

export type SignalingClientLike = {
  connect: (onEvent: (event: SignalEvent) => void) => void
  send: (message: SignalMessage) => void
  disconnect?: () => void
}

export type MeshNetworkLike = {
  createPeer: (id: string, isInitiator: boolean) => PeerConnection
  getPeer: (id: string) => PeerConnection | undefined
  createOffer: (id: string) => Promise<void>
  handleSignal: (id: string, payload: SignalPayload) => Promise<void>
  broadcast: (data: unknown) => void
  sendTo: (peerId: string, data: unknown) => boolean
  hasOpenChannel: (peerId: string) => boolean
  destroy?: () => void
}

type PendingAck = {
  message: NetMessage
  timerId: ReturnType<typeof setTimeout>
  retryIndex: number
  startedAt: number
}

const ACK_RETRY_DELAYS = [1000, 2000, 4000, 8000, 15000] as const

export class RoomClient {
  private signaling: SignalingClientLike
  private mesh: MeshNetworkLike
  private knownPeers = new Set<string>()
  private pendingAcks = new Map<string, Map<string, PendingAck>>()
  private offerRetryCount = new Map<string, number>()
  private readonly maxOfferRetries = 3
  private destroyed = false

  constructor(private options: RoomClientOptions, deps?: { signaling?: SignalingClientLike; mesh?: MeshNetworkLike }) {
    this.signaling = deps?.signaling ?? new SignalingClient(options.signalingUrl, options.roomId)
    this.mesh =
      deps?.mesh ??
      new MeshNetwork({
      onPeerData: (peerId, data) => {
        if (isNetMessage(data)) {
          this.handleIncomingMessage(peerId, data)
        }
      },
      onPeerConnected: options.onPeerConnected,
      onPeerDisconnected: (peerId) => {
        this.clearPendingAcksForPeer(peerId)
        options.onPeerDisconnected?.(peerId)
      },
      onSignal: (peerId, payload) => {
        this.signaling.send({
          type: 'signal',
          roomId: options.roomId,
          targetId: peerId,
          payload
        })
      }
    })
  }

  connect(asHost: boolean) {
    this.signaling.connect((event) => this.handleSignalEvent(event))
    if (asHost) {
      console.debug('[signal] createRoom', this.options.roomId)
      this.signaling.send({ type: 'createRoom', roomId: this.options.roomId, clientId: this.options.clientId })
    } else {
      console.debug('[signal] joinRoom', this.options.roomId)
      this.signaling.send({ type: 'joinRoom', roomId: this.options.roomId, clientId: this.options.clientId })
    }
  }

  send(message: NetMessage) {
    this.mesh.broadcast(message)
    // Relay when any known peer lacks a direct channel, or when no peers known yet
    let needsRelay = this.knownPeers.size === 0
    if (!needsRelay) {
      for (const peerId of this.knownPeers) {
        if (!this.mesh.hasOpenChannel(peerId)) {
          needsRelay = true
          break
        }
      }
    }
    if (needsRelay) {
      this.signaling.send({ type: 'relay', roomId: this.options.roomId, payload: message })
    }
    if (message.type === 'action' && this.knownPeers.size > 0) {
      this.trackAction(message)
    }
  }

  sendTo(peerId: string, message: NetMessage) {
    const sent = this.mesh.sendTo(peerId, message)
    if (!sent) {
      this.signaling.send({ type: 'relayTo', roomId: this.options.roomId, targetId: peerId, payload: message })
    }
  }

  destroy() {
    this.destroyed = true
    for (const [, peerMap] of this.pendingAcks) {
      for (const [, pending] of peerMap) {
        clearTimeout(pending.timerId)
      }
    }
    this.pendingAcks.clear()
    this.signaling.disconnect?.()
    this.mesh.destroy?.()
  }

  private handleIncomingMessage(fromId: string, message: NetMessage) {
    if (this.destroyed) return
    if (message.type === 'ack') {
      this.handleAck(message.actionId, fromId)
      return
    }
    if (message.type === 'action') {
      this.sendTo(fromId, { type: 'ack', actionId: message.action.id, receiverId: this.options.clientId })
    }
    this.options.onMessage(fromId, message)
  }

  private handleSignalEvent(event: SignalEvent) {
    if (this.destroyed) return
    if (event.type === 'peerJoined') {
      if (event.clientId === this.options.clientId) return
      this.options.onPeerJoined?.(event.clientId)
      this.ensurePeer(event.clientId)
      return
    }

    if (event.type === 'peerList') {
      const others = event.clientIds.filter((peerId) => peerId !== this.options.clientId)
      this.options.onPeerList?.(others)
      others.forEach((peerId) => {
        this.options.onPeerJoined?.(peerId)
        this.ensurePeer(peerId)
      })
      return
    }

    if (event.type === 'signal') {
      if (event.fromId === this.options.clientId) return
      if (!isSignalPayload(event.payload)) return
      const payload = event.payload
      this.knownPeers.add(event.fromId)
      let peer = this.mesh.getPeer(event.fromId)
      if (!peer) {
        const initiator = this.options.clientId < event.fromId
        peer = this.mesh.createPeer(event.fromId, initiator)
      }
      void this.mesh.handleSignal(event.fromId, payload).catch((error) => {
        console.warn('[signal] failed to handle signal', event.fromId, error)
      })
      return
    }

    if (event.type === 'relay') {
      if (event.fromId === this.options.clientId) return
      if (isNetMessage(event.payload)) {
        this.handleIncomingMessage(event.fromId, event.payload)
      }
      return
    }

    if (event.type === 'error') {
      this.options.onConnectionError?.(event.message)
    }
  }

  private ensurePeer(peerId: string) {
    this.knownPeers.add(peerId)
    if (this.mesh.getPeer(peerId)) return
    const initiator = this.options.clientId < peerId
    const peer = this.mesh.createPeer(peerId, initiator)
    if (initiator) {
      this.offerRetryCount.set(peerId, 0)
      this.tryCreateOffer(peer.id)
    }
  }

  private tryCreateOffer(peerId: string) {
    void this.mesh.createOffer(peerId).catch((error) => {
      const attempts = (this.offerRetryCount.get(peerId) ?? 0) + 1
      if (attempts > this.maxOfferRetries) {
        console.warn('[signal] offer retries exhausted', peerId, error)
        return
      }
      this.offerRetryCount.set(peerId, attempts)
      const delayMs = 200 * attempts
      globalThis.setTimeout(() => this.tryCreateOffer(peerId), delayMs)
    })
  }

  private trackAction(message: NetMessage & { type: 'action' }) {
    const actionId = message.action.id
    const peerMap = new Map<string, PendingAck>()
    for (const peerId of this.knownPeers) {
      const pending: PendingAck = {
        message,
        timerId: this.scheduleRetry(actionId, peerId, 0),
        retryIndex: 0,
        startedAt: Date.now()
      }
      peerMap.set(peerId, pending)
    }
    this.pendingAcks.set(actionId, peerMap)
  }

  private scheduleRetry(actionId: string, peerId: string, retryIndex: number): ReturnType<typeof setTimeout> {
    const delay = ACK_RETRY_DELAYS[retryIndex]
    if (delay === undefined) {
      return globalThis.setTimeout(() => {
        this.clearPendingAck(actionId, peerId)
        this.triggerSyncFallback(peerId)
      }, 0)
    }
    return globalThis.setTimeout(() => {
      const peerMap = this.pendingAcks.get(actionId)
      const pending = peerMap?.get(peerId)
      if (!pending) return

      this.sendTo(peerId, pending.message)
      const nextIndex = retryIndex + 1
      pending.retryIndex = nextIndex
      pending.timerId = this.scheduleRetry(actionId, peerId, nextIndex)
    }, delay)
  }

  private triggerSyncFallback(peerId: string) {
    const requestId = `sync-ack-${this.options.clientId}-${Date.now()}`
    this.sendTo(peerId, { type: 'syncRequest', requestId })
  }

  private handleAck(actionId: string, fromPeerId: string) {
    this.clearPendingAck(actionId, fromPeerId)
  }

  private clearPendingAck(actionId: string, peerId: string) {
    const peerMap = this.pendingAcks.get(actionId)
    if (!peerMap) return
    const pending = peerMap.get(peerId)
    if (pending) {
      clearTimeout(pending.timerId)
      peerMap.delete(peerId)
    }
    if (peerMap.size === 0) {
      this.pendingAcks.delete(actionId)
    }
  }

  private clearPendingAcksForPeer(peerId: string) {
    for (const [actionId, peerMap] of this.pendingAcks) {
      const pending = peerMap.get(peerId)
      if (pending) {
        clearTimeout(pending.timerId)
        peerMap.delete(peerId)
      }
      if (peerMap.size === 0) {
        this.pendingAcks.delete(actionId)
      }
    }
  }
}

function isSignalPayload(payload: unknown): payload is SignalPayload {
  if (typeof payload !== 'object' || payload === null) return false
  if (!('type' in payload)) return false
  const type = (payload as { type?: unknown }).type
  if (type === 'offer' || type === 'answer') {
    return typeof (payload as { sdp?: unknown }).sdp === 'string'
  }
  if (type === 'candidate') {
    return 'candidate' in (payload as Record<string, unknown>)
  }
  return false
}
