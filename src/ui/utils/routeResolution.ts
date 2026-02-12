export type RouteResolution =
  | { kind: 'cpu' }
  | { kind: 'room'; room: string; join: boolean }
  | { kind: 'lobby' }

export function getParamInsensitive(params: URLSearchParams, key: string): string | null {
  const lowered = key.toLowerCase()
  for (const [k, value] of params.entries()) {
    if (k.toLowerCase() === lowered) return value
  }
  return null
}

export function parseJoinFlag(value: string | null): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on'
}

function decodePathSegment(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

export function resolveRoute(pathname: string, search: URLSearchParams): RouteResolution {
  const rawPath = pathname.replace(/^\/+/, '').replace(/\/+$/, '').trim()
  const normalizedPath = rawPath.toLowerCase()
  if (normalizedPath === 'cpu') return { kind: 'cpu' }

  const pathRoom = rawPath.length > 0 ? decodePathSegment(rawPath) : null
  const queryRoom = getParamInsensitive(search, 'room')?.trim() ?? ''
  const room = (pathRoom && pathRoom.length > 0 ? pathRoom : queryRoom) || null
  if (!room) return { kind: 'lobby' }

  const join = parseJoinFlag(getParamInsensitive(search, 'join'))
  return { kind: 'room', room, join }
}
