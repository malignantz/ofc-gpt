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
      this.queue.forEach((message) => this.socket?.send(JSON.stringify(message)))
      this.queue = []
    }
    this.socket.onmessage = (event) => {
      console.debug('[signal] message', event.data)
      onEvent(JSON.parse(event.data) as SignalEvent)
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
      this.socket.send(JSON.stringify(message))
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
