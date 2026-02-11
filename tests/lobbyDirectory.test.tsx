import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Lobby, triggerListedRoomJoin } from '../src/ui/components/Lobby'
import type { RoomDirectoryEntry } from '../src/sync/roomStore'

const rooms: RoomDirectoryEntry[] = [
  {
    roomId: 'alpha-room',
    displayName: 'alpha-room',
    hostName: 'Host',
    status: 'waiting',
    playerCount: 1,
    expectedPlayers: 2,
    updatedAt: 10,
    expiresAt: 1000,
    discoverable: true
  }
]

describe('Lobby room directory', () => {
  it('renders active room list entries', () => {
    const html = renderToStaticMarkup(
      <Lobby
        onStart={() => undefined}
        rooms={rooms}
        roomsLoading={false}
        roomsError={null}
        onJoinListedRoom={() => undefined}
      />
    )

    expect(html).toContain('Join Game')
    expect(html).toContain('alpha-room')
    expect(html).toContain('1/2')
    expect(html).toContain('Host Host')
    expect(html).not.toContain('CPU Play')
  })

  it('routes listed room join through callback helper', () => {
    const onJoin = vi.fn()
    triggerListedRoomJoin(onJoin, 'alpha-room')
    expect(onJoin).toHaveBeenCalledWith('alpha-room')
  })

})
