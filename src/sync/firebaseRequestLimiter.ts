export const FIREBASE_MIN_REQUEST_INTERVAL_MS = 1_000

export type FirebaseRequestLimiter = <T>(run: () => Promise<T>) => Promise<T>

export function createFirebaseRequestLimiter(
  minIntervalMs: number = FIREBASE_MIN_REQUEST_INTERVAL_MS
): FirebaseRequestLimiter {
  let queued = Promise.resolve()
  let nextAvailableAt = 0

  return <T>(run: () => Promise<T>): Promise<T> => {
    const scheduled = queued.then(async () => {
      const waitMs = Math.max(0, nextAvailableAt - Date.now())
      if (waitMs > 0) await delay(waitMs)
      nextAvailableAt = Date.now() + minIntervalMs
      return run()
    })
    queued = scheduled.then(
      () => undefined,
      () => undefined
    )
    return scheduled
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms)
  })
}
