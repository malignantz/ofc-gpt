import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFirebaseRestClient, readFirebaseConfig } from '../src/sync/firebaseClient'

describe('firebaseClient config', () => {
  it('returns null when database URL is missing', () => {
    const config = readFirebaseConfig({
      VITE_FIREBASE_API_KEY: 'key',
      VITE_FIREBASE_PROJECT_ID: 'proj'
    })
    expect(config).toBeNull()
  })

  it('reads config and trims trailing slash from database URL', () => {
    const config = readFirebaseConfig({
      VITE_FIREBASE_API_KEY: 'key',
      VITE_FIREBASE_AUTH_DOMAIN: 'test.firebaseapp.com',
      VITE_FIREBASE_DATABASE_URL: 'https://test-default-rtdb.firebaseio.com/',
      VITE_FIREBASE_PROJECT_ID: 'test',
      VITE_FIREBASE_APP_ID: 'app'
    })
    expect(config).toEqual({
      apiKey: 'key',
      authDomain: 'test.firebaseapp.com',
      databaseUrl: 'https://test-default-rtdb.firebaseio.com',
      projectId: 'test',
      appId: 'app'
    })
  })
})

describe('firebaseClient requests', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('sends JSON requests to RTDB .json endpoints', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '{"ok":true}'
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createFirebaseRestClient({
      apiKey: 'key',
      authDomain: 'test.firebaseapp.com',
      databaseUrl: 'https://test-default-rtdb.firebaseio.com',
      projectId: 'test',
      appId: 'app'
    })

    const response = await client.requestJson<{ ok: boolean }>('/rooms/abc', {
      method: 'PUT',
      body: { value: 1 }
    })

    expect(response).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://test-default-rtdb.firebaseio.com/rooms/abc.json',
      expect.objectContaining({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 1 })
      })
    )
  })

  it('throws when Firebase is not configured', async () => {
    const client = createFirebaseRestClient(null)
    await expect(client.requestJson('/rooms/x')).rejects.toThrow('Firebase is not configured')
  })

  it('throws detailed errors for non-2xx responses', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => ''
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createFirebaseRestClient({
      apiKey: 'key',
      authDomain: 'test.firebaseapp.com',
      databaseUrl: 'https://test-default-rtdb.firebaseio.com',
      projectId: 'test',
      appId: 'app'
    })

    await expect(client.requestJson('/roomDirectory')).rejects.toThrow(
      'Firebase request failed (401) for GET https://test-default-rtdb.firebaseio.com/roomDirectory.json'
    )
  })

  it('rate limits requests to at most one per second', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '{}'
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createFirebaseRestClient({
      apiKey: 'key',
      authDomain: 'test.firebaseapp.com',
      databaseUrl: 'https://test-default-rtdb.firebaseio.com',
      projectId: 'test',
      appId: 'app'
    })

    await client.requestJson('/rooms/first')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const secondRequest = client.requestJson('/rooms/second')
    await Promise.resolve()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await secondRequest
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
