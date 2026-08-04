# Signal — Final Version (brand + design system)

Dark-first, code-native identity for the lean, agent-first Signal product.
Palette carried unchanged from the previous system; everything else is new.

## Source of truth
- **`@signal/tokens` (`packages/tokens/tokens.css`)** — the canonical home of all design tokens (colour, type, spacing, radius, motion) plus the self-hosted subset fonts (F1-D17,D19). Dark is the default theme; add class `theme-light` for light. Components reference **semantic** tokens only, never raw ramp values. The styleguide here `<link>`s that file (`../../packages/tokens/tokens.css`); code consumers (web-core, shells) import the `tokensCss` string. **No duplicate token file.**
- **`design-system.html`** — the living styleguide. Open it to see logo, colour, type, components, product surface, motion, and voice. Has a light/dark toggle.

## Logo
- **Mark:** "Echo" — two rounded blocks, different sizes, misaligned (a block + its signal). **Static.**
- **Wordmark:** `signal`, lowercase, **JetBrains Mono**, optional blinking cursor. Sentence-case `Signal` for formal/legal.
- Files: `logo/echo-mark.svg` (transparent), `logo/echo-tile.svg` (app icon), `logo/echo-lockup.html`, `logo/echo-hero.html`.
- Colours: ink `#191815`, paper `#FCFCFB`, or orange `#F78200` only. Clear space = height of the small block. Never recolour/rotate/re-space.

## Type
- **JetBrains Mono** — wordmark, display, headings, code, labels (the brand voice).
- **Inter** — body & UI text (readability).

## Colour (unchanged palette)
Accent orange `#F78200`; warm-neutral ramp; blue `#0094DD` (info); green/red status. See `tokens.css` and the styleguide for semantic mappings per theme.

## Motion
Smooth, purposeful, futuristic. Logo is static — motion lives in transitions, reveals, and the bottom sheet. Tokens: `fast/base/slow/sheet` durations, `ease-out/ease-sheet` curves. Honours `prefers-reduced-motion`.

## Exploration history
`logo/concepts*.html` hold the rejected directions (pulse, signal-S, aperture, orange chevron, mirrored-Y, caret/spike/loop/bubble, font study). The previous design system + blocky-S logo are **deferred** — see `../DEFERRED.md`.

## Next
Landing page (hero → onboard → agent SDK setup → reporting) and the lean-v1 product screens, all built on `tokens.css`.
