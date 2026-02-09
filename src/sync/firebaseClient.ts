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

export type FirebaseRestClient = {
  isConfigured: boolean
  baseUrl: string
  requestJson: <T>(path: string, options?: FirebaseRequestOptions) => Promise<T>
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
    const init: RequestInit = {
      method,
      signal: options?.signal,
      headers: { 'Content-Type': 'application/json' }
    }
    if (options?.body !== undefined && method !== 'GET') {
      init.body = JSON.stringify(options.body)
    }

    const response = await fetch(url, init)
    if (!response.ok) {
      throw new Error(`Firebase request failed (${response.status}) for ${method} ${url}`)
    }
    if (response.status === 204) return null as T

    const text = await response.text()
    if (!text) return null as T
    return JSON.parse(text) as T
  }

  return { isConfigured, baseUrl, requestJson }
}
