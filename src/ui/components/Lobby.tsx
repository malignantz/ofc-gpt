import { useState } from 'react'
import { generateRoomName, toRoomSlug } from '../utils/roomNames'
import type { RoomDirectoryEntry } from '../../sync/roomStore'

type LobbyProps = {
  playerCount: number
  playerName: string
  onPlayerNameChange: (name: string) => void
  onPlayerCountChange: (count: number) => void
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
  playerCount,
  playerName,
  onPlayerNameChange,
  onPlayerCountChange,
  onStart,
  rooms,
  roomsLoading,
  roomsError,
  onJoinListedRoom,
  initialRoom
}: LobbyProps) {
  const [roomCode, setRoomCode] = useState(() => initialRoom ?? generateRoomName())
  const [joinName, setJoinName] = useState('')
  const [copied, setCopied] = useState(false)
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin

  const shareSlug = toRoomSlug(roomCode)
  const shareLink = `${origin}/${shareSlug}?players=${playerCount}&join=1`

  return (
    <section className="panel">
      <h2>Lobby</h2>
      <div className="lobby-grid">
        <div>
          <p>Room Code</p>
          <div style={{ fontSize: 24, fontWeight: 700 }}>{roomCode}</div>
          <button className="button secondary" onClick={() => setRoomCode(generateRoomName())}>
            Shuffle Name
          </button>
          <p style={{ marginTop: 12 }}>Share Link</p>
          <div className="share-row">
            <span className="share-link">{shareLink}</span>
            <button
              className="button secondary"
              onClick={() => {
                navigator.clipboard.writeText(shareLink)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1600)
              }}
            >
              Copy
            </button>
            {copied && <span className="tooltip">Copied!</span>}
          </div>
          <div className="share-slug">Join code: {shareSlug}</div>
        </div>
        <div>
          <p>Player Name</p>
          <input value={playerName} onChange={(event) => onPlayerNameChange(event.target.value)} />
        </div>
        <div>
          <p>Players</p>
          <select value={2} onChange={() => onPlayerCountChange(2)}>
            <option value={2}>2 players</option>
          </select>
        </div>
        <div>
          <p>Start</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="button" onClick={() => onStart(shareSlug, true)}>
              Host Game
            </button>
            <button className="button secondary" onClick={() => onStart(toRoomSlug(joinName || roomCode), false)}>
              Join Game
            </button>
          </div>
          <input
            placeholder="Join room name"
            value={joinName}
            onChange={(event) => setJoinName(event.target.value)}
            style={{ marginTop: 10 }}
          />
        </div>
        <div>
          <p>Active Rooms</p>
          {roomsLoading && <p>Loading rooms...</p>}
          {roomsError && <p>{roomsError}</p>}
          {!roomsLoading && !roomsError && rooms.length === 0 && <p>No active rooms yet.</p>}
          {!roomsLoading && !roomsError && rooms.length > 0 && (
            <div style={{ display: 'grid', gap: 8 }}>
              {rooms.map((room) => (
                <button
                  key={room.roomId}
                  className="button secondary"
                  onClick={() => triggerListedRoomJoin(onJoinListedRoom, room.roomId)}
                  style={{ textAlign: 'left' }}
                >
                  {room.displayName} ({room.playerCount}/{room.expectedPlayers})
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
