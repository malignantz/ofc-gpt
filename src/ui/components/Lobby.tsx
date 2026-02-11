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
  const [linkCopied, setLinkCopied] = useState(false)
  const activeRoomCount = rooms.length

  const copyRoomLink = () => {
    const url = `${window.location.origin}/${toRoomSlug(roomCode)}`
    void navigator.clipboard.writeText(url).then(() => {
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
    })
  }

  return (
    <section className="panel lobby-panel">
      <header className="lobby-head">
        <h2>Lobby</h2>
        <p className="lobby-intro">Open Face Chinese Poker — place 13 cards into 3 hands.</p>
      </header>

      <div className="lobby-focus">
        <section className="lobby-section lobby-directory">
          <div className="lobby-section-head">
            <h3>Join Game</h3>
            <span className="lobby-section-meta">{activeRoomCount} active</span>
          </div>
          {roomsLoading && (
            <div className="skeleton-group">
              <div className="skeleton-line" style={{ width: '80%' }} />
              <div className="skeleton-line" style={{ width: '60%' }} />
            </div>
          )}
          {roomsError && <p className="lobby-state lobby-state-error">{roomsError}</p>}
          {!roomsLoading && !roomsError && rooms.length === 0 && (
            <p className="lobby-state">No one's playing yet — create a room or challenge the CPU!</p>
          )}
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
            <div className="lobby-room-code-header">
              <p className="lobby-room-code-label">Room Code</p>
              <button className="button secondary btn-sm lobby-copy-btn" onClick={copyRoomLink}>
                {linkCopied ? 'Copied!' : 'Copy Link'}
              </button>
            </div>
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
