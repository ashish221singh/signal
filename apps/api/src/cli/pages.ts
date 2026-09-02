/**
 * Server-rendered auth pages (B3-D3b, GR-2). Plain, self-contained HTML — NOT the
 * React dashboard — so signup → login → device-approval → deploy works standalone
 * before the frontend exists. Lightly styled with the Signal palette inline (the
 * brand orange `#F78200`), kept intentionally minimal. The dashboard later
 * supersedes these for reporting; they remain the always-available auth fallback.
 */

/** Escape a string for safe interpolation into HTML text / attribute contexts. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  :root { --sg-orange: #F78200; --sg-ink: #1B1A18; --sg-gray: #6B6862; --sg-line: #E7E5E1; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: var(--sg-ink); background: #FCFCFB; display: flex; min-height: 100vh;
    align-items: center; justify-content: center; }
  .card { background: #fff; border: 1px solid var(--sg-line); border-radius: 12px;
    padding: 32px; width: 100%; max-width: 380px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { color: var(--sg-gray); margin: 0 0 20px; font-size: 14px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 12px 0 4px; }
  input { width: 100%; padding: 10px 12px; border: 1px solid var(--sg-line); border-radius: 8px;
    font-size: 15px; }
  input:focus { outline: 2px solid var(--sg-orange); border-color: var(--sg-orange); }
  button { width: 100%; margin-top: 20px; padding: 11px; border: 0; border-radius: 8px;
    background: var(--sg-orange); color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
  button.secondary { background: #fff; color: var(--sg-ink); border: 1px solid var(--sg-line); }
  a.gbtn { display: flex; align-items: center; justify-content: center; gap: 10px;
    margin-top: 20px; padding: 11px; border: 1px solid var(--sg-line); border-radius: 8px;
    background: #fff; color: var(--sg-ink); font-size: 15px; font-weight: 600;
    text-decoration: none; }
  a.gbtn:hover { background: #FAFAF9; }
  a.gbtn svg { width: 18px; height: 18px; }
  .divider { display: flex; align-items: center; gap: 12px; margin: 20px 0 4px;
    color: var(--sg-gray); font-size: 13px; }
  .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--sg-line); }
  .row { display: flex; gap: 10px; }
  .row button { margin-top: 0; }
  .msg { margin-top: 16px; padding: 10px 12px; border-radius: 8px; font-size: 14px; }
  .msg.err { background: #FEECEC; color: #8A1C1C; }
  .msg.ok { background: #EAF7EE; color: #1B6B33; }
  .code { font: 20px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 2px;
    padding: 12px; background: #F7F7F6; border-radius: 8px; text-align: center; margin: 8px 0 4px; }
  a { color: #B25B00; }
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>${escapeHtml(title)} · Signal</title>
<style>${STYLE}</style>
</head><body><main class="card">${body}</main></body></html>`;
}

/** GET /signup — posts to the B1 signup endpoint (fetch → redirect on success). */
export function signupPage(): string {
  return layout(
    'Sign up',
    `<h1>Create your Signal account</h1>
<p class="sub">One owner, one account.</p>
<form id="f">
  <label for="account_name">Company / account name</label>
  <input id="account_name" name="account_name" required autocomplete="organization" />
  <label for="name">Your name</label>
  <input id="name" name="name" required autocomplete="name" />
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required autocomplete="email" />
  <label for="password">Password</label>
  <input id="password" name="password" type="password" minlength="8" required autocomplete="new-password" />
  <button type="submit">Create account</button>
</form>
<div id="msg"></div>
<p class="sub" style="margin-top:16px">Already have an account? <a href="/login">Log in</a></p>
<script>
const f = document.getElementById('f'), msg = document.getElementById('msg');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(f).entries());
  const res = await fetch('/v1/console/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), credentials: 'same-origin',
  });
  if (res.status === 201) { window.location.href = '/login'; return; }
  const data = await res.json().catch(() => ({}));
  msg.innerHTML = '<div class="msg err">' + ((data.error && data.error.message) || 'Signup failed') + '</div>';
});
</script>`,
  );
}

/** The Google "G" mark + "Continue with Google", linking to the OAuth start route. */
function googleButton(next: string): string {
  const href = `/v1/console/auth/google?next=${encodeURIComponent(next)}`;
  return `<a class="gbtn" href="${escapeHtml(href)}">
  <svg viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92a8.78 8.78 0 0 0 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.34A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.94H.96a9 9 0 0 0 0 8.12l3.01-2.34z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.94l3.01 2.34C4.68 5.16 6.66 3.58 9 3.58z"/></svg>
  Continue with Google
</a>`;
}

/**
 * GET /login — posts to the B1 login endpoint. `next` (a same-origin path) is where
 * we redirect on success; defaults to `/`. When Google login is configured, a
 * "Continue with Google" button is shown above the password form (F3).
 */
export function loginPage(next: string, opts: { googleEnabled?: boolean } = {}): string {
  const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
  const google = opts.googleEnabled ? `${googleButton(safeNext)}<div class="divider">or</div>` : '';
  return layout(
    'Log in',
    `<h1>Log in to Signal</h1>
<p class="sub">Access your dashboard and approve CLI logins.</p>
<div id="banner"></div>
${google}<form id="f">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required autocomplete="email" />
  <label for="password">Password</label>
  <input id="password" name="password" type="password" required autocomplete="current-password" />
  <button type="submit">Log in</button>
</form>
<div id="msg"></div>
<p class="sub" style="margin-top:16px">No account? <a href="/signup">Sign up</a></p>
<script>
const f = document.getElementById('f'), msg = document.getElementById('msg');
const next = ${JSON.stringify(safeNext)};
const errs = {
  google: 'Google sign-in failed. Please try again.',
  google_state: 'Google sign-in expired. Please try again.',
  google_unverified: 'Your Google email is not verified.',
};
const err = new URLSearchParams(location.search).get('error');
if (err && errs[err]) {
  document.getElementById('banner').innerHTML = '<div class="msg err">' + errs[err] + '</div>';
}
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(f).entries());
  const res = await fetch('/v1/console/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), credentials: 'same-origin',
  });
  if (res.status === 200) { window.location.href = next; return; }
  const data = await res.json().catch(() => ({}));
  msg.innerHTML = '<div class="msg err">' + ((data.error && data.error.message) || 'Login failed') + '</div>';
});
</script>`,
  );
}

/**
 * GET /cli/approve — the session-guarded device-approval page. Shows the user_code
 * and Approve/Deny buttons that POST back to this route. `csrfNote` is informational
 * only (the session cookie is sameSite=strict, which is the CSRF defense here).
 */
export function approvePage(userCode: string): string {
  const safeCode = escapeHtml(userCode);
  return layout(
    'Approve CLI login',
    `<h1>Approve CLI login</h1>
<p class="sub">A command-line tool is requesting access to your account.</p>
<div class="code">${safeCode}</div>
<p class="sub">Confirm this matches the code shown in your terminal.</p>
<form method="POST" action="/cli/approve">
  <input type="hidden" name="user_code" value="${safeCode}" />
  <div class="row">
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
  </div>
</form>`,
  );
}

/** Terminal result page after approve/deny (or an invalid/expired code). */
export function approveResultPage(kind: 'approved' | 'denied' | 'invalid'): string {
  const map = {
    approved: {
      title: 'Approved',
      html: '<div class="msg ok">CLI login approved. You can return to your terminal.</div>',
    },
    denied: {
      title: 'Denied',
      html: '<div class="msg err">CLI login denied. No token was issued.</div>',
    },
    invalid: {
      title: 'Invalid code',
      html: '<div class="msg err">That code is unknown, already used, or expired.</div>',
    },
  } as const;
  return layout(map[kind].title, `<h1>${map[kind].title}</h1>${map[kind].html}`);
}
