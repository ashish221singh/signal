# Sheet Bridge v1 — cross-language contract

> The single cross-language contract between **web-core** (the pure sheet
> renderer, F1) and its **shells** (web SDK, native WebView shells, hosted-link;
> built in F2). Authored in F1 (GR-2), consumed by F2. `bridge_version: 1`.

## Why this exists

web-core is pure: it renders a `WorkflowConfig` and drives the state machine, but
it never touches the network. Everything impure is delegated to a **host**. On the
web the host is a plain JS object (the `SheetHost` interface — direct function
calls). Inside a native WebView the *same* intents cross the JS↔native boundary as
**JSON messages**: Android via `@JavascriptInterface` + `evaluateJavascript`, iOS
via `WKScriptMessageHandler` + `evaluateJavaScript`. Native shells never parse the
full config (they can't consume the TS contracts) — they relay the eligibility
JSON straight into the bundled web-core and implement only the small, stable
message schema below plus the eligibility request/response envelope.

## Direction & messages

```
host → core:  INIT           { config, config_version, bridge_version }
core → host:  READY          {}                       // core mounted, awaiting INIT
core → host:  SUBMIT         { answer }                // record (precious)
core → host:  DISMISS        { reason }                // swipe|backdrop|esc|back
core → host:  REQUEST_UPLOAD { fileRef }               // → UPLOAD_RESULT
host → core:  UPLOAD_RESULT  { fileRef, url? , error? }
core → host:  OPEN_URL       { url }                   // redirect
core → host:  OPEN_REVIEW    {}                        // native store review
core → host:  RESIZE         { height }                // native sizes the WebView
```

Every message is `{ "type": <NAME>, "bridge_version": 1, ...payload }`. The
`READY`/`INIT` handshake lets the shell wait until the WebView's JS is live before
handing over the config. Unknown message `type`s are **ignored** (forward-compat).

### Mapping to the web `SheetHost`

| Bridge message      | `SheetHost` method            | Notes |
|---------------------|-------------------------------|-------|
| `SUBMIT`            | `submit(answer): Promise`     | Resolves when persisted/queued (outbox is the shell's, F2). A rejection is a hard failure ⇒ the sheet shows Retry. |
| `DISMISS`           | `dismiss(reason)`             | Fire-and-forget. |
| `REQUEST_UPLOAD` / `UPLOAD_RESULT` | `requestUpload(file): Promise<string>` | The shell presigns + PUTs and returns the stored URL. On error the answer still submits text-only. |
| `OPEN_URL`          | `openUrl(url)`                | Host decides tab / in-app browser. |
| `OPEN_REVIEW`       | `openReview()`                | No-op / graceful fallback where no store exists (e.g. web). |
| `RESIZE`            | `onResize?(height)`           | Optional; native shells size the WebView. |

## Payload shapes

### `INIT { config, config_version }`
`config` is the B5 eligibility config (`EligibilityConfig` from `@signal/contracts`):
`trigger_id`, `campaign_id`, `metric_type`, `header`, `rating_type`,
`rating_scale_max`, `positive_threshold`, `chips_on_negative`,
`other_requires_text`, `other_allows_image`, `positive_action`, `negative_action`,
`skip_enabled`. `config_version` drives the renderer↔config handshake (F1-D10): a
newer version renders what it understands and ignores unknown *optional* fields;
an unknown *required* field fails closed (the core does not mount and emits
`DISMISS { reason: "config_invalid" }`).

### `SUBMIT { answer }`
`answer` is web-core's transport-agnostic `Answer`:
```jsonc
{
  "trigger_id": "…",
  "rating_value": 3,          // 1..3 emoji scale
  "positive": true,           // rating >= positive_threshold
  "other_text": "…",          // optional, trimmed (negative branch)
  "other_image_url": "https://…"  // optional, from UPLOAD_RESULT
}
```
The shell maps this onto the wire `ResponseBody` (adding `device_os`,
`app_version`, `shown_at`/`responded_at`, `session_age_days`, `location`) and
flushes it through the outbox with `trigger_id` idempotency.

### `DISMISS { reason }`
`reason ∈ swipe | backdrop | esc | back | config_invalid`. Backend semantics:
dismiss = cooldown, submit = never re-ask, keyed by `trigger_id` (the core only
reports the event).

### `REQUEST_UPLOAD { fileRef }` → `UPLOAD_RESULT { url | error }`
The core has already applied guardrails (type ∈ jpg/png/webp, downscale to a max
dimension, size cap). `fileRef` identifies the picked file across the boundary
(the web host receives the actual `File`). On `error`, the core surfaces
"couldn't attach" and lets the user submit **without** the image.

## Ordering guarantees

- `SUBMIT` is emitted **before** any `OPEN_URL` / `OPEN_REVIEW` — the response is
  recorded before a navigation can lose it (F1-D4).
- Exactly one `SUBMIT` per sheet (double-submit guarded).
- `DISMISS` during `submitting` still lets the in-flight `SUBMIT` complete via the
  host/outbox; the UI just closes.

## Versioning

`bridge_version: 1`. Additive changes bump the version; receivers ignore unknown
message types and unknown payload fields so an older bundled shell keeps working
with a newer core (and vice-versa).
