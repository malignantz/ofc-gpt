import { byteLengthUtf8, describePayload, logTransportUsage } from '../utils/transportUsage'

type EnvLike = Record<string, string | undefined>

export type FirebaseConfig = {
  apiKey: string
  authDomain: string
  databaseUrl: string
  projectId: string
  appId: string
}

export type FirebaseRequestOptions = {
  method?: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

export type FirebaseValueSubscriptionHandlers = {
  onValue: (value: unknown) => void
  onError?: (error: Error) => void
}

export type FirebaseChildSubscriptionHandlers = {
  onAdded?: (key: string, value: unknown) => void
  onChanged?: (key: string, value: unknown) => void
  onRemoved?: (key: string, value: unknown) => void
  onError?: (error: Error) => void
}

export type FirebaseRestClient = {
  isConfigured: boolean
  baseUrl: string
  supportsRealtime?: boolean
  requestJson: <T>(path: string, options?: FirebaseRequestOptions) => Promise<T>
  subscribeValue?: (path: string, handlers: FirebaseValueSubscriptionHandlers) => () => void
  subscribeChild?: (path: string, handlers: FirebaseChildSubscriptionHandlers) => () => void
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizePath(path: string): string {
  if (path.length === 0 || path === '/') return '/.json'
  const withSlash = path.startsWith('/') ? path : `/${path}`
  return withSlash.endsWith('.json') ? withSlash : `${withSlash}.json`
}

export function readFirebaseConfig(env: EnvLike = import.meta.env as unknown as EnvLike): FirebaseConfig | null {
  const databaseUrl = env.VITE_FIREBASE_DATABASE_URL?.trim() ?? ''
  if (!databaseUrl) return null
  return {
    apiKey: env.VITE_FIREBASE_API_KEY?.trim() ?? '',
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN?.trim() ?? '',
    databaseUrl: trimTrailingSlash(databaseUrl),
    projectId: env.VITE_FIREBASE_PROJECT_ID?.trim() ?? '',
    appId: env.VITE_FIREBASE_APP_ID?.trim() ?? ''
  }
}

export function createFirebaseRestClient(config: FirebaseConfig | null = readFirebaseConfig()): FirebaseRestClient {
  const baseUrl = config?.databaseUrl ?? ''
  const isConfigured = baseUrl.length > 0

  const requestJson = async <T>(path: string, options?: FirebaseRequestOptions): Promise<T> => {
    if (!isConfigured) {
      throw new Error('Firebase is not configured. Set VITE_FIREBASE_DATABASE_URL and related env vars.')
    }

    const method = options?.method ?? 'GET'
    const url = `${baseUrl}${normalizePath(path)}`
    const normalizedPath = normalizePath(path).replace(/\.json$/, '')
    const bodyText = options?.body !== undefined && method !== 'GET' ? JSON.stringify(options.body) : undefined
    const init: RequestInit = {
      method,
      signal: options?.signal,
      headers: { 'Content-Type': 'application/json' }
    }
    if (bodyText !== undefined) {
      init.body = bodyText
    }
    logTransportUsage({
      channel: 'firebase',
      direction: 'outbound',
      description: `${method} ${normalizedPath} request (${bodyText ? describePayload(options?.body) : 'no-body'})`,
      bytes: bodyText ? byteLengthUtf8(bodyText) : 0
    })

    const response = await fetch(url, init)
    const text = response.status === 204 ? '' : await response.text()
    const parsedResponse = parseJsonIfPossible(text)
    logTransportUsage({
      channel: 'firebase',
      direction: 'inbound',
      description: `${method} ${normalizedPath} response (${response.status}, ${describePayload(parsedResponse ?? text)})`,
      bytes: byteLengthUtf8(text)
    })
    if (!response.ok) {
      throw new Error(`Firebase request failed (${response.status}) for ${method} ${url}`)
    }
    if (response.status === 204) return null as T

    if (!text) return null as T
    return JSON.parse(text) as T
  }

  return { isConfigured, baseUrl, supportsRealtime: false, requestJson }
}

function parseJsonIfPossible(text: string): unknown | null {
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}
