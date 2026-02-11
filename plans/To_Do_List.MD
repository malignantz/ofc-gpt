# OFC-GPT — UI Improvement To-Do List

Comprehensive analysis of style, motion, interaction, and polish opportunities.
Generated from full code review + live browser observation.

---

## 1. CARD RENDERING — Text → Graphical Cards

**Priority: HIGH | Impact: Transformative**

Currently cards are plain text divs (e.g. "Q♠", "8♣") rendered at 44×64px. This is functional but looks like a prototype. Real card games use graphical card faces.

- [ ] **Replace text cards with SVG/image card faces** — Use a standard open-source playing card SVG set (e.g. [svg-cards](https://github.com/htdebeer/SVG-cards)). Render proper card faces with pips, court figures, etc.
- [ ] **Fallback**: If full SVG cards are too heavy, create a hybrid: larger rank text + multiple suit pips arranged in the traditional pattern (e.g. a 9♠ shows 9 spade pips in the classic 3-3-3 layout).
- [ ] **Card back design** — Add a card-back visual for opponent hidden cards (currently just shows nothing). A patterned card back adds polish.
- [ ] **Increase card size** — 44×64px is quite small. Consider 56×80px default, 44×64px for opponent compact view.

## 2. CARD ANIMATIONS & TRANSITIONS

**Priority: HIGH | Impact: High — makes the game feel alive**

Currently the only animation is a simple 0.2s fadeIn on card enter. There's no motion when cards move between zones.

- [x] **Card placement animation** — Cards slide up with scale when placed into lines (`.card-place-enter`).
- [x] **Card draw animation** — Enhanced from simple fadeIn to 0.3s scale+blur entrance (`.card-enter` upgraded).
- [x] **Phase transition animation** — Brief opacity flash on `.table-shell` when phase changes (`.phase-transition`).
- [x] **Score reveal animation** — Staggered line reveals (0/120/240ms delays) + score badge pop-in with overshoot.
- [x] **Drag ghost improvement** — Added `scale(1.1)` and drop shadow to the drag ghost clone for a lifted feel.
- [x] **Subtle idle animation** — Pending tray cards now have a gentle blue shadow pulse (2.4s loop) to indicate they need placement.

## 3. LAYOUT & SPATIAL DESIGN

**Priority: MEDIUM-HIGH | Impact: Professional feel**

- [x] **Visual hierarchy between player and opponent** — Added separator line + top padding on opponents row, tinted opponent seat background to differentiate from bright white local seat.
- [x] **Pending cards tray positioning** — Added `.pending-tray-compact` class for play phase with ≤1 card: reduced padding, centered card.
- [x] **Empty slot indicators** — Ghost placeholder outlines (`.card-slot-empty`) now render in all lines showing unfilled positions.
- [x] **Score phase layout** — Side-by-side layout on desktop (`.score-phase` grid), enlarged score badge (16px), staggered royalty reveal animation. Falls back to stacked on mobile (<640px).
- [x] **Responsive card sizing** — Card width/height now use `clamp()` for fluid scaling between mobile and desktop sizes.

## 4. COLOR & VISUAL POLISH

**Priority: MEDIUM | Impact: Elevated aesthetic**

The warm beige palette (#f2ede4) is tasteful but could use more depth and contrast.

- [ ] **Add a dark mode** — The design system uses CSS custom properties, making this straightforward. Dark mode is expected in modern apps. Consider a dark green felt/table texture for poker atmosphere.
- [x] **Increase contrast on key elements** — Darkened muted text from #7c6f62 → #645749 and --text-muted from #685b4c → #5c5043 for WCAG AA compliance.
- [x] **Suit colors in 4-color mode** — 4-color mode is now the default (`fourColorDeck` defaults to `true`).
- [x] **Win/loss color intensity** — Increased opacity: win 0.14→0.2, win-strong 0.26→0.32, loss 0.12→0.18, tie 0.16→0.2.
- [x] **Active turn glow** — Added `seatPulse` (blue) and `seatPulseOpp` (orange) 2s infinite box-shadow animations on active seats.
- [x] **CPU Play button** — Applied the golden `.cpu-cta` gradient style to the lobby CPU Play button for better prominence.

## 5. OPPONENT SECTION — Information Display

**Priority: MEDIUM | Impact: Gameplay clarity**

- [x] **"CONNECTED PENDING 0" is cryptic** — Replaced with contextual messages: "Thinking…" (their turn), "Arranging hand…" (initial), "X cards in hand", or "Reconnecting…".
- [x] **Opponent card visibility** — Added fade+scale enter animation (`.card-opponent-enter`) when opponent places new cards, tracked via `recentlyPlacedOpponentCards` state.
- [x] **Opponent hand rank labels** — Now gated to only show during score phase (user requested hiding them during play).

## 6. INTERACTION FEEDBACK

**Priority: MEDIUM-HIGH | Impact: Responsiveness**

- [x] **Drop zone highlight** — Enhanced with blue border+glow, background tint, and smooth transitions on hover/drag-over.
- [x] **Card selection feedback (tap mode)** — Enhanced `.line-tap-active` with blue highlight, shadow, and pointer cursor; `.line-tap-blocked` dimmed with not-allowed cursor.
- [x] **Confirm Hand button feedback** — Button gets `.submit-ready-pulse` class with pulsing shadow when all 5 cards are placed and it's ready to submit.
- [x] **Undo/Reset affordance** — Clicking a placed card during initial phase on desktop now returns it to pending (via `returnCardToPending` helper). Works alongside existing drag-to-return and tap-mode return.
- [ ] **Sound effects** — Card placement, card draw, round completion, and win/loss could all benefit from subtle audio feedback. Optional, toggleable in settings.

## 7. LOBBY EXPERIENCE

**Priority: MEDIUM | Impact: First impression**

- [x] **Lobby feels sparse** — Added intro text: "Open Face Chinese Poker — place 13 cards into 3 hands." (remaining: poker table illustration/motif is a future enhancement)
- [x] **Room code UX** — Added "Copy Link" button with "Copied!" feedback state.
- [x] **CPU Play button placement** — Applied golden `.cpu-cta` style to lobby CPU Play button for better prominence.
- [x] **Room list empty state** — Updated to "No one's playing yet — create a room or challenge the CPU!"
- [x] **Loading skeleton** — Replaced "Loading active rooms..." with shimmer skeleton lines (`.skeleton-group` + `.skeleton-line` with gradient animation).

## 8. MODALS (Rules, Settings, Scoreboard)

**Priority: LOW-MEDIUM | Impact: Polish**

- [x] **Modal entry/exit animation** — Backdrop fade-in (0.15s) + dialog slide-up with scale (0.2s) added.
- [x] **Rules modal scrollbar** — Styled with thin scrollbar (6px, warm #d4c5a9 color) for both Firefox (`scrollbar-width/color`) and WebKit.
- [x] **Settings modal organization** — Split into "Display" (Player Name, 4-Color Deck) and "Gameplay" (CPU Profile, Hide Submit) groups with headers.
- [ ] **Scoreboard data** — The scoreboard reads from localStorage rivalry data but could show more stats: rounds played, best score, longest win streak, etc.

## 9. TYPOGRAPHY & SPACING

**Priority: LOW | Impact: Subtle refinement**

- [x] **Font loading** — Added Google Fonts import in index.html for Archivo (400-700), IBM Plex Sans (400-700), and IBM Plex Mono (500-600) with preconnect hints.
- [x] **Line label spacing** — Split count into separate `<span className="line-count">` with lighter weight (400), reduced opacity (0.5), and smaller font (10px).
- [x] **Status message sizing** — Added `min-height: 28px` to `.status-message` to prevent layout shift.
- [ ] **Monospace alignment** — IBM Plex Mono is used for room codes and player counts. Ensure consistent sizing and baseline alignment.

## 10. PERFORMANCE & ACCESSIBILITY

**Priority: MEDIUM | Impact: Quality**

- [x] **Focus management in modals** — Added `useFocusTrap` hook that traps Tab/Shift+Tab within modal, focuses first element on open, and restores focus on close. Applied to all three modals (Rules, Scoreboard, Settings).
- [ ] **Keyboard card placement** — No keyboard support for placing cards. Consider arrow keys to select card + number keys (1/2/3) for top/middle/bottom placement.
- [x] **Screen reader announcements** — Added `aria-live="polite"` region in GameTable that announces phase transitions: "New round started", "Play phase", "Round complete".
- [x] **Reduce layout shifts** — Already have min-heights on `.pending-tray .cards` (64px), `.line .cards` (64px), `.seat-opponent .line .cards` (48px), and `.status-message` (28px).
- [x] **Prefers-reduced-motion** — Added `@media (prefers-reduced-motion: reduce)` disabling all animations.

## 11. MOBILE-SPECIFIC

**Priority: MEDIUM | Impact: Mobile users**

- [x] **Touch target sizes** — Added `::after` pseudo-element on mobile cards with `inset: -4px` to expand touch target area to ~48×66px.
- [ ] **Swipe gestures** — Consider swipe-to-place: swipe a card up/middle/down to place it on the corresponding line.
- [x] **Viewport height handling** — Changed `.app` from `min-height: 100vh` to `min-height: 100dvh`.
- [x] **Horizontal scroll prevention** — Changed `.line-stack` from `overflow-x: auto` to `overflow-x: hidden`.

## 12. MICRO-INTERACTIONS & DELIGHT

**Priority: LOW | Impact: Memorable experience**

- [ ] **Confetti on sweep** — When a player sweeps all 3 lines, trigger a brief confetti/celebration animation.
- [ ] **Streak counter** — Show a win streak badge ("🔥 3 wins") during gameplay.
- [ ] **Card flip for reveal** — When showing final score, flip opponent's cards from face-down to face-up sequentially for dramatic reveal.
- [ ] **Dealer chip animation** — The "D" dealer chip could rotate/slide to the next player between rounds.
- [ ] **Turn timer visual** — If a turn timer is added later, show a circular progress ring around the active player's section.

---

## IMPLEMENTATION PRIORITY ORDER

1. **Card animations (placement, draw, phase transitions)** — Biggest bang for effort
2. **Opponent status text cleanup** ("Connected Pending 0" → meaningful text)
3. **Empty card slot placeholders** — Helps new players understand the layout
4. **Drop zone highlighting improvements** — Better drag feedback
5. **Card rendering upgrade** (SVG or enhanced text) — Visual leap
6. **Score phase dramatic layout** — Satisfying round endings
7. **Modal animations** — Quick polish win
8. **Dark mode** — Expected feature, CSS vars make it easy
9. **Lobby visual upgrade** — Better first impression
10. **Accessibility improvements** — Focus trapping, keyboard nav, aria-live

---

*Last updated: UI analysis session*
*Files analyzed: styles.css, Card.tsx, GameTable.tsx, Lobby.tsx, App.tsx*
