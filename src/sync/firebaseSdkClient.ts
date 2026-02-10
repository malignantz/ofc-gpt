import { FirebaseApp, FirebaseOptions, getApp, getApps, initializeApp } from 'firebase/app'
import {
  Database,
  DataSnapshot,
  get,
  getDatabase,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onValue,
  ref,
  remove,
  set,
  update
} from 'firebase/database'
import {
  FirebaseChildSubscriptionHandlers,
  FirebaseConfig,
  FirebaseRequestOptions,
  FirebaseRestClient,
  FirebaseValueSubscriptionHandlers,
  readFirebaseConfig
} from './firebaseClient'
import { describePayload, estimatePayloadBytes, logTransportUsage } from '../utils/transportUsage'

type FirebaseSdkDeps = {
  getApps: typeof getApps
  getApp: typeof getApp
  initializeApp: typeof initializeApp
  getDatabase: typeof getDatabase
  ref: typeof ref
  get: typeof get
  set: typeof set
  update: typeof update
  remove: typeof remove
  onValue: typeof onValue
  onChildAdded: typeof onChildAdded
  onChildChanged: typeof onChildChanged
  onChildRemoved: typeof onChildRemoved
}

type FirebaseSdkClientOptions = {
  config?: FirebaseConfig | null
  deps?: FirebaseSdkDeps
}

const APP_NAME = 'ofc-gpt-sync'

const defaultDeps: FirebaseSdkDeps = {
  getApps,
  getApp,
  initializeApp,
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  onValue,
  onChildAdded,
  onChildChanged,
  onChildRemoved
}

export function createFirebaseSdkClient(options: FirebaseSdkClientOptions = {}): FirebaseRestClient {
  const config = options.config ?? readFirebaseConfig()
  const deps = options.deps ?? defaultDeps
  const baseUrl = config?.databaseUrl ?? ''
  const isConfigured = baseUrl.length > 0

  let database: Database | null = null
  if (isConfigured) {
    const app = resolveOrCreateApp(config, deps)
    database = deps.getDatabase(app)
  }

  const requestJson = async <T>(path: string, options?: FirebaseRequestOptions): Promise<T> => {
    if (!isConfigured || !database) {
      throw new Error('Firebase is not configured. Set VITE_FIREBASE_DATABASE_URL and related env vars.')
    }

    const method = options?.method ?? 'GET'
    const normalizedPath = normalizePath(path)
    const pathLabel = labelPath(normalizedPath)
    const targetRef = deps.ref(database, normalizedPath)
    const body = options?.body
    const outboundBytes = method !== 'GET' && body !== undefined ? estimatePayloadBytes(body) ?? 0 : 0
    logTransportUsage({
      channel: 'firebase',
      direction: 'outbound',
      description: `${method} ${pathLabel} request (${body === undefined || method === 'GET' ? 'no-body' : describePayload(body)})`,
      bytes: outboundBytes
    })

    if (method === 'GET') {
      const snapshot = await deps.get(targetRef)
      const value = snapshot.exists() ? snapshot.val() : null
      logTransportUsage({
        channel: 'firebase',
        direction: 'inbound',
        description: `${method} ${pathLabel} response (200, ${describePayload(value)})`,
        bytes: estimatePayloadBytes(value) ?? 0
      })
      return value as T
    }

    if (method === 'PUT') {
      await deps.set(targetRef, body ?? null)
      logTransportUsage({
        channel: 'firebase',
        direction: 'inbound',
        description: `${method} ${pathLabel} response (200, text(0 chars))`,
        bytes: 0
      })
      return (body ?? null) as T
    }

    if (method === 'PATCH') {
      if (isRecord(body)) {
        await deps.update(targetRef, body)
      } else {
        await deps.set(targetRef, body ?? null)
      }
      logTransportUsage({
        channel: 'firebase',
        direction: 'inbound',
        description: `${method} ${pathLabel} response (200, ${describePayload(body ?? null)})`,
        bytes: estimatePayloadBytes(body ?? null) ?? 0
      })
      return (body ?? null) as T
    }

    if (method === 'DELETE') {
      await deps.remove(targetRef)
      logTransportUsage({
        channel: 'firebase',
        direction: 'inbound',
        description: `${method} ${pathLabel} response (200, text(0 chars))`,
        bytes: 0
      })
      return null as T
    }

    throw new Error(`Firebase SDK client does not support method "${method}"`)
  }

  const subscribeValue = (path: string, handlers: FirebaseValueSubscriptionHandlers): (() => void) => {
    if (!isConfigured || !database) {
      throw new Error('Firebase realtime subscriptions are unavailable without Firebase configuration.')
    }
    const normalizedPath = normalizePath(path)
    const targetRef = deps.ref(database, normalizedPath)
    return deps.onValue(
      targetRef,
      (snapshot) => {
        const value = snapshotToValue(snapshot)
        logTransportUsage({
          channel: 'firebase',
          direction: 'inbound',
          description: `realtime value ${labelPath(normalizedPath)} (${describePayload(value)})`,
          bytes: estimatePayloadBytes(value) ?? 0
        })
        handlers.onValue(value)
      },
      (error) => {
        handlers.onError?.(toError(error, 'Firebase realtime value subscription failed'))
      }
    )
  }

  const subscribeChild = (path: string, handlers: FirebaseChildSubscriptionHandlers): (() => void) => {
    if (!isConfigured || !database) {
      throw new Error('Firebase realtime subscriptions are unavailable without Firebase configuration.')
    }
    const normalizedPath = normalizePath(path)
    const targetRef = deps.ref(database, normalizedPath)
    const toHandler =
      (kind: 'added' | 'changed' | 'removed', handler: ((key: string, value: unknown) => void) | undefined) =>
      (snapshot: DataSnapshot) => {
        if (!handler) return
        const key = snapshot.key
        if (!key) return
        const value = snapshotToValue(snapshot)
        logTransportUsage({
          channel: 'firebase',
          direction: 'inbound',
          description: `realtime child ${kind} ${labelPath(normalizedPath)} (${describePayload(value)})`,
          bytes: estimatePayloadBytes(value) ?? 0
        })
        handler(key, value)
      }

    const onError = (error: unknown) => {
      handlers.onError?.(toError(error, 'Firebase realtime child subscription failed'))
    }

    const unsubscribers = [
      deps.onChildAdded(targetRef, toHandler('added', handlers.onAdded), onError),
      deps.onChildChanged(targetRef, toHandler('changed', handlers.onChanged), onError),
      deps.onChildRemoved(targetRef, toHandler('removed', handlers.onRemoved), onError)
    ]
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }

  return {
    isConfigured,
    baseUrl,
    supportsRealtime: true,
    requestJson,
    subscribeValue,
    subscribeChild
  }
}

function resolveOrCreateApp(config: FirebaseConfig | null, deps: FirebaseSdkDeps): FirebaseApp {
  if (!config) throw new Error('Firebase config is required to initialize SDK client.')
  const existing = deps.getApps().find((app) => app.name === APP_NAME)
  if (existing) return existing
  const options: FirebaseOptions = {
    apiKey: config.apiKey,
    authDomain: config.authDomain || undefined,
    databaseURL: config.databaseUrl,
    projectId: config.projectId || undefined,
    appId: config.appId || undefined
  }
  return deps.initializeApp(options, APP_NAME)
}

function normalizePath(path: string): string {
  const withoutJson = path.replace(/\.json$/, '')
  const trimmed = withoutJson.trim()
  if (trimmed.length === 0 || trimmed === '/') return ''
  return trimmed
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
    .join('/')
}

function labelPath(path: string): string {
  return path ? `/${path}` : '/'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function snapshotToValue(snapshot: DataSnapshot): unknown {
  if (!snapshot.exists()) return null
  return snapshot.val()
}

function toError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string' && value.length > 0) return new Error(value)
  return new Error(fallbackMessage)
}
