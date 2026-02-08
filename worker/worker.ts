type DurableObjectIdLike = unknown
type DurableObjectStubLike = { fetch: (request: Request) => Promise<Response> }
type DurableObjectNamespaceLike = {
  idFromName: (name: string) => DurableObjectIdLike
  get: (id: DurableObjectIdLike) => DurableObjectStubLike
}
type DurableObjectStateLike = {
  acceptWebSocket: (socket: WebSocket) => void
  getWebSockets: () => WebSocketWithAttachment[]
}

export interface Env {
  ROOM: DurableObjectNamespaceLike
}

type SignalMessage =
  | { type: 'createRoom'; roomId: string; clientId: string }
  | { type: 'joinRoom'; roomId: string; clientId: string }
  | { type: 'signal'; roomId: string; targetId: string; payload: unknown }
  | { type: 'relayTo'; roomId: string; targetId: string; payload: unknown }
  | { type: 'relay'; roomId: string; payload: unknown }

type SignalEvent =
  | { type: 'roomCreated'; roomId: string }
  | { type: 'peerList'; clientIds: string[] }
  | { type: 'peerJoined'; clientId: string }
  | { type: 'signal'; fromId: string; payload: unknown }
  | { type: 'relay'; fromId: string; payload: unknown }

type ClientAttachment = { clientId: string; roomId: string }

type WebSocketWithAttachment = WebSocket & {
  serializeAttachment: (attachment: ClientAttachment | null) => void
  deserializeAttachment: () => ClientAttachment | null
}

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket }
}

type UpgradeResponseInit = ResponseInit & { webSocket?: WebSocket }

export class RoomDurableObject {
  constructor(private state: DurableObjectStateLike) {}

  async fetch(request: Request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1] as WebSocketWithAttachment
    this.state.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client } as UpgradeResponseInit)
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attachedWs = ws as WebSocketWithAttachment
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
    let payload: SignalMessage
    try {
      payload = JSON.parse(text) as SignalMessage
    } catch (error) {
      console.log('[signal] parse error', text, error)
      return
    }
    console.log('[signal] message', payload.type)
    if (payload.type === 'createRoom' || payload.type === 'joinRoom') {
      attachedWs.serializeAttachment({ clientId: payload.clientId, roomId: payload.roomId } satisfies ClientAttachment)
      console.log('[signal] join', payload.roomId, payload.clientId)
      attachedWs.send(JSON.stringify({ type: 'roomCreated', roomId: payload.roomId } satisfies SignalEvent))
      const peers = this.listClientIds(attachedWs)
      console.log('[signal] peer list', peers)
      attachedWs.send(JSON.stringify({ type: 'peerList', clientIds: peers } satisfies SignalEvent))
      this.broadcast(
        JSON.stringify({ type: 'peerJoined', clientId: payload.clientId } satisfies SignalEvent),
        attachedWs
      )
      return
    }

    if (payload.type === 'signal') {
      const target = this.findClient(payload.targetId, attachedWs)
      if (target) {
        const fromId = this.getClientId(attachedWs)
        target.send(JSON.stringify({ type: 'signal', fromId, payload: payload.payload } satisfies SignalEvent))
      }
    }

    if (payload.type === 'relayTo') {
      const target = this.findClient(payload.targetId, attachedWs)
      if (target) {
        const fromId = this.getClientId(attachedWs)
        target.send(JSON.stringify({ type: 'relay', fromId, payload: payload.payload } satisfies SignalEvent))
      }
    }

    if (payload.type === 'relay') {
      const fromId = this.getClientId(attachedWs)
      for (const socket of this.state.getWebSockets()) {
        if (socket === attachedWs) continue
        socket.send(JSON.stringify({ type: 'relay', fromId, payload: payload.payload } satisfies SignalEvent))
      }
    }
  }

  webSocketClose(ws: WebSocket) {
    const attachedWs = ws as WebSocketWithAttachment
    attachedWs.serializeAttachment(null)
  }

  webSocketError() {
    console.log('[signal] websocket error')
  }

  private getClientId(ws: WebSocketWithAttachment) {
    const attachment = ws.deserializeAttachment() as ClientAttachment | null
    return attachment?.clientId ?? 'unknown'
  }

  private findClient(clientId: string, excludeSocket?: WebSocketWithAttachment) {
    for (const socket of this.state.getWebSockets()) {
      if (excludeSocket && socket === excludeSocket) continue
      const attachment = socket.deserializeAttachment() as ClientAttachment | null
      if (attachment?.clientId === clientId) return socket
    }
    return null
  }

  private broadcast(message: string, excludeSocket?: WebSocketWithAttachment) {
    for (const socket of this.state.getWebSockets()) {
      if (excludeSocket && socket === excludeSocket) continue
      socket.send(message)
    }
  }

  private listClientIds(excludeSocket?: WebSocketWithAttachment) {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const socket of this.state.getWebSockets()) {
      if (excludeSocket && socket === excludeSocket) continue
      const attachment = socket.deserializeAttachment() as ClientAttachment | null
      const clientId = attachment?.clientId
      if (!clientId || seen.has(clientId)) continue
      ids.push(clientId)
      seen.add(clientId)
    }
    return ids
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    const roomId = url.searchParams.get('room')
    if (!roomId) {
      return new Response('Missing room', { status: 400 })
    }
    const id = env.ROOM.idFromName(roomId)
    const stub = env.ROOM.get(id)
    return stub.fetch(request)
  }
}
