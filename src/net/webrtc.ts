import { describePayload, estimatePayloadBytes, logTransportUsage } from '../utils/transportUsage'

export type PeerConnection = {
  id: string
  connection: RTCPeerConnection
  dataChannel?: RTCDataChannel
  pendingCandidates?: RTCIceCandidateInit[]
}

export type SignalPayload =
  | { type: 'offer'; sdp: string }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit }

export type MeshEvents = {
  onPeerData: (peerId: string, data: unknown) => void
  onPeerConnected?: (peerId: string) => void
  onPeerDisconnected?: (peerId: string) => void
  onSignal: (peerId: string, payload: SignalPayload) => void
}

export function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
  const turnUrl = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TURN_URL
  const turnUsername = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TURN_USERNAME
  const turnCredential = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TURN_CREDENTIAL
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: turnUsername ?? '',
      credential: turnCredential ?? ''
    })
  }
  return servers
}

export class MeshNetwork {
  private peers = new Map<string, PeerConnection>()

  constructor(
    private events: MeshEvents,
    private config: RTCConfiguration = { iceServers: buildIceServers() }
  ) {}

  createPeer(id: string, isInitiator: boolean): PeerConnection {
    const connection = new RTCPeerConnection(this.config)
    const peer: PeerConnection = { id, connection, pendingCandidates: [] }
    this.peers.set(id, peer)

    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.events.onSignal(id, { type: 'candidate', candidate: event.candidate.toJSON() })
      }
    }

    connection.onconnectionstatechange = () => {
      if (connection.connectionState === 'connected') {
        this.events.onPeerConnected?.(id)
      }
      if (
        connection.connectionState === 'disconnected' ||
        connection.connectionState === 'closed' ||
        connection.connectionState === 'failed'
      ) {
        this.events.onPeerDisconnected?.(id)
      }
    }

    if (isInitiator) {
      peer.dataChannel = connection.createDataChannel('actions')
      this.attachChannel(peer)
    } else {
      connection.ondatachannel = (event) => {
        peer.dataChannel = event.channel
        this.attachChannel(peer)
      }
    }

    return peer
  }

  getPeer(id: string): PeerConnection | undefined {
    return this.peers.get(id)
  }

  async createOffer(id: string) {
    const peer = this.getPeer(id)
    if (!peer) throw new Error('Peer not found')
    const offer = await peer.connection.createOffer()
    await peer.connection.setLocalDescription(offer)
    this.events.onSignal(id, { type: 'offer', sdp: offer.sdp ?? '' })
  }

  async handleSignal(id: string, payload: SignalPayload) {
    const peer = this.getPeer(id)
    if (!peer) throw new Error('Peer not found')

    if (payload.type === 'offer') {
      await peer.connection.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
      await this.flushPendingCandidates(peer)
      const answer = await peer.connection.createAnswer()
      await peer.connection.setLocalDescription(answer)
      this.events.onSignal(id, { type: 'answer', sdp: answer.sdp ?? '' })
      return
    }

    if (payload.type === 'answer') {
      await peer.connection.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
      await this.flushPendingCandidates(peer)
      return
    }

    if (payload.type === 'candidate') {
      if (!peer.connection.remoteDescription) {
        peer.pendingCandidates?.push(payload.candidate)
        return
      }
      await this.addCandidate(peer, payload.candidate)
    }
  }

  broadcast(data: unknown) {
    const message = JSON.stringify(data)
    let deliveredCount = 0
    this.peers.forEach((peer) => {
      if (peer.dataChannel?.readyState === 'open') {
        peer.dataChannel.send(message)
        deliveredCount += 1
      }
    })
    if (deliveredCount > 0) {
      logTransportUsage({
        channel: 'webrtc',
        direction: 'outbound',
        description: `broadcast ${describePayload(data)} to ${deliveredCount} peer(s)`,
        bytes: estimatePayloadBytes(message) ?? 0,
        requestCount: deliveredCount
      })
    }
  }

  sendTo(peerId: string, data: unknown): boolean {
    const peer = this.peers.get(peerId)
    if (peer?.dataChannel?.readyState === 'open') {
      const message = JSON.stringify(data)
      peer.dataChannel.send(message)
      logTransportUsage({
        channel: 'webrtc',
        direction: 'outbound',
        description: `direct ${describePayload(data)} to ${peerId}`,
        bytes: estimatePayloadBytes(message) ?? 0
      })
      return true
    }
    return false
  }

  hasOpenChannel(peerId: string): boolean {
    const peer = this.peers.get(peerId)
    return peer?.dataChannel?.readyState === 'open' || false
  }

  destroy() {
    this.peers.forEach((peer) => {
      try {
        peer.dataChannel?.close()
      } catch {
        // Ignore close errors.
      }
      try {
        peer.connection.close()
      } catch {
        // Ignore close errors.
      }
    })
    this.peers.clear()
  }

  private attachChannel(peer: PeerConnection) {
    const channel = peer.dataChannel
    if (!channel) return
    channel.onmessage = (event) => {
      let parsed: unknown = event.data
      if (typeof event.data === 'string') {
        try {
          parsed = JSON.parse(event.data)
        } catch {
          parsed = event.data
        }
      }
      const bytes = estimatePayloadBytes(event.data)
      if (bytes !== null) {
        logTransportUsage({
          channel: 'webrtc',
          direction: 'inbound',
          description: `from ${peer.id} (${describePayload(parsed)})`,
          bytes
        })
      }
      this.events.onPeerData(peer.id, parsed)
    }
  }

  private async addCandidate(peer: PeerConnection, candidate: RTCIceCandidateInit) {
    try {
      await peer.connection.addIceCandidate(candidate)
    } catch {
      // Candidate delivery can race with remote description updates; retry later.
      peer.pendingCandidates?.push(candidate)
    }
  }

  private async flushPendingCandidates(peer: PeerConnection) {
    const queued = peer.pendingCandidates ?? []
    if (queued.length === 0) return
    peer.pendingCandidates = []
    for (const candidate of queued) {
      await this.addCandidate(peer, candidate)
    }
  }
}
