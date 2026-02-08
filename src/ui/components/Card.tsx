import { useMemo } from 'react'

const suitMap: Record<string, string> = {
  S: '♠',
  H: '♥',
  D: '♦',
  C: '♣'
}

export type CardProps = {
  value: string
  draggable?: boolean
  onDragStart?: (value: string) => void
  onClick?: (value: string) => void
  dragPayload?: Record<string, unknown>
  fourColor?: boolean
  size?: 'normal' | 'small'
  selected?: boolean
}

export function Card({
  value,
  draggable,
  onDragStart,
  onClick,
  dragPayload,
  fourColor,
  size = 'normal',
  selected
}: CardProps) {
  const display = useMemo(() => {
    const rank = value[0] ?? ''
    const suit = value[1] ?? ''
    return `${rank}${suitMap[suit] ?? suit}`
  }, [value])

  const suitClass = `suit-${value[1]?.toLowerCase() ?? ''}`

  return (
    <div
      className={`card ${suitClass} ${draggable ? 'card-draggable' : ''} ${onClick ? 'card-clickable' : ''} ${selected ? 'card-selected' : ''} ${fourColor ? 'card--four' : ''} ${size === 'small' ? 'card-sm' : ''}`}
      draggable={draggable}
      onClick={(event) => {
        if (!onClick) return
        event.stopPropagation()
        onClick(value)
      }}
      onDragStart={(event) => {
        const element = event.currentTarget
        const rect = element.getBoundingClientRect()
        const dragImage = element.cloneNode(true) as HTMLElement
        dragImage.classList.remove('card-drag-source')
        dragImage.style.position = 'fixed'
        dragImage.style.top = '-9999px'
        dragImage.style.left = '-9999px'
        dragImage.style.pointerEvents = 'none'
        dragImage.style.opacity = '1'
        document.body.appendChild(dragImage)
        event.dataTransfer.setDragImage(dragImage, rect.width / 2, rect.height / 2)
        window.setTimeout(() => dragImage.remove(), 0)

        // Apply "left-behind" style after the drag image is captured.
        window.requestAnimationFrame(() => {
          element.classList.add('card-drag-source')
        })

        if (dragPayload) {
          event.dataTransfer.setData('application/json', JSON.stringify(dragPayload))
        }
        event.dataTransfer.setData('text/plain', value)
        onDragStart?.(value)
      }}
      onDragEnd={(event) => {
        event.currentTarget.classList.remove('card-drag-source')
      }}
    >
      {display}
    </div>
  )
}
