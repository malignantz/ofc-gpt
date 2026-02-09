type TransportDirection = 'outbound' | 'inbound'
type TransportChannel = 'firebase' | 'signaling' | 'webrtc'

type TransportBucket = {
  totalBytes: number
  totalRequests: number
}

type TransportUsageStore = {
  overall: TransportBucket
  byDirection: Record<TransportDirection, TransportBucket>
  byChannelDirection: Record<string, TransportBucket>
}

type TransportUsageInput = {
  channel: TransportChannel
  direction: TransportDirection
  description: string
  bytes: number
  requestCount?: number
}

type TransportStatsBucket = {
  totalBytes: number
  totalRequests: number
  averageBytesPerRequest: number
}

export type TransportStatsSnapshot = {
  overall: TransportStatsBucket
  outbound: TransportStatsBucket
  inbound: TransportStatsBucket
  byChannelDirection: Record<string, TransportStatsBucket>
}

const STORE_KEY = '__ofc_transport_usage_store__'
const encoder = new TextEncoder()

function createBucket(): TransportBucket {
  return { totalBytes: 0, totalRequests: 0 }
}

function createStore(): TransportUsageStore {
  return {
    overall: createBucket(),
    byDirection: {
      outbound: createBucket(),
      inbound: createBucket()
    },
    byChannelDirection: {}
  }
}

function bucketToSnapshot(bucket: TransportBucket): TransportStatsBucket {
  return {
    totalBytes: bucket.totalBytes,
    totalRequests: bucket.totalRequests,
    averageBytesPerRequest: Math.round(safeAverage(bucket.totalBytes, bucket.totalRequests))
  }
}

function readStore(): TransportUsageStore {
  const root = globalThis as unknown as Record<string, unknown>
  const existing = root[STORE_KEY]
  if (isStore(existing)) return existing
  const created = createStore()
  root[STORE_KEY] = created
  return created
}

function isStore(value: unknown): value is TransportUsageStore {
  if (!isRecord(value)) return false
  return isBucket(value.overall)
}

function isBucket(value: unknown): value is TransportBucket {
  if (!isRecord(value)) return false
  return typeof value.totalBytes === 'number' && typeof value.totalRequests === 'number'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function addToBucket(bucket: TransportBucket, bytes: number, requests: number) {
  bucket.totalBytes += bytes
  bucket.totalRequests += requests
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function safeAverage(bytes: number, requests: number): number {
  if (requests <= 0) return 0
  return bytes / requests
}

function normalizeRequests(value: number | undefined): number {
  if (value === undefined) return 1
  if (!Number.isFinite(value) || value <= 0) return 1
  return Math.max(1, Math.round(value))
}

export function byteLengthUtf8(value: string): number {
  return encoder.encode(value).length
}

export function estimatePayloadBytes(payload: unknown): number | null {
  if (typeof payload === 'string') return byteLengthUtf8(payload)
  if (payload instanceof ArrayBuffer) return payload.byteLength
  if (ArrayBuffer.isView(payload)) return payload.byteLength
  if (typeof Blob !== 'undefined' && payload instanceof Blob) return payload.size
  if (payload === null || payload === undefined) return 0
  try {
    return byteLengthUtf8(JSON.stringify(payload))
  } catch {
    return null
  }
}

export function describePayload(payload: unknown): string {
  if (payload === null) return 'null'
  if (payload === undefined) return 'undefined'
  if (typeof payload === 'string') return `text(${payload.length} chars)`
  if (typeof payload === 'number' || typeof payload === 'boolean') return String(payload)
  if (Array.isArray(payload)) return `array(${payload.length})`
  if (!isRecord(payload)) return typeof payload

  const baseType = typeof payload.type === 'string' ? payload.type : null
  if (baseType === 'action' && isRecord(payload.action) && typeof payload.action.type === 'string') {
    return `action:${payload.action.type}`
  }
  if (baseType) return `type:${baseType}`

  const keys = Object.keys(payload)
  if (keys.length === 0) return 'object(empty)'
  return `object(${keys.slice(0, 3).join(',')}${keys.length > 3 ? ',…' : ''})`
}

export function describeSignalMessage(message: { type: string; targetId?: string; payload?: unknown }): string {
  if (message.type === 'signal') {
    return `signal to ${message.targetId ?? 'peer'} (${describePayload(message.payload)})`
  }
  if (message.type === 'relayTo') {
    return `relayTo ${message.targetId ?? 'peer'} (${describePayload(message.payload)})`
  }
  if (message.type === 'relay') {
    return `relay (${describePayload(message.payload)})`
  }
  return message.type
}

export function logTransportUsage(input: TransportUsageInput) {
  if (!Number.isFinite(input.bytes) || input.bytes < 0) return
  const requests = normalizeRequests(input.requestCount)
  const eventBytes = Math.max(0, Math.round(input.bytes)) * requests

  const store = readStore()
  const directionBucket = store.byDirection[input.direction]
  const channelKey = `${input.direction}:${input.channel}`
  const channelBucket = store.byChannelDirection[channelKey] ?? createBucket()
  store.byChannelDirection[channelKey] = channelBucket

  addToBucket(store.overall, eventBytes, requests)
  addToBucket(directionBucket, eventBytes, requests)
  addToBucket(channelBucket, eventBytes, requests)

  const directionAverage = safeAverage(directionBucket.totalBytes, directionBucket.totalRequests)
  const channelAverage = safeAverage(channelBucket.totalBytes, channelBucket.totalRequests)
  const eventAverage = safeAverage(eventBytes, requests)

  console.info(
    `[transport] ${input.direction} ${input.channel}: ${input.description} | ` +
      `event ${formatBytes(eventBytes)} across ${requests} request${requests === 1 ? '' : 's'} ` +
      `(avg ${formatBytes(Math.round(eventAverage))}/request) | ` +
      `${input.direction} total ${formatBytes(directionBucket.totalBytes)} across ${directionBucket.totalRequests} ` +
      `requests (avg ${formatBytes(Math.round(directionAverage))}/request) | ` +
      `${input.channel} ${input.direction} total ${formatBytes(channelBucket.totalBytes)} across ${channelBucket.totalRequests} ` +
      `requests (avg ${formatBytes(Math.round(channelAverage))}/request)`
  )
}

export function getTransportUsageSnapshot(): TransportStatsSnapshot {
  const store = readStore()
  const byChannelDirection: Record<string, TransportStatsBucket> = {}
  Object.entries(store.byChannelDirection).forEach(([key, bucket]) => {
    byChannelDirection[key] = bucketToSnapshot(bucket)
  })
  return {
    overall: bucketToSnapshot(store.overall),
    outbound: bucketToSnapshot(store.byDirection.outbound),
    inbound: bucketToSnapshot(store.byDirection.inbound),
    byChannelDirection
  }
}

export function resetTransportUsageStats() {
  const root = globalThis as unknown as Record<string, unknown>
  root[STORE_KEY] = createStore()
}

type WindowWithTransportHelpers = Window & {
  __ofcTransportStats?: () => TransportStatsSnapshot
  __ofcTransportReset?: () => void
}

function installWindowTransportHelpers() {
  if (typeof window === 'undefined') return
  const target = window as WindowWithTransportHelpers
  if (typeof target.__ofcTransportStats !== 'function') {
    target.__ofcTransportStats = () => {
      const snapshot = getTransportUsageSnapshot()
      console.info('[transport] snapshot', snapshot)
      return snapshot
    }
  }
  if (typeof target.__ofcTransportReset !== 'function') {
    target.__ofcTransportReset = () => {
      resetTransportUsageStats()
      console.info('[transport] stats reset')
    }
  }
}

installWindowTransportHelpers()
