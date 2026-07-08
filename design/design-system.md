# Signal Design System — v1.0

The visual and interaction language for everything Signal: the Console (web), the SDK bottom sheet (Android), and any future surface. Canonical tokens live in [`tokens.css`](tokens.css); the living showcase is [`signal-design-system.html`](signal-design-system.html); final logo assets are in [`logo/final/`](logo/final/).

**One sentence:** clean white canvas, warm gray structure, orange acts, blue informs — fast and quiet by default, expressive only at brand moments.

---

## 1. Brand

### Mark
The Signal mark is a **full-bleed S**: a square whose entire body forms the letter — bars run edge to edge, the two notches are the only negative space. Corner radius is 20/96 (~21%) of the mark's width.

| File | Use |
|---|---|
| `logo/final/signal-mark.svg` | The mark. Favicon, app icon, nav, splash — everywhere |
| `logo/final/signal-mark-mono-white.svg` | On dark backgrounds |
| `logo/final/signal-mark-mono-ink.svg` | Single-color print / monochrome contexts |
| `logo/final/favicon.svg` | Browser favicon |

### Wordmark & lockup
- Wordmark: **`signal`** — Schibsted Grotesk Bold, lowercase, letter-spacing −0.028em
- Lockup: mark height = cap height × 1.18; gap between mark and wordmark = 33% of mark height
- Clear space: one notch height (25% of mark) on all sides
- Minimum mark size: 16px (solid variant only)

### Brand rules
- Mark colors: orange `#F78200`, white, or ink `#191815`. Nothing else, no gradients, no shadows, no outlines, no rotation.
- The mark ships as **one shape, always whole** — never redraw, fragment, or decompose it.

---

## 2. Color

### Principle
**60% white · 30% warm gray · 10% color.** Orange = action and brand. Blue = data and information. They never compete on the same element.

### Brand scales (canonical values in tokens.css)
- **Orange** `--sg-orange-50…900` — brand at `500 #F78200`; text-safe on white from `700 #B25B00`
- **Blue** `--sg-blue-50…900` — brand at `500 #0094DD`; text/link-safe on white from `700 #00659A`
- **Gray** `--sg-gray-25…900` — warm-tinted; ink is `900 #191815` (never pure black)

### Semantic
| Token | Value | Use |
|---|---|---|
| `--sg-success` | `#178A5E` on `#E8F6F0` | Active states, positive deltas, confirmations |
| `--sg-warning` | `#B7791F` on `#FCF3E3` | Paused states, caution |
| `--sg-danger` | `#CC3D33` on `#FBEDEC` | Errors, destructive actions |
| `--sg-info` | blue-700 on blue-50 | Informational badges, sync states |

### Hard rules (accessibility)
1. **Labels on orange are white** (`--sg-action-ink`) — a deliberate, documented brand exception to AA contrast, allowed **only** for button/CTA labels at 600 weight and 14px+. Hover always darkens the fill (orange-600) to gain contrast. Body or reading text never sits on orange.
2. Orange as *text* on white: orange-700 or darker only.
3. Blue as *text/links* on white: blue-700 or darker only. Blue-500 is fine for UI components and charts (3:1 rule).
4. One orange (primary) action per view. If two things are orange, neither is primary.
5. Charts: history in blues; the current/actionable period is the only orange element.

---

## 3. Typography

| Role | Font | Why |
|---|---|---|
| Display / headings | **Schibsted Grotesk** (500/600/700) | Geometric warmth matching the mark |
| UI / body | **Instrument Sans** (400/500/600) | Clean, characterful, dense-data friendly |
| Mono (tokens, IDs, data annotations) | **Spline Sans Mono** (400/500/600) | screen_ids, hex codes, spec labels |

### Scale
| Token | Spec | Use |
|---|---|---|
| `--sg-text-display` | Schibsted 600 · 34–46/1.08 · −0.022em | Hero/marketing only |
| `--sg-text-h1` | Schibsted 600 · 30/1.15 · −0.015em | Page titles |
| `--sg-text-h2` | Schibsted 600 · 22/1.25 · −0.01em | Section titles |
| `--sg-text-h3` | Schibsted 600 · 17/1.35 | Card titles |
| `--sg-text-body` | Instrument 400 · 15/1.55 | Default text |
| `--sg-text-sm` | Instrument 400 · 13/1.5 | Secondary, table cells |
| `--sg-text-caption` | Instrument 500 · 12/1.4 | Labels, helper text |
| `--sg-text-overline` | Spline Mono 600 · 11 · +0.12em uppercase | Spec/section labels |

Max 3 type sizes per screen. Body text never below 13px (web) / 14sp (Android).

---

## 4. Surface

- **Spacing:** 4px base grid (`--sg-space-1…24`). Related items 8–12, groups 24–32, sections 48–96.
- **Radius:** `sm 6` chips/badges · `md 10` buttons/inputs · `lg 14` cards · `xl 20` sheets/modals · `full` pills. The family echoes the mark's corner.
- **Elevation:** layered shadows carry structure, **not solid borders** (`--sg-shadow-1/2/3`, `--sg-shadow-sheet`). Hairline borders (`--sg-line-subtle`) only for table rows and section dividers.
- Background layers: white → `gray-25` (subtle) → `gray-50` (sunken wells).

---

## 5. Motion

Motion answers three questions — *did it register, where did it come from, what changed*. If it answers none, it doesn't animate.

### Tokens
| Token | Value | Use |
|---|---|---|
| `--sg-motion-fast` | 140ms | Hovers, toggles, icon swaps |
| `--sg-motion-base` | 200ms | Tabs, dropdowns, state changes |
| `--sg-motion-slow` | 320ms | Toasts, modals, reveals |
| `--sg-motion-sheet` | 480ms | Bottom sheet only |
| `--sg-ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | Enters |
| `--sg-ease-inout` | `cubic-bezier(0.65, 0, 0.35, 1)` | On-screen moves |
| `--sg-ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Exits |
| `--sg-ease-sheet` | `cubic-bezier(0.32, 0.72, 0, 1)` | Sheets/drawers (iOS-native curve) |

### Recipes
- **Enter:** opacity 0→1 · translateY 8–14px→0 · blur 4–6px→0, `--sg-ease-out`
- **Exit:** always subtler — smaller travel (−6px), faster, `--sg-ease-exit`
- **Press:** `scale(0.96–0.97)` on `:active`, ~90ms
- **Icon swap:** opacity + scale(.8) + blur(3), 140ms
- **State bridge:** blur the old state out (150ms) before the new rises in (260ms) — masks layout shifts

### Laws
1. Animate `transform` / `opacity` / `filter` **only**. Never width/height/top/left.
2. High-frequency interactions (row clicks, keyboard) get **no motion**.
3. Popovers grow from their trigger (`transform-origin`).
4. One expressive moment per surface (logo assembly, check-draw). Never two.
5. No looping/pulsing attention-seekers. Ever.
6. `prefers-reduced-motion` collapses everything to instant — shipped globally in tokens.css.
7. Never bare `ease` — always a token curve.

---

## 6. Components (key decisions)

- **Buttons:** primary = orange-500 fill + **white label** (600 weight, 14px+; hover → orange-600, press scale .97); secondary = white + shadow-1 (hover shadow-2); ghost; danger = `--sg-danger` + white. Heights 32/40/48, radius 10.
- **Inputs:** shadow-ring instead of border; focus = 1.5px blue-500 ring; error = 1.5px danger ring + danger helper text. Labels above, 12px/600.
- **Chips (SDK reasons):** pill, white + shadow; selected = orange-50 bg, orange-800 text, 1.5px orange-400 ring.
- **Toggle:** 44×26 pill, thumb slides with `--sg-ease-sheet`, on = orange-500.
- **Tabs:** sunken gray track, white ink-pill slides between tabs (200ms sheet curve), panel crossfades with the rise-in recipe.
- **Status badges:** tinted bg + dot + text — Active/success, Draft/gray, Paused/warning, Syncing/info.
- **Toasts:** ink-900 bg, bottom-right, enter with the full recipe (320ms), exit subtler, auto-dismiss 4s, max 3 stacked.
- **Tables:** hairline rows, mono overline headers, hover = `gray-25` fill (140ms), first column ink/600.
- **KPI cards:** mono label, Schibsted 34px value, delta in success/danger, spark bars in blue-100 with the current bar orange.
- **Skeletons:** gray-100 shimmer, 1.8s linear loop, shapes match real content.

### The bottom sheet (SDK)
- Enters `--sg-motion-sheet` + `--sg-ease-sheet` over a 42% ink scrim; radius 20 top; grabber handle.
- Branch transitions use the state-bridge recipe. Selected star pops 1.25× once — the single tactile confirmation.
- Thank-you check draws itself (stroke-dash, ~340ms) — the one expressive moment, honoring the peak-end rule.
- **Skip (✕) always visible top-right, one tap, never guilt-tripped.**
- Touch targets ≥ 44px (48dp Android). One decision per state.

---

## 7. Voice in one line

Orange acts. Blue informs. White listens.
