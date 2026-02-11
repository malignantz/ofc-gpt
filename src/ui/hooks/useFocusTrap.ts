import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * Traps keyboard focus within a container element while `isOpen` is true.
 * On open: focuses the first focusable element (or the container itself).
 * On close: restores focus to the element that was focused before the trap.
 */
export function useFocusTrap<T extends HTMLElement>(
  ref: RefObject<T | null>,
  isOpen: boolean
): void {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!isOpen || !ref.current) return

    const container = ref.current

    // Remember what was focused before opening
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null

    // Focus first focusable element in the dialog
    const focusableElements = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    const firstEl = focusableElements[0] as HTMLElement | undefined
    if (firstEl) {
      firstEl.focus()
    } else {
      container.focus()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return

      const focusable = container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      if (focusable.length === 0) return

      const first = focusable[0] as HTMLElement
      const last = focusable[focusable.length - 1] as HTMLElement

      if (event.shiftKey) {
        // Shift+Tab: if on first element, wrap to last
        if (document.activeElement === first) {
          event.preventDefault()
          last.focus()
        }
      } else {
        // Tab: if on last element, wrap to first
        if (document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      // Restore focus on close
      previouslyFocusedRef.current?.focus()
    }
  }, [isOpen, ref])
}
