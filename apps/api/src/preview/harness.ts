/**
 * Standalone hosted-link preview harness (F2-D7, F2-D16). A single self-contained
 * HTML page that loads the bundled web-core IIFE (served at `/s/preview/web-core.js`)
 * and mounts a workflow's config with a DEFAULT, NON-PERSISTING `SheetHost`.
 *
 * Preview mode is deliberately read-only: `submit` echoes the answer to the page
 * (and console) but does NOT hit the API — so preview needs no publishable key, no
 * schema change, and can never pollute real metrics (chosen over the persist-flag
 * option in F2-D16 because it keeps the surface zero-write and migration-free).
 * `redirect`/`store_review` are shown but inert. Uploads are disabled in preview.
 *
 * The config is injected as a JSON literal, HTML-escaped defensively even though
 * it is server-built from validated columns.
 */
import type { WorkflowConfig } from '@signal/web-core';

/** Escape a JSON string for safe embedding inside a <script> block. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

export interface HarnessOptions {
  config: WorkflowConfig;
  /** Path the page loads the web-core IIFE bundle from (same-origin). */
  bundleUrl: string;
}

export function previewHarnessPage({ config, bundleUrl }: HarnessOptions): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Signal preview</title>
<style>
  :root { --sg-orange: #F78200; --sg-ink: #1B1A18; --sg-gray: #6B6862; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: var(--sg-ink); background: #F4F3F1; min-height: 100vh; }
  .banner { position: fixed; top: 0; left: 0; right: 0; z-index: 1;
    background: var(--sg-ink); color: #fff; text-align: center; padding: 8px 12px; font-size: 13px; }
  .banner b { color: var(--sg-orange); }
  .stage { display: flex; align-items: center; justify-content: center; min-height: 100vh;
    padding: 24px; }
  .hint { color: var(--sg-gray); text-align: center; max-width: 320px; }
  #echo { position: fixed; bottom: 12px; left: 12px; right: 12px; max-width: 520px; margin: 0 auto;
    background: #fff; border: 1px solid #E7E5E1; border-radius: 8px; padding: 10px 12px;
    font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #1B6B33; display: none;
    white-space: pre-wrap; word-break: break-all; }
</style>
</head><body>
<div class="banner">Signal <b>preview</b> — responses are <b>not</b> recorded</div>
<div class="stage"><div class="hint" id="hint">Loading preview…</div></div>
<div id="echo"></div>
<script src="${bundleUrl}"></script>
<script>
(function () {
  var config = ${safeJson(config)};
  var echo = document.getElementById('echo');
  var hint = document.getElementById('hint');
  function show(label, data) {
    echo.style.display = 'block';
    echo.textContent = label + '\\n' + JSON.stringify(data, null, 2);
  }
  // A default, non-persisting preview SheetHost (F2-D16): submit echoes, never posts.
  var host = {
    submit: function (answer) { show('SUBMIT (preview — not recorded)', answer); return Promise.resolve(); },
    dismiss: function (reason) { show('DISMISS (preview)', { reason: reason }); },
    requestUpload: function () { return Promise.reject(new Error('uploads disabled in preview')); },
    openUrl: function (url) { show('OPEN_URL (inert in preview)', { url: url }); },
    openReview: function () { show('OPEN_REVIEW (inert in preview)', {}); }
  };
  if (!window.SignalWebCore || typeof window.SignalWebCore.mount !== 'function') {
    hint.textContent = 'Preview bundle failed to load.';
    return;
  }
  hint.textContent = 'This is how your survey will appear.';
  window.SignalWebCore.mount(document.body, config, host);
})();
</script>
</body></html>`;
}

/** Friendly 404 for an expired/invalid/wrong-account preview token (F2-D16). */
export function previewNotFoundPage(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Preview unavailable · Signal</title>
<style>
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #1B1A18; background: #FCFCFB; display: flex; min-height: 100vh; align-items: center;
    justify-content: center; }
  .card { text-align: center; max-width: 360px; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #6B6862; margin: 0; }
</style>
</head><body><main class="card">
  <h1>This preview link has expired</h1>
  <p>Preview links are valid for a short time. Generate a fresh one from your Signal console or CLI.</p>
</main></body></html>`;
}
