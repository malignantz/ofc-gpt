import { byteLengthUtf8, describePayload, describeSignalMessage, logTransportUsage } from '../utils/transportUsage'

export type SignalMessage =
  | { type: 'createRoom'; roomId: string; clientId: string }
  | { type: 'joinRoom'; roomId: string; clientId: string }
  | { type: 'signal'; roomId: string; targetId: string; payload: unknown }
  | { type: 'relayTo'; roomId: string; targetId: string; payload: unknown }
  | { type: 'relay'; roomId: string; payload: unknown }

export type SignalEvent =
  | { type: 'roomCreated'; roomId: string }
  | { type: 'peerList'; clientIds: string[] }
  | { type: 'peerJoined'; clientId: string }
  | { type: 'signal'; fromId: string; payload: unknown }
  | { type: 'relay'; fromId: string; payload: unknown }
  | { type: 'error'; message: string }

export class SignalingClient {
  private socket?: WebSocket
  private queue: SignalMessage[] = []
  private closedByClient = false

  constructor(private url: string, private roomId: string) {}

  connect(onEvent: (event: SignalEvent) => void) {
    this.closedByClient = false
    const url = new URL(this.url)
    url.searchParams.set('room', this.roomId)
    this.socket = new WebSocket(url.toString())
    this.socket.onopen = () => {
      console.debug('[signal] open', url.toString())
      this.queue.forEach((message) => {
        const serialized = JSON.stringify(message)
        this.socket?.send(serialized)
        logTransportUsage({
          channel: 'signaling',
          direction: 'outbound',
          description: `queued ${describeSignalMessage(message)}`,
          bytes: byteLengthUtf8(serialized)
        })
      })
      this.queue = []
    }
    this.socket.onmessage = (event) => {
      console.debug('[signal] message', event.data)
      if (typeof event.data !== 'string') return
      const parsedEvent = JSON.parse(event.data) as SignalEvent
      logTransportUsage({
        channel: 'signaling',
        direction: 'inbound',
        description: describeSignalEvent(parsedEvent),
        bytes: byteLengthUtf8(event.data)
      })
      onEvent(parsedEvent)
    }
    this.socket.onerror = () => {
      console.warn('[signal] error')
      onEvent({ type: 'error', message: 'Signaling socket error' })
    }
    this.socket.onclose = () => {
      if (this.closedByClient) return
      console.warn('[signal] closed')
      onEvent({ type: 'error', message: 'Signaling socket closed' })
    }
  }

  send(message: SignalMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      console.debug('[signal] send', message.type)
      const serialized = JSON.stringify(message)
      this.socket.send(serialized)
      logTransportUsage({
        channel: 'signaling',
        direction: 'outbound',
        description: describeSignalMessage(message),
        bytes: byteLengthUtf8(serialized)
      })
    } else {
      console.debug('[signal] queue', message.type)
      this.queue.push(message)
    }
  }

  isConnected() {
    return this.socket?.readyState === WebSocket.OPEN
  }

  disconnect() {
    this.closedByClient = true
    this.socket?.close()
    this.socket = undefined
    this.queue = []
  }
}

function describeSignalEvent(event: SignalEvent): string {
  if (event.type === 'signal') {
    return `signal from ${event.fromId} (${describePayload(event.payload)})`
  }
  if (event.type === 'relay') {
    return `relay from ${event.fromId} (${describePayload(event.payload)})`
  }
  if (event.type === 'peerList') {
    return `peerList (${event.clientIds.length} peers)`
  }
  if (event.type === 'peerJoined') {
    return `peerJoined ${event.clientId}`
  }
  if (event.type === 'roomCreated') {
    return `roomCreated ${event.roomId}`
  }
  return `error (${event.message})`
}
