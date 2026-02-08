
type TableHand = {
  id: string
  name: string
  cards: string[]
}

type TableProps = {
  hands: TableHand[]
  onBack: () => void
}

export function Table({ hands, onBack }: TableProps) {
  return (
    <section className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Table</h2>
        <button className="button secondary" onClick={onBack}>
          Back to Lobby
        </button>
      </div>
      <div className="table">
        {hands.map((hand) => (
          <div key={hand.id} className="seat">
            <div className="seat-title">{hand.name}</div>
            <div className="cards">
              {hand.cards.map((card) => (
                <div key={card} className="card">
                  {card}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
