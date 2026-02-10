import { afterEach, describe, expect, it, vi } from 'vitest'
import * as firebaseClient from '../src/sync/firebaseClient'
import * as firebaseSdkClient from '../src/sync/firebaseSdkClient'
import { createRoomStore } from '../src/sync/roomStore'

describe('roomStore client fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('falls back to REST client when SDK client initialization throws', () => {
    const fallbackClient: firebaseClient.FirebaseRestClient = {
      isConfigured: true,
      baseUrl: 'https://fallback.firebaseio.test',
      supportsRealtime: false,
      requestJson: async <T>() => null as T
    }
    const sdkSpy = vi.spyOn(firebaseSdkClient, 'createFirebaseSdkClient').mockImplementation(() => {
      throw new Error('sdk init failed')
    })
    const restSpy = vi.spyOn(firebaseClient, 'createFirebaseRestClient').mockReturnValue(fallbackClient)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const store = createRoomStore()

    expect(store.isConfigured).toBe(true)
    expect(sdkSpy).toHaveBeenCalledTimes(1)
    expect(restSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalled()
  })
})
