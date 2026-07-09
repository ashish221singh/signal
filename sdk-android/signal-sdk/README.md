# Signal SDK (Android)

In-app CSAT / CES feedback for BeatRoute. Renders a config-driven bottom sheet
(RATING → POSITIVE / NEGATIVE / OTHER) and enqueues responses for delivery.

> A full integration guide (setup, `Signal.init`, triggers, sample app) lands in
> Task H.2. This file currently documents only the manual QA checklist for the
> sheet UI polish (Task E.5).

## Manual QA checklist

Robolectric covers bottom-inset padding, the scrollable content wrapper, the
`values-night` dark paper, and rating content descriptions. The items below need
a real device / emulator and a human to verify — motion, focus order, and true
inset/rotation behaviour can't be asserted in unit tests.

- **Rotation mid-flow** — open the sheet, select a low rating to reach NEGATIVE
  (or OTHER), rotate the device, and confirm the sheet survives the config
  change without losing typed text / crashing and re-lays out correctly.
- **Keyboard overlap on OTHER free-text** — in the OTHER sub-branch, focus the
  text field so the soft keyboard shows. The Submit button must stay visible
  above the keyboard (bottom IME inset padding), and the content must scroll if
  the sheet is shrunk.
- **Gesture-nav insets** — on a device using gesture navigation, confirm the
  Submit button and sheet bottom edge are not hidden behind the nav bar
  (bottom `systemBars` inset padding applied).
- **Small vs large devices** — verify on a compact phone (sheet full-width) and
  on a large phone / tablet (`sw600dp`: sheet width-capped and centred, not
  stretched edge-to-edge).
- **Long chip list** — configure many `chips_on_negative` entries and confirm
  the chip area scrolls inside the capped-height content region instead of
  clipping the Submit button.
- **Dark mode** — toggle system dark theme and confirm the sheet renders the
  dark paper / near-white ink (brand orange unchanged), with legible contrast
  in every state.
- **Reduced motion** — enable "Remove animations" (or set animator duration
  scale to 0 in Developer options) and confirm state transitions swap instantly
  with no fade; then re-enable and confirm the subtle fade returns.
- **TalkBack focus order** — enable TalkBack and confirm a sensible traversal:
  header → close, then rating elements announce "Rate N of M", chips announce
  their label + selected state, and Submit / Add photo are reachable and
  labelled.
