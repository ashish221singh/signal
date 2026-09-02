# Signal — Landing, Auth & Dashboard Design

**Date:** 2026-09-02
**Status:** Approved (brainstorm complete)
**Extends:** the generic SaaS pivot (`2026-08-03-generic-saas-pivot-design.md`) and the
built backend/SDK layers (B1–B5, F1–F2).

## Goal

Ship the first user-facing surfaces so a stranger can go from landing page → running
one command → seeing their feedback data. Three surfaces: a landing page, Google login,
and an authenticated app (dashboard + settings). Deliberately minimal — "code + login only."

## Design direction

Pure-white, light-theme only. Apple-grade minimalism, Framer-style restraint: generous
whitespace, hairline dividers, whisper shadows, one accent (`#F78200`) used sparingly.
Type from `@signal/tokens`: Schibsted Grotesk (display), Inter (body/UI), JetBrains Mono
(code/keys/scores). No dark theme. Build with the `frontend-design` /
`design-taste-frontend` skills so it never looks templated.

## The journey

```
LANDING (static, public)
  • one-line pitch + the code:  npx @signal/cli init   [Copy]
  • [ Log in ] button
        |                                    |
   user runs command                    user clicks Log in
        |                                    |
   CLI opens browser --> Google login <------+
        |                    |
   device approved      session cookie set
   key provisioned,          |
   track() wired             v
        |              +--------------+
        +------------> |  DASHBOARD   |
                       |  has data? --+-- yes --> reports (Overview / Reasons / Responses)
                       |              |-- no  --> single empty state:
                       |              |            "No feedback yet. Run: npx @signal/cli init"
                       +------+-------+
                              v
                          SETTINGS
                       • your setup command (copy)
                       • account identity
                       • Log out
```

**Key idea:** running the command is the only thing that *activates* an account
(provisions the publishable key + wires `track()`). The web "Log in" only lets a user
*view* results. Both entry points converge on the same Google login.

## Decisions

1. **The code = one command** — `npx @signal/cli init`. The command IS the signup; it runs
   Google login via the existing B3 device-flow and provisions the key. No per-key snippet
   on the landing page.
2. **Auth = Google via `@fastify/oauth2`**, backed by the existing httpOnly cookie session.
   No paid/managed auth service (no Clerk/WorkOS) — free, self-hosted, no lock-in, reuses
   the session + device-flow already built. Google is the single identity provider behind
   both the web login and the `init` browser step. Public email/password signup is retired
   for the web; `create-admin` CLI stays for internal use.
3. **One empty state** (not two) — the dashboard shows a single "No feedback yet, run the
   command" screen whenever the account has no data, regardless of whether `init` ran.
4. **Activation detection** from existing data — `last_event_at IS NULL` / zero responses →
   empty state; first response flips to reports on next load. No new tracking.

## Surfaces

### Landing (static, in `design/final-version/`)
Single screen, minimal: hairline nav (`signal` wordmark + one **Log in** button); big
Schibsted Grotesk headline + one Inter subhead; the hero **code block**
`npx @signal/cli init` with a Copy button ("Copied ✓"); three tiny muted platform labels
**Web · Android · Hosted link** (honest coverage — no iOS/RN implied); optional thin
footer. No feature grids, testimonials, or pricing.

### Login & activation
- Web: `/auth/google` → consent → `/auth/google/callback` → find-or-create account by
  Google email → set session cookie → `/dashboard`.
- CLI `init`: same Google login inside the device-flow browser step, then provisions the
  key and wires `track()`.

### Dashboard (React app, reuses B4 reporting endpoints, account-scoped)
Calm white reporting console: hairline top bar; period filter (7 / 30 / 90 days); stat
trio (Responses · Positive % · Response rate, big Grotesk figures); per-event table (each
tracked flow + its satisfaction score); row click → event detail (Reasons + Responses
tabs). No trend chart, no NPS. If no data → the single empty state.

### Settings
One column: the setup command (`npx @signal/cli init`) with Copy for reuse; account
identity (email + "Google"); **Log out** as the only real action.

## Platform coverage (honest, as of 2026-09-02)

Built: `@signal/web` (any web app) · `sdk-android` (Android WebView shell) · hosted link
(anywhere). **Not built:** iOS native shell, React Native shell. Landing copy must not
imply iOS/RN until they ship.

## Architecture notes

- Landing page = lightweight static page in `design/final-version/` (fast, SEO).
- Authenticated app (dashboard + settings) = the React app in `apps/studio`, promoted from
  design-lab to the real dashboard, served **same-origin** by the Fastify API (same-origin
  serving + CORS already set up in B2/B4).
- New backend work is small: a Google OAuth route pair + a "has any data" flag on dashboard
  load. Everything else (sessions, device-flow, reporting endpoints) already exists.
- Cleanup: remove duplicate cruft files (`packages/web/src/* 2.ts` / `* 3.ts`,
  `apps/api/src/preview/harness 2.ts` / `3.ts`) when touching that code.

## Out of scope (YAGNI)

iOS/RN shells, dark theme, trend charts, NPS, teams/workspaces, billing, feature-marketing
sections on the landing page.
