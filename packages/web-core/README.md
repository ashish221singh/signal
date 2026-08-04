# @signal/web-core

The **one** framework-agnostic renderer of the Signal feedback bottom sheet (F1).
It renders a workflow config (emoji rating → branch → positive action / negative
comment+photo → submit → post-submit action) as a polished, accessible, animated
sheet inside a **Shadow DOM** root, and is reused everywhere: the web SDK, native
WebView shells, and the hosted preview link.

**Pure render + state machine — it never touches the network.** Everything impure
is delegated to a `SheetHost` you provide (see the bridge contract:
[`docs/sheet-bridge-v1.md`](../../docs/sheet-bridge-v1.md)).

## Install / build

```bash
pnpm --filter @signal/web-core build   # → dist/web-core.mjs (ESM), .global.js (IIFE), .d.ts
pnpm --filter @signal/web-core size    # assert the ≤35KB gzip core budget (excl. fonts)
```

No runtime dependencies. Target ES2020. The design tokens (`@signal/tokens`) and
the emoji SVGs are inlined; the self-hosted subset fonts ride along as data-URI
`@font-face` rules (no Google Fonts fetch).

## Embedding contract

```ts
import { mount } from '@signal/web-core';
import type { SheetHost, WorkflowConfig } from '@signal/web-core';

const host: SheetHost = {
  submit(answer)        { /* record; resolve when persisted/queued */ return persist(answer); },
  dismiss(reason)       { /* report the dismissal (cooldown vs never-ask is server-side) */ },
  requestUpload(file)   { /* presign + PUT; resolve to the stored URL */ return upload(file); },
  openReview()          { /* native in-app store review; no-op on web */ },
  openUrl(url)          { /* redirect; you decide tab / in-app browser */ },
  onResize(height)      { /* optional: native shells size the WebView */ },
};

const handle = mount(document.body, config as WorkflowConfig, host);
// later, to force-close:
handle.close();
```

- `config` is the B5 eligibility config (`EligibilityConfig` from
  `@signal/contracts`) plus an optional `config_version` (F1-D10).
- `mount` renders into a fresh Shadow DOM host appended to `root`.
- **One sheet at a time** (F1-D13): a second `mount` while one is open is a no-op
  and returns the existing handle.
- **Fail closed:** on a missing/malformed required field the core does **not**
  render and calls `host.dismiss('config_invalid')`.

## What it guarantees

- **Pure/transport-agnostic:** the core only calls `host.*`; it never `fetch`es.
- **State machine:** `rating → detail → submitting → done`, with `done` resolving
  the branch's post-submit action (`none|thanks|redirect|store_review`). The
  response is recorded **before** any redirect. `detail` is skipped when the
  negative branch has nothing to capture (F1-D12). Dismiss is reachable from every
  state.
- **Rating = brand SVG emoji** (`currentColor`, themeable/animatable), never
  system emoji. `positive = rating >= positive_threshold`.
- **Negative branch:** optional/required comment (whitespace-only rejected) +
  optional photo with client guardrails (jpg/png/webp, downscale, size cap) routed
  through `host.requestUpload`; on upload failure the answer still submits
  text-only.
- **Motion / theming / a11y:** transitions from tokens; `prefers-color-scheme`
  dark/light; `prefers-reduced-motion` = instant; `role="dialog"` + `aria-modal`,
  focus trap + restore, Esc to dismiss, arrow keys to pick a rating, an
  `aria-live` submit announcement, and 44px tap targets.

## Demo

`demo/standalone.html` mounts the sheet full-page with a mock `SheetHost` that
logs every call. Build first, then serve the package folder and open the page:

```bash
pnpm --filter @signal/web-core build
npx serve packages/web-core   # then open /demo/standalone.html
```

Toggle the branch capture and the positive/negative actions to click through both
branches and every post-submit action type.

## Size budget

The core (code + token CSS + emoji, **excluding** the font files) must stay
**≤ 35 KB gzip** (F1-D15), asserted by `scripts/size-check.mjs` (wired into the
package `typecheck`). Current core: ~8.7 KB gzip.
