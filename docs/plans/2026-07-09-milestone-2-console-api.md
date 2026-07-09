# Milestone 2 — Console API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Every action a PM can take — log in, build/publish/manage campaigns, register screens, watch the numbers — exposed as authenticated `/v1/console/*` endpoints and proven end-to-end over curl. No UI.

**Architecture:** Per `signal-architecture-v1.md` §3. Second route surface on the same Fastify process: `/v1/console/*` behind cookie-session auth (M1's `/v1/sdk/*` stays behind app-key auth). Layering unchanged: routes → services → repositories, Zod contracts at the boundary. Console reads/writes hit Postgres directly; the in-memory campaign cache (M1) is unaffected — it only ever loads `active` campaigns and picks up publishes within its 60s refresh.

**Tech Stack:** adds `@fastify/cookie`, `@fastify/rate-limit`, `@node-rs/argon2` (prebuilt, no native build). Everything else as M1.

**Prerequisites (hard gates):**
1. M1 exit checklist green.
2. **Cooldown reconciliation applied** (`docs/plans/RECONCILE-cooldown-enum-before-M2.md`) — this plan is written in the reconciled language (`after_7_days | after_30_days | after_60_days`, no `daily_cap`, no debounce). If reconciliation is not done, STOP and do it first.

---

## Decisions & Edge Cases (binding — do not re-litigate during execution)

| # | Decision | Rationale / edge case covered |
|---|---|---|
| M2-D1 | New surface `/v1/console/*`, cookie-session auth; `/v1/sdk/*` unchanged | Two audiences, two auth models, one process |
| M2-D2 | **Stateless** signed httpOnly cookie (no session table). `SESSION_SECRET` env; `sameSite=strict`; `secure` in production; 12h expiry. Revocation = rotate secret | Handful of PMs; a session store is YAGNI at this scale |
| M2-D3 | Passwords hashed with `@node-rs/argon2` (prebuilt binaries). **No signup UI** — first admin via CLI | Modern hashing, zero native-build pain; internal tool has no self-registration |
| M2-D4 | Login route rate-limited (5/min/IP) | Blunt brute-force protection |
| M2-D5 | Drafts may be incomplete: `target_id` + content columns nullable. Completeness enforced at publish by **service validation AND a DB CHECK** (`status <> 'active' OR all-required-not-null`) | An incomplete *active* campaign is structurally impossible, not merely discouraged |
| M2-D6 | Delete = **archive** (new `archived` status). Hard `DELETE` only for a draft with zero trigger/response rows | FK-referenced history is never destroyed |
| M2-D7 | Publish is **never** blocked by target `integration_status` | Spec v1.2 / prototype v4; publishing an un-wired screen is harmless (it just never fires) |
| M2-D8 | One active campaign per (target, client), enforced at publish → **409** naming the conflict | The other half of M1-D3; builder can show "clashes with X" |
| M2-D9 | Semantic fields (`metric_type`, `rating_type`, `rating_scale_max`, `positive_threshold`) immutable once the campaign has ≥1 response → **422**. Operational fields stay editable | Changing them would silently redefine historical score math |
| M2-D10 | Reporting scope = dashboard summary + campaign **Overview** only. Reasons/Clients/Responses tabs are **M4**, not built or stubbed here | UI is the last milestone (after M4); stubbing now = dead code rewritten later |
| M2-D11 | Attention strip = 3 hard-coded rules: active-on-non-live-target; response_rate < 0.15; positive_score < 0.60. Constants, not config | Pick the rules now; tune once real data exists |
| M2-D12 | Clients list serves **seeded** clients | Real BeatRoute sync is M4 |
| M2-D13 | Slug collision on target create → **422**, no auto-suffix | Silent `order_completion_2` would poison SDK integration |
| M2-D14 | Written in reconciled cooldown language | Depends on reconciliation landed (prerequisite gate) |
| M2-D15 | `positive_score = count(rating_value >= positive_threshold) / count(responses)`; `response_rate = responses / triggers`. Zero triggers → `null` (rendered "—"), never divide-by-zero | Matches spec §3; null-safe |
| M2-D16 | Same error body as M1: `{ "error": { "code", "message" } }` | One shape everywhere |
| M2-D17 | Integration status transitions via `PATCH /targets/:id/integration-status`: `not_sent→sent_to_engineering`, `any→confirmed_live`; other transitions → 422 | Matches v4 "mark as sent" + manual confirm |
| M2-D18 | `campaigns.created_by` = authenticated PM (session), not a literal | Real audit trail |

---

## PHASE A — Authentication

### Task 1: `console_users` schema + auth env

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Modify: `apps/api/src/env.ts`, `apps/api/src/env.test.ts`
- Create: migration via `db:generate`

**Step 1: Add env (TDD — extend `env.test.ts` first)**

New tests: `SESSION_SECRET` defaults to a dev constant in development/test but **throws in production when unset**; `parseEnv` exposes it.

Add to `env.ts` schema: `SESSION_SECRET: z.string().min(16).optional()`, then in `parseEnv` default it to `'dev-session-secret-not-for-prod'` when `NODE_ENV !== 'production'`, else require it (same fail-fast pattern as `SIGNAL_APP_KEYS`).

**Step 2: Add the table to `schema.ts`**

```ts
export const consoleUserRoleEnum = pgEnum('console_user_role', ['admin', 'editor']);

export const consoleUsers = pgTable('console_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  role: consoleUserRoleEnum('role').notNull().default('admin'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Add `console_users` to the `truncateAll` list in `test/testDb.ts`.

**Step 3: Generate migration** — `pnpm --filter @signal/api db:generate`; confirm the SQL creates the table + enum + unique index on email.

**Step 4: Verify** — `pnpm test` (schema int test still green), `pnpm typecheck`.

**Step 5: Commit** — `feat(api): console_users table and session secret env`

---

### Task 2: Password hashing module

**Files:**
- Create: `apps/api/src/auth/password.ts`
- Test: `apps/api/src/auth/password.test.ts`

**Step 1: Install** — `pnpm --filter @signal/api add @node-rs/argon2`

**Step 2: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });
  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword(hash, 'Tr0ub4dor&3')).toBe(false);
  });
  it('produces distinct hashes for the same input (salted)', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'));
  });
  it('verifyPassword returns false on a malformed hash, never throws', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});
```

**Step 3: Implement**

```ts
import { hash, verify } from '@node-rs/argon2';

export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}
```

**Step 4: Verify green. Step 5: Commit** — `feat(api): argon2 password hashing`

---

### Task 3: Admin-seed CLI

**Files:**
- Create: `apps/api/src/scripts/create-admin.ts`
- Modify: `apps/api/package.json` (`"create-admin": "tsx src/scripts/create-admin.ts"`)

**Step 1: Implement** (no unit test — operational CLI; correctness proven when login works in Task 5)

Reads `--email`, `--name`, `--password` from argv (or env `ADMIN_EMAIL` etc.); validates email + password length (min 10); hashes; upserts into `console_users` by email (update hash/name on conflict). Prints the created/updated email. Exits non-zero with a readable message on bad input.

**Step 2: Verify manually**

```bash
docker compose up -d && pnpm --filter @signal/api db:migrate
pnpm --filter @signal/api create-admin -- --email pm@signal.local --name "PM" --password "changeme123"
docker compose exec postgres psql -U signal -d signal -c "select email, role from console_users;"
```
Expected: one row. Re-run → still one row (upsert).

**Step 3: Commit** — `feat(api): create-admin CLI`

---

### Task 4: Auth contracts

**Files:**
- Create: `packages/contracts/src/console/auth.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/console/auth.test.ts`

**Step 1: Failing test** — `loginRequestSchema` accepts `{email, password}`, rejects bad email / empty password; `sessionUserSchema` accepts `{id, email, name, role}`.

**Step 2: Implement**

```ts
import { z } from 'zod';

export const loginRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const sessionUserSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  role: z.enum(['admin', 'editor']),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;
```

Export via `index.ts` (`export * from './console/auth.js';`).

**Step 3: Verify green. Step 4: Commit** — `feat(contracts): console auth schemas`

---

### Task 5: Login route + cookie + rate limit

**Files:**
- Create: `apps/api/src/auth/session.ts` (cookie helpers)
- Create: `apps/api/src/routes/console/auth.ts`
- Modify: `apps/api/src/app.ts` (register `@fastify/cookie`, `@fastify/rate-limit`, mount console auth)
- Test: `apps/api/test/console-auth.int.test.ts`

**Step 1: Install** — `pnpm --filter @signal/api add @fastify/cookie @fastify/rate-limit`

**Step 2: Failing integration tests**

Scenarios (full app via `buildApp` + inject, Testcontainers DB, admin seeded in test setup):
1. `POST /v1/console/auth/login` with correct creds → 200, body = session user, `Set-Cookie` present, httpOnly
2. Wrong password → 401 `{error.code:'invalid_credentials'}`, no cookie
3. Unknown email → 401 (same shape — no user enumeration)
4. Malformed body → 422
5. 6th login attempt within a minute from one IP → 429

**Step 3: Implement session helpers**

```ts
// apps/api/src/auth/session.ts
import type { FastifyReply, FastifyRequest } from 'fastify';

const COOKIE = 'signal_session';
const MAX_AGE_S = 12 * 60 * 60;

export function issueSession(reply: FastifyReply, userId: string): void {
  reply.setCookie(COOKIE, userId, {
    path: '/', httpOnly: true, sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    signed: true, maxAge: MAX_AGE_S,
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(COOKIE, { path: '/' });
}

export function readSession(request: FastifyRequest): string | null {
  const raw = request.cookies[COOKIE];
  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}
```

**Step 4: Implement login route**

```ts
// apps/api/src/routes/console/auth.ts
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { loginRequestSchema } from '@signal/contracts';
import { verifyPassword } from '../../auth/password.js';
import { clearSession, issueSession, readSession } from '../../auth/session.js';
import type { Db } from '../../db/client.js';
import { consoleUsers } from '../../db/schema.js';

export function consoleAuthRoutes(deps: { db: Db }): FastifyPluginAsync {
  return async (app) => {
    app.post('/login', {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    }, async (request, reply) => {
      const parsed = loginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({ error: { code: 'invalid_body', message: 'invalid login' } });
      }
      const [user] = await deps.db.select().from(consoleUsers)
        .where(eq(consoleUsers.email, parsed.data.email));
      const ok = user ? await verifyPassword(user.passwordHash, parsed.data.password) : false;
      if (!user || !ok) {
        return reply.code(401).send({ error: { code: 'invalid_credentials', message: 'invalid email or password' } });
      }
      issueSession(reply, user.id);
      return reply.code(200).send({ id: user.id, email: user.email, name: user.name, role: user.role });
    });

    app.post('/logout', async (_request, reply) => {
      clearSession(reply);
      return reply.code(204).send();
    });

    app.get('/me', async (request, reply) => {
      const userId = readSession(request);
      if (!userId) return reply.code(401).send({ error: { code: 'unauthorized', message: 'no session' } });
      const [user] = await deps.db.select().from(consoleUsers).where(eq(consoleUsers.id, userId));
      if (!user) return reply.code(401).send({ error: { code: 'unauthorized', message: 'stale session' } });
      return reply.send({ id: user.id, email: user.email, name: user.name, role: user.role });
    });
  };
}
```

**Step 5: Wire into `app.ts`** — register `@fastify/cookie` with `{ secret: env.SESSION_SECRET }` and `@fastify/rate-limit` (global disabled, opt-in per route). Mount `consoleAuthRoutes` under `/v1/console/auth` (this subtree is NOT behind the session guard — login must be reachable).

**Step 6: Verify green. Step 7: Commit** — `feat(api): console login/logout/me with signed cookie and rate limiting`

---

### Task 6: Session guard for protected console routes

**Files:**
- Create: `apps/api/src/plugins/sessionGuard.ts`
- Test: `apps/api/src/plugins/sessionGuard.test.ts`

**Step 1: Failing test** — a route registered under the guard returns 401 without a valid cookie; with a valid signed cookie it passes and `request.consoleUserId` is set.

**Step 2: Implement**

```ts
import type { FastifyPluginAsync } from 'fastify';
import { readSession } from '../auth/session.js';

declare module 'fastify' {
  interface FastifyRequest { consoleUserId?: string }
}

export const sessionGuard: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (request, reply) => {
    const userId = readSession(request);
    if (!userId) {
      return reply.code(401).send({ error: { code: 'unauthorized', message: 'login required' } });
    }
    request.consoleUserId = userId;
  });
};
```

**Step 3: Verify green. Step 4: Commit** — `feat(api): session guard plugin for console routes`

---

## PHASE B — Reference reads

### Task 7: Target + client contracts and list endpoints

**Files:**
- Create: `packages/contracts/src/console/targets.ts`, `packages/contracts/src/console/clients.ts`
- Create: `apps/api/src/routes/console/targets.ts`, `apps/api/src/routes/console/clients.ts`
- Modify: `apps/api/src/app.ts` (mount a guarded `/v1/console` subtree)
- Test: `apps/api/test/console-reference.int.test.ts`

**Step 1: Contracts** — `targetSchema` (id, name, screen_id, trigger_mechanism, integration_status), `clientSchema` (id, name, status). Small `safeParse` unit checks in the contracts package.

**Step 2: Failing integration tests**
1. `GET /v1/console/targets` without cookie → 401
2. With cookie, after seeding 2 targets → 200, array of 2, each matching `targetSchema`
3. `GET /v1/console/clients` with cookie, after seeding 3 clients → 200, array of 3

**Step 3: Implement** the two read routes (plain `db.select()` ordered by name). Mount both, plus future campaign/reporting routes, under one guarded subtree in `app.ts`:

```ts
await app.register(async (consoleApi) => {
  await consoleApi.register(sessionGuard);
  await consoleApi.register(targetRoutes({ db }), { prefix: '/targets' });
  await consoleApi.register(clientRoutes({ db }), { prefix: '/clients' });
  // campaigns + reporting mounted here in later tasks
}, { prefix: '/v1/console' });
```

**Step 4: Verify green. Step 5: Commit** — `feat(api): console targets and clients list endpoints`

---

## PHASE C — Campaign lifecycle

### Task 8: Draft-friendly campaign schema migration

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: migration via `db:generate`
- Test: `apps/api/test/campaign-schema.int.test.ts`

**Step 1: Failing integration test**
1. Insert a campaign with `status='draft'` and NULL `target_id/metric_type/rating_type/rating_scale_max/header_text/positive_threshold` → succeeds
2. Insert/UPDATE to `status='active'` with any of those NULL → **rejected** by the CHECK
3. Insert `status='active'` with all required present + `client_ids` non-empty → succeeds
4. `status='archived'` is an accepted enum value

**Step 2: Modify schema**

- Add `'archived'` to `campaignStatusEnum`.
- Make nullable (drop `.notNull()`): `targetId`, `metricType`, `ratingType`, `ratingScaleMax`, `headerText`, `positiveThreshold`.
- Keep `notNull().default(...)`: `clientIds` (`'[]'`), `chipsOnNegative` (`'[]'`), `askFrequency` (`'after_7_days'`), `status` (`'draft'`).
- Add table CHECK:

```ts
import { check, sql } from 'drizzle-orm';
// in the campaigns table extras array:
check('campaigns_active_complete', sql`
  status <> 'active' OR (
    target_id IS NOT NULL AND metric_type IS NOT NULL AND rating_type IS NOT NULL
    AND rating_scale_max IS NOT NULL AND header_text IS NOT NULL
    AND positive_threshold IS NOT NULL AND jsonb_array_length(client_ids) >= 1
  )
`),
```

**Step 3: Generate migration** — inspect: an `ALTER TYPE ... ADD VALUE 'archived'`, `DROP NOT NULL`s, and the CHECK. (If drizzle-kit emits the enum add-value in the same transaction as a use of it, split into two migration files — Postgres forbids using a new enum value in the same tx that adds it. Here we only add the value, no immediate use, so one file is fine.)

**Step 4: Verify green. Step 5: Commit** — `feat(api): draft-friendly campaign schema — nullable content, archived status, publish-completeness CHECK`

---

### Task 9: Campaign contracts

**Files:**
- Create: `packages/contracts/src/console/campaigns.ts`
- Test: `packages/contracts/src/console/campaigns.test.ts`

**Step 1: Failing tests** cover:
- `campaignDraftCreateSchema` — minimal `{ client_ids?: string[] }`, everything else optional
- `campaignUpdateSchema` — all builder fields optional, but when present validated (e.g. `ask_frequency` ∈ enum, `positive_threshold` int, `header_text` non-empty)
- `campaignSchema` — the full persisted shape returned to the console (all fields incl. `status`, `created_by`, timestamps, nullable content)
- `campaignListItemSchema` — id, header/name, status, target screen_id, client count, updated_at

**Step 2: Implement.** Cooldown enum imported from primitives (reconciled): `z.enum(['after_7_days','after_30_days','after_60_days'])`. No `daily_cap` field anywhere.

**Step 3: Verify green. Step 4: Commit** — `feat(contracts): console campaign draft/update/read schemas (reconciled cooldown)`

---

### Task 10: Create draft + get + list

**Files:**
- Create: `apps/api/src/campaigns/service.ts` (console-side; distinct from the SDK cache), `apps/api/src/routes/console/campaigns.ts`
- Modify: `app.ts` (mount under guarded `/v1/console/campaigns`)
- Test: `apps/api/test/console-campaigns.int.test.ts`

**Step 1: Failing integration tests**
1. `POST /v1/console/campaigns` `{}` → 201, returns a draft with server id, `status='draft'`, `created_by` = session user's id
2. `GET /v1/console/campaigns/:id` → the draft
3. `GET /v1/console/campaigns` → list including it; archived excluded unless `?include=archived`
4. `GET` unknown id → 404
5. No cookie → 401 on all

**Step 2: Implement** create (insert minimal row, `createdBy` from `request.consoleUserId`), get, list (order by `updatedAt desc`; filter out `archived` by default).

**Step 3: Verify green. Step 4: Commit** — `feat(api): create/get/list console campaigns (drafts)`

---

### Task 11: Update draft + semantic-field lock

**Files:**
- Modify: `apps/api/src/campaigns/service.ts`, `routes/console/campaigns.ts`
- Test: extend `console-campaigns.int.test.ts`

**Step 1: Failing integration tests**
1. `PATCH /v1/console/campaigns/:id` updates header/chips/cooldown/tenure/clients on a draft → 200, persisted, `updated_at` bumped
2. PATCH `metric_type`/`rating_type`/`rating_scale_max`/`positive_threshold` on a campaign with **zero responses** → allowed
3. Seed a response for the campaign, then PATCH `positive_threshold` → **422** `{error.code:'semantic_locked'}`; PATCH `header_text` on the same → still allowed (200)
4. PATCH unknown id → 404

**Step 2: Implement** — the service checks, when any semantic field is in the patch, whether `count(responses where campaign_id) > 0`; if so reject with `semantic_locked`. Non-semantic fields always patchable. Always set `updatedAt = clock.now()`.

**Step 3: Verify green. Step 4: Commit** — `feat(api): update campaign with semantic-field lock after first response`

---

### Task 12: Publish — completeness + overlap 409

**Files:**
- Modify: `apps/api/src/campaigns/service.ts`, `routes/console/campaigns.ts`
- Test: extend `console-campaigns.int.test.ts`

**Step 1: Failing integration tests**
1. `POST /v1/console/campaigns/:id/publish` on a fully-specified draft → 200, `status='active'`; the SDK cache (after `refresh()`) now matches it via `/eligibility`
2. Publish an **incomplete** draft (missing header) → **422** `{error.code:'incomplete'}` listing missing fields; status stays draft
3. Publish when another **active** campaign already targets an overlapping (target, client) → **409** `{error.code:'overlap', conflict:{id,header}}`; status stays draft
4. Overlap check ignores draft/paused/archived campaigns and non-overlapping clients
5. Publishing is allowed regardless of the target's `integration_status` (M2-D7) — prove with a `not_sent` target

**Step 2: Implement**

```ts
// service.publish(id):
//  1. load campaign; 404 if missing
//  2. validate completeness in code (mirror the CHECK) → 422 {code:'incomplete', missing:[...]}
//  3. overlap: select active campaigns with same target_id whose client_ids intersect this.client_ids
//     (SQL: status='active' AND target_id=$t AND client_ids ?| $clientArray) → if any, 409 with first conflict
//  4. update status='active'; return campaign
```

Note the Postgres `?|` jsonb operator needs a `text[]` param; build it from `client_ids`. Guard with an explicit index-free check first (small N) or add a GIN index on `client_ids` (optional; N is tiny).

**Step 3: Verify green. Step 4: Commit** — `feat(api): publish with completeness validation and active-overlap 409`

---

### Task 13: Pause / resume / archive / hard-delete

**Files:**
- Modify: `apps/api/src/campaigns/service.ts`, `routes/console/campaigns.ts`
- Test: extend `console-campaigns.int.test.ts`

**Step 1: Failing integration tests**
1. `POST /:id/pause` on active → 200 `status='paused'`; SDK cache no longer matches it after refresh
2. `POST /:id/resume` on paused → 200 `status='active'`; **re-runs the overlap check** (resume can reintroduce a clash) → 409 if a conflict appeared meanwhile
3. `POST /:id/archive` → 200 `status='archived'`; excluded from default list; excluded from SDK cache
4. `DELETE /:id` on a draft with zero triggers/responses → 204, row gone
5. `DELETE /:id` on a campaign with any trigger/response rows → **409** `{error.code:'has_history', message:'archive instead'}`

**Step 2: Implement** the four transitions; `resume` reuses the publish overlap check; `delete` counts `trigger_log` + `responses` first.

**Step 3: Verify green. Step 4: Commit** — `feat(api): pause/resume/archive and safe hard-delete`

---

## PHASE D — Targets write-side

### Task 14: Create target with slug-collision rejection

**Files:**
- Create/modify: `apps/api/src/targets/service.ts`, `routes/console/targets.ts`
- Create: `packages/contracts/src/console/targets.ts` additions (`targetCreateSchema`)
- Test: extend `console-reference.int.test.ts`

**Step 1: Failing integration tests**
1. `POST /v1/console/targets` `{name:'Order Completion', trigger_mechanism:'action'}` → 201; `screen_id='order_completion'` (slugified server-side), `integration_status='not_sent'`
2. Slug helper: "Order  Completion!!" and "order_completion" both → `order_completion`
3. Creating a second target whose slug collides → **422** `{error.code:'slug_conflict'}` (no auto-suffix, M2-D13)
4. Missing/blank name → 422

**Step 2: Implement** a `slugify(name)` pure helper (lowercase, non-alphanumeric → `_`, collapse repeats, trim `_`) with its own unit test; service inserts with `onConflictDoNothing` on `screen_id` and returns 422 if nothing inserted.

**Step 3: Verify green. Step 4: Commit** — `feat(api): create target with server-side slug and collision rejection`

---

### Task 15: Integration-status transitions

**Files:**
- Modify: `apps/api/src/targets/service.ts`, `routes/console/targets.ts`
- Test: extend `console-reference.int.test.ts`

**Step 1: Failing integration tests**
1. `PATCH /v1/console/targets/:id/integration-status {to:'sent_to_engineering'}` from `not_sent` → 200
2. `{to:'confirmed_live'}` from any state → 200
3. Illegal transition (e.g. `confirmed_live → not_sent`) → **422** `{error.code:'illegal_transition'}`
4. Unknown target id → 404

**Step 2: Implement** a small transition table (M2-D17) and validate against it.

**Step 3: Verify green. Step 4: Commit** — `feat(api): target integration-status transitions`

---

## PHASE E — Reporting-lite

### Task 16: Reporting contracts + campaign Overview

**Files:**
- Create: `packages/contracts/src/console/reporting.ts`
- Create: `apps/api/src/reporting/queries.ts`, `apps/api/src/routes/console/reporting.ts`
- Test: `apps/api/test/console-reporting.int.test.ts`

**Step 1: Contracts** — `campaignOverviewSchema { campaign_id, triggers, responses, response_rate: number|null, positive_score: number|null }`; `dashboardSummarySchema` (Task 17).

**Step 2: Failing integration tests** (seed a campaign, insert N triggers + M responses with known ratings via helpers)
1. `GET /v1/console/campaigns/:id/overview` → triggers=N, responses=M, `response_rate = M/N`, `positive_score = (#rating>=threshold)/M`
2. Zero triggers → `response_rate=null`, `positive_score=null` (no divide-by-zero, M2-D15)
3. No cookie → 401

**Step 3: Implement** the Overview query — counts from `trigger_log` and `responses`, positive via `count(*) filter (where rating_value >= threshold)`. Pull `positive_threshold` from the campaign.

**Step 4: Verify green. Step 5: Commit** — `feat(api): campaign Overview reporting (counts, response rate, positive score)`

---

### Task 17: Dashboard summary (KPIs + attention + health list)

**Files:**
- Modify: `apps/api/src/reporting/queries.ts`, `routes/console/reporting.ts`, `packages/contracts/src/console/reporting.ts`
- Test: extend `console-reporting.int.test.ts`

**Step 1: Contracts** — `dashboardSummarySchema`:
```
{
  kpis: { active_campaigns, total_triggers_30d, avg_positive_score: number|null },
  attention: [{ campaign_id, header, reason: 'target_not_live'|'low_response_rate'|'low_score' }],
  campaigns: [{ campaign_id, header, status, integration_status, triggers_30d, responses_30d,
                response_rate: number|null, positive_score: number|null }]
}
```

**Step 2: Failing integration tests**
1. `GET /v1/console/dashboard` → KPIs computed over active campaigns and a rolling 30-day window
2. A campaign active on a `not_sent`/`sent_to_engineering` target appears in `attention` with `target_not_live`
3. A campaign with response_rate < 0.15 → `low_response_rate`; positive_score < 0.60 → `low_score` (M2-D11)
4. Healthy campaign → in `campaigns` list, absent from `attention`
5. No cookie → 401

**Step 3: Implement** — the health list is per active/paused campaign with a 30-day metrics join to `target_registry` for integration status; the attention array applies the three constant rules. Keep thresholds as named constants at the top of `queries.ts`.

**Step 4: Verify green. Step 5: Commit** — `feat(api): dashboard summary with attention rules and campaign health list`

---

## PHASE F — Exit proof

### Task 18: Console + cross-milestone demo script

**Files:**
- Create: `scripts/console-demo.sh` (chmod +x)
- Modify: `apps/api/src/scripts/seed-dev.ts` if needed so `created_by` tolerates seed campaigns

**Step 1: Write the script** — `set -euo pipefail`, needs `jq`, uses a curl cookie jar (`-c/-b /tmp/signal-cookies`). `BASE`, admin creds from env. Sequence, each printing ✅/❌:

1. Login with seeded admin → 200, cookie stored
2. Unauthenticated `GET /v1/console/campaigns` (no jar) → 401
3. `POST /targets` "Payment Collection" → 201, capture `screen_id`
4. `POST /campaigns` → draft id
5. `PATCH` the draft: set client, target, `metric_type=CSAT`, `rating_type=star`, `rating_scale_max=5`, header, `positive_threshold=4`, chips, `ask_frequency=after_7_days`
6. `POST /campaigns/:id/publish` → 200 active
7. **Cross-milestone:** `GET /v1/sdk/eligibility` (app-key header) for that screen/client/a fresh user → 200 with matching `header` and `trigger_id` — *the Console-built campaign fires through the M1 engine*
8. `POST /v1/sdk/response` (rating 5) → 204
9. `GET /v1/console/campaigns/:id/overview` → triggers≥1, responses=1, positive_score=1.0
10. `GET /v1/console/dashboard` → campaign present in health list
11. Publish a second overlapping campaign → 409
12. `POST /campaigns/:id/pause` → 200; eligibility for a new user after cache refresh → 204
13. Prints `ALL CONSOLE SCENARIOS PASSED`

Note: allow up to ~60s (or force a cache refresh path) between publish/pause and the eligibility check, since the SDK cache refreshes on a 60s timer. Add a test-only `POST /internal/refresh-cache` guarded by app-key, or run the script tolerant of the timer — prefer the explicit refresh endpoint for a deterministic demo.

**Step 2: Run end to end**

```bash
docker compose up -d
pnpm --filter @signal/api db:migrate
pnpm --filter @signal/api create-admin -- --email pm@signal.local --name PM --password changeme123
pnpm --filter @signal/api seed
pnpm --filter @signal/api dev &
ADMIN_EMAIL=pm@signal.local ADMIN_PASSWORD=changeme123 ./scripts/console-demo.sh
```
Expected: `ALL CONSOLE SCENARIOS PASSED`.

**Step 3: Commit** — `feat: console end-to-end demo proving build→publish→fire→report across M1+M2`

---

### Task 19: README + closeout

**Files:**
- Modify: `README.md`

**Step 1:** Add a "Console API" section — create-admin, login, the endpoint map (`/v1/console/auth|targets|clients|campaigns|dashboard`), and the demo command.

**Step 2: Full verification** — `pnpm verify` green; `pnpm test:unit` green with Docker down; both demo scripts green with Docker up.

**Step 3: Commit** — `docs: console API usage`

---

## Milestone Exit Checklist

- [ ] Reconciliation was applied before this milestone (cooldown enum is `after_*`; no `daily_cap` anywhere)
- [ ] `pnpm verify` green; `pnpm test:unit` green **without Docker**
- [ ] Auth: login issues httpOnly signed cookie; guard rejects all `/v1/console/*` (except `/auth/*`) without it; rate limit fires at 6th attempt; no email enumeration
- [ ] Campaign lifecycle proven: create draft → patch → publish → pause/resume → archive; incomplete publish 422; overlap publish/resume 409; semantic-lock 422 after first response; hard-delete blocked once history exists
- [ ] Targets: server-side slug, collision 422, integration-status transitions with illegal→422
- [ ] Reporting-lite: Overview counts/rate/score correct and null-safe; dashboard attention rules fire; Reasons/Clients/Responses **not** built (correctly M4)
- [ ] `./scripts/console-demo.sh` prints ALL CONSOLE SCENARIOS PASSED — including a Console-built campaign firing through the M1 SDK eligibility endpoint
- [ ] `created_by` on published campaigns = the authenticated PM
- [ ] Git log: one focused commit per task

**Next:** M3 — Android SDK against the (now Console-manageable) backend; then M4 — full reporting, client sync, image upload, deploy; UI last.
