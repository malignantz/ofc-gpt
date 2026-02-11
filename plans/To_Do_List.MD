# OFC-GPT — UI Improvement To-Do List

Comprehensive analysis of style, motion, interaction, and polish opportunities.
Generated from full code review + live browser observation.

---

## 1. CARD RENDERING — Text → Graphical Cards

**Priority: HIGH | Impact: Transformative**

Currently cards are plain text divs (e.g. "Q♠", "8♣") rendered at 44×64px. This is functional but looks like a prototype. Real card games use graphical card faces.

- [ ] **Replace text cards with SVG/image card faces** — Use a standard open-source playing card SVG set (e.g. [svg-cards](https://github.com/htdebeer/SVG-cards)). Render proper card faces with pips, court figures, etc.
- [ ] **Fallback**: If full SVG cards are too heavy, create a hybrid: larger rank text + multiple suit pips arranged in the traditional pattern (e.g. a 9♠ shows 9 spade pips in the classic 3-3-3 layout).
- [x] **Card back design** — Added patterned card-back visual (cross-hatch over crimson gradient) for opponent hidden hand cards. Shows face-down cards proportional to opponent's pending card count.
- [x] **Increase card size** — Increased from 44×64px to 54×78px default (clamp-based), 44×64px mobile. Updated all related custom properties and empty slot sizes.

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

- [x] **Add a dark mode** — Full dark mode with CSS custom properties. Dark green felt-inspired palette. Toggle in Settings modal, persists to localStorage, respects `prefers-color-scheme`. Comprehensive dark overrides for all UI elements.
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
- [x] **Settings modal organization** — Split into "Display" (Player Name, 4-Color Deck, Dark Mode) and "Gameplay" (CPU Profile, Hide Submit) groups with headers.
- [x] **Scoreboard data** — Enhanced with rounds played, best score, and win/loss streak tracking. Displayed in both the score panel rivalry view and the scoreboard modal.

## 9. TYPOGRAPHY & SPACING

**Priority: LOW | Impact: Subtle refinement**

- [x] **Font loading** — Added Google Fonts import in index.html for Archivo (400-700), IBM Plex Sans (400-700), and IBM Plex Mono (500-600) with preconnect hints.
- [x] **Line label spacing** — Split count into separate `<span className="line-count">` with lighter weight (400), reduced opacity (0.5), and smaller font (10px).
- [x] **Status message sizing** — Added `min-height: 28px` to `.status-message` to prevent layout shift.
- [x] **Monospace alignment** — Ensured consistent `font-weight: 500/600`, `font-variant-numeric: tabular-nums`, and `line-height` across `.lobby-room-code`, `.lobby-room-players`, and `.status-room`.

## 10. PERFORMANCE & ACCESSIBILITY

**Priority: MEDIUM | Impact: Quality**

- [x] **Focus management in modals** — Added `useFocusTrap` hook that traps Tab/Shift+Tab within modal, focuses first element on open, and restores focus on close. Applied to all three modals (Rules, Scoreboard, Settings).
- [x] **Keyboard card placement** — Arrow keys (Left/Right) to select pending cards + number keys (1/2/3) for top/middle/bottom placement. Works in both initial and play phases.
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

- [x] **Confetti on sweep** — When a player sweeps all 3 lines, triggers a 3-second CSS confetti burst animation with 40 colorful particles. Respects `prefers-reduced-motion`.
- [x] **Streak counter** — Win/loss streak tracking persisted to localStorage. Displayed as "🔥 X win streak" in rivalry panel and scoreboard when streak > 1.
- [ ] **Card flip for reveal** — When showing final score, flip opponent's cards from face-down to face-up sequentially for dramatic reveal.
- [x] **Dealer chip animation** — The "D" dealer chip now animates in with a scale+rotate entrance (0.5s cubic-bezier). Respects `prefers-reduced-motion`.
- [ ] **Turn timer visual** — If a turn timer is added later, show a circular progress ring around the active player's section.

---

## REMAINING ITEMS (Future)

These items are deferred as they require external assets or larger feature work:

1. **SVG/image card faces** — Needs external SVG card asset set
2. **Hybrid pip layout** — Alternative to full SVG cards
3. **Sound effects** — Needs audio files + toggle in settings
4. **Swipe gestures** — Touch gesture library or custom implementation
5. **Card flip reveal** — Requires refactoring opponent card rendering
6. **Turn timer visual** — Depends on turn timer feature being added

---

*Last updated: Final UI polish session*
*Files analyzed: styles.css, Card.tsx, GameTable.tsx, Lobby.tsx, App.tsx, scoreboard.ts*
