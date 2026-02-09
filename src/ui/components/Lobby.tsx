import { useState } from 'react'
import { generateRoomName, toRoomSlug } from '../utils/roomNames'
import type { RoomDirectoryEntry } from '../../sync/roomStore'

type LobbyProps = {
  onStart: (roomName: string, host: boolean) => void
  rooms: RoomDirectoryEntry[]
  roomsLoading: boolean
  roomsError: string | null
  onJoinListedRoom: (roomId: string) => void
  initialRoom?: string
}

export function triggerListedRoomJoin(onJoinListedRoom: (roomId: string) => void, roomId: string) {
  onJoinListedRoom(roomId)
}

export function Lobby({
  onStart,
  rooms,
  roomsLoading,
  roomsError,
  onJoinListedRoom,
  initialRoom
}: LobbyProps) {
  const [roomCode] = useState(() => initialRoom ?? generateRoomName())
  const activeRoomCount = rooms.length

  return (
    <section className="panel lobby-panel">
      <header className="lobby-head">
        <h2>Lobby</h2>
      </header>

      <div className="lobby-focus">
        <section className="lobby-section lobby-directory">
          <div className="lobby-section-head">
            <h3>Join Game</h3>
            <span className="lobby-section-meta">{activeRoomCount} active</span>
          </div>
          {roomsLoading && <p className="lobby-state">Loading active rooms...</p>}
          {roomsError && <p className="lobby-state lobby-state-error">{roomsError}</p>}
          {!roomsLoading && !roomsError && rooms.length === 0 && <p className="lobby-state">No active rooms yet.</p>}
          {!roomsLoading && !roomsError && rooms.length > 0 && (
            <div className="lobby-room-list">
              {rooms.map((room) => (
                <button
                  key={room.roomId}
                  className="button secondary lobby-room-button"
                  onClick={() => triggerListedRoomJoin(onJoinListedRoom, room.roomId)}
                >
                  <span className="lobby-room-main">
                    <span className="lobby-room-name">{room.displayName}</span>
                    <span className="lobby-room-detail">
                      Host {room.hostName} • {room.status}
                    </span>
                  </span>
                  <span className="lobby-room-players">
                    {room.playerCount}/{room.expectedPlayers}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="lobby-section lobby-create">
          <div className="lobby-section-head">
            <h3>Create Game</h3>
            <span className="lobby-section-meta">2 players</span>
          </div>
          <div className="lobby-room-code-wrap">
            <p className="lobby-room-code-label">Room Code</p>
            <div className="lobby-room-code">{roomCode}</div>
          </div>
          <div className="lobby-create-actions">
            <button className="button lobby-create-button" onClick={() => onStart(toRoomSlug(roomCode), true)}>
              Create Game
            </button>
          </div>
        </section>
      </div>
    </section>
  )
}
