# Milestone 4 — Reporting Depth + Client Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the Console's reporting surface — the Reasons, Clients, and Responses drill-downs that M2 deferred — and replace the seeded client list with a scheduled OAuth2 pull from BeatRoute, all as authenticated `/v1/console/*` API + a CLI job, proven by unit + integration tests and the console demo. No UI, no deploy.

**Architecture:** Two additive workstreams on the existing Fastify backend, layering unchanged (routes → services → repositories, Zod contracts at the boundary). **Reporting** extends the M2 `reporting/queries.ts` module and the `reportingRoutes` plugin with three read endpoints and a trend series — pure aggregation queries against Postgres, null-safe (spec §10, M2-D15). **Client sync** is a standalone command: a `BeatRouteClient` (OAuth2 client-credentials → client-list) feeding an idempotent upsert service that inserts new clients, updates names/status, and marks source-absent clients inactive — never deletes (spec §7.6). The nightly cadence is owned by an external scheduler; the command itself is stateless and testable.

**Tech Stack:** Everything from M1/M2 — Fastify 5, Drizzle, postgres-js, Zod 4, Vitest, Testcontainers. Node 22's global `fetch` for the OAuth calls (no new HTTP dependency); `node:http` to mock BeatRoute in tests.

**Prerequisites:** M2 merged (this plan extends `reporting/queries.ts`, `routes/console/reporting.ts`, `packages/contracts/src/console/reporting.ts`, and `env.ts`, all M2 artifacts). Reconciliation applied. If M3's Phase 0 has also merged, its `S3_*` env vars coexist with the new `BEATROUTE_*` ones — additive, no conflict.

---

## Decisions & Edge Cases (binding — do not re-litigate during execution)

| # | Decision | Rationale / edge case covered |
|---|---|---|
| M4-D1 | Reporting endpoints are added to the existing `reportingRoutes` plugin under the session-guarded `/v1/console` subtree; **API-only** (no UI) | The React SPA is the last milestone; these serve it later |
| M4-D2 | **Reasons** = counts of `chip_selected` (non-null) for a campaign, ranked desc, each with `share` = count ÷ (responses that selected any chip). Chips are stored as sent (M1-D13), not validated against the current chip list | Spec §10.2; surfaces top complaint reasons even if the campaign's chips were edited mid-flight |
| M4-D3 | **Clients breakdown** = per `client_id` in the campaign's `client_ids`: `triggers` (from `trigger_log`), `responses`, `response_rate`, `positive_score` — same math as Overview, split by client | Spec §10.3; an aggregate can hide one underperforming client |
| M4-D4 | **Responses feed** = cursor-paginated (order `responded_at desc, id desc`), default `limit` 50 / max 200, filterable by inclusive `min_rating`/`max_rating` (1–5). Returns rating, chip, `other_text`, `other_image_url`, `location`, `client_id`, device/app, timestamps | Spec §10.4; primary use is "filter to low scores, read the comments" |
| M4-D5 | Every ratio is null-safe: zero triggers → `response_rate = null`; zero responses → `positive_score = null` (rendered "—") | Matches M2-D15; never divide-by-zero |
| M4-D6 | Client sync ships as `pnpm --filter @signal/api sync-clients`; an **external scheduler** owns the nightly cadence | Stateless, testable, no long-lived timer in the API process; scheduling infra is a deploy concern |
| M4-D7 | OAuth2 **client-credentials**; a fresh token is fetched **per run** (no token cache) since the job runs at most hourly | Spec §7.6; a per-run token is simplest and cheap at this cadence |
| M4-D8 | Upsert semantics: **insert** new, **update** `name`/`status`, mark **source-absent** local clients `inactive`, **never delete**; bump `last_synced_at` | Spec §7.6; FK-referenced client history is never destroyed |
| M4-D9 | On any token/list failure: retry with backoff, log **which step** failed, **leave the `clients` cache untouched**, exit non-zero | Spec §7.6; the Console keeps serving its last-good list, alerting notices the non-zero exit |
| M4-D10 | Env `BEATROUTE_TOKEN_URL`, `BEATROUTE_CLIENTS_API_URL`, `BEATROUTE_CLIENT_ID`, `BEATROUTE_CLIENT_SECRET`, `BEATROUTE_OAUTH_SCOPE` (default `clients:read`). Dev/test default to a local mock; **required in production** (fail-fast, like `SIGNAL_APP_KEYS`). Secret comes from env, documented to originate from a secrets manager in prod | Spec §14.2; zero-config locally, safe in prod, never commit a secret |
| M4-D11 | **No migration.** `clients` (`id, name, status, last_synced_at`) already fits; reporting is query-only and the existing `responses_reporting_idx (campaign_id, responded_at)` covers the feed | YAGNI |
| M4-D12 | Error body `{ error: { code, message } }` (M1-D18); unknown campaign id on any reporting route → **404** `campaign_not_found` | One shape everywhere |
| M4-D13 | Spec §10.5 items are **not** built: no automated alerting, no segment cuts beyond client, no LLM classification | Deliberately deferred |
| M4-D14 | Tests: reporting via Testcontainers Postgres; `BeatRouteClient` against an ephemeral `node:http` mock; `syncClients` against real Postgres with an injected fake client. `pnpm test:unit` stays green without Docker | Matches M1-D16 split |

---

## PHASE A — Reporting depth

### Task 1: Reporting contracts (reasons, clients, responses feed, trend)

**Files:**
- Modify: `packages/contracts/src/console/reporting.ts`
- Test: `packages/contracts/src/console/reporting.test.ts`

**Step 1: Write the failing tests** — `safeParse` accepts a valid instance and rejects a malformed one for each new schema.

**Step 2: Add the schemas**

```ts
export const reasonsSchema = z.object({
  campaign_id: z.uuid(),
  total_chip_responses: z.number().int(),
  chips: z.array(z.object({
    chip: z.string(),
    count: z.number().int(),
    share: z.number(), // count / total_chip_responses; 0 when total is 0
  })),
});
export type Reasons = z.infer<typeof reasonsSchema>;

export const clientBreakdownSchema = z.object({
  campaign_id: z.uuid(),
  clients: z.array(z.object({
    client_id: z.string(),
    triggers: z.number().int(),
    responses: z.number().int(),
    response_rate: z.number().nullable(),
    positive_score: z.number().nullable(),
  })),
});
export type ClientBreakdown = z.infer<typeof clientBreakdownSchema>;

export const responseFeedItemSchema = z.object({
  id: z.uuid(),
  rating_value: z.number().int(),
  chip_selected: z.string().nullable(),
  other_text: z.string().nullable(),
  other_image_url: z.string().nullable(),
  location: z.object({
    lat: z.number(), lng: z.number(), state: z.string().optional(), country: z.string().optional(),
  }).nullable(),
  client_id: z.string(),
  device_os: z.string(),
  app_version: z.string(),
  shown_at: z.string(),
  responded_at: z.string(),
});
export const responseFeedSchema = z.object({
  items: z.array(responseFeedItemSchema),
  next_cursor: z.string().nullable(),
});
export const responseFeedQuerySchema = z.object({
  min_rating: z.coerce.number().int().min(1).max(5).optional(),
  max_rating: z.coerce.number().int().min(1).max(5).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const trendSchema = z.object({
  campaign_id: z.uuid(),
  points: z.array(z.object({
    date: z.string(),            // YYYY-MM-DD (UTC)
    responses: z.number().int(),
    positive_score: z.number().nullable(),
  })),
});
```

**Step 3: Verify green** — `pnpm test:unit`, `pnpm typecheck`. **Step 4: Commit** — `feat(contracts): console reporting schemas for reasons, clients, responses, trend`

---

### Task 2: Reasons query + endpoint

**Files:**
- Modify: `apps/api/src/reporting/queries.ts`, `apps/api/src/routes/console/reporting.ts`
- Test: `apps/api/test/console-reporting.int.test.ts`

**Step 1: Failing integration tests** (reuse the file's `seedCampaign` + response helpers):
1. No cookie → 401
2. Unknown campaign id → 404 `campaign_not_found`
3. Campaign with responses `[chip A ×3, chip B ×1, chip null ×2]` → `total_chip_responses = 4`, `chips = [{A,3,0.75},{B,1,0.25}]` (ordered desc, null chips ignored)
4. Campaign with zero chip responses → `total_chip_responses = 0`, `chips = []`

**Step 2: Implement the query**

```ts
export async function campaignReasons(db: Db, campaignId: string): Promise<Reasons | null> {
  const [campaign] = await db.select({ id: campaigns.id }).from(campaigns)
    .where(eq(campaigns.id, campaignId));
  if (!campaign) return null;
  const rows = await db
    .select({ chip: responses.chipSelected, count: sql<number>`count(*)::int` })
    .from(responses)
    .where(and(eq(responses.campaignId, campaignId), isNotNull(responses.chipSelected)))
    .groupBy(responses.chipSelected)
    .orderBy(desc(sql`count(*)`));
  const total = rows.reduce((n, r) => n + r.count, 0);
  return {
    campaign_id: campaignId,
    total_chip_responses: total,
    chips: rows.map((r) => ({
      chip: r.chip as string, count: r.count, share: total === 0 ? 0 : r.count / total,
    })),
  };
}
```

**Step 3: Endpoint** — add to `reportingRoutes`:
```ts
app.get<{ Params: { id: string } }>('/campaigns/:id/reasons', async (request, reply) => {
  const reasons = await campaignReasons(deps.db, request.params.id);
  if (!reasons) return reply.code(404).send({ error: { code: 'campaign_not_found', message: 'no such campaign' } });
  return reply.send(reasons);
});
```

**Step 4: Verify** — `pnpm verify`. **Step 5: Commit** — `feat(api): campaign reasons (ranked chip selections) endpoint`

---

### Task 3: Client breakdown query + endpoint

**Files:** modify `queries.ts`, `reporting.ts`; extend `console-reporting.int.test.ts`

**Step 1: Failing integration tests**:
1. Campaign for `client_ids [cl_A, cl_B]`: seed `cl_A` = 4 triggers / 2 responses (ratings 5,1; threshold 4), `cl_B` = 2 triggers / 0 responses → `cl_A {triggers:4,responses:2,response_rate:0.5,positive_score:0.5}`, `cl_B {triggers:2,responses:0,response_rate:0,positive_score:null}`
2. A client with 0 triggers → `response_rate: null`
3. Unknown campaign → 404; no cookie → 401

**Step 2: Implement** — load the campaign (for `client_ids` + `positive_threshold`), then per client run the same counts as `campaignOverview` scoped to `client_id` (triggers from `trigger_log`, responses + positive from `responses`). Assemble null-safe ratios (M4-D5). Endpoint `GET /campaigns/:id/clients`.

**Step 3: Verify green. Step 4: Commit** — `feat(api): per-client campaign breakdown endpoint`

---

### Task 4: Responses drill-down feed + endpoint

**Files:** modify `queries.ts`, `reporting.ts`; extend `console-reporting.int.test.ts`

**Step 1: Failing integration tests**:
1. Seed 5 responses (ratings 1,2,3,4,5) → `GET /campaigns/:id/responses` returns 5 items newest-first, `next_cursor: null`
2. `?min_rating=1&max_rating=2` → exactly the two low-score items
3. `?limit=2` → 2 items + a non-null `next_cursor`; passing that `cursor` returns the next page with no overlap
4. Fields present: `chip_selected`, `other_text`, `other_image_url`, `location`, `client_id`
5. Unknown campaign → 404; no cookie → 401

**Step 2: Implement**

```ts
function encodeCursor(respondedAt: Date, id: string): string {
  return Buffer.from(`${respondedAt.toISOString()}|${id}`).toString('base64url');
}
function decodeCursor(c: string): { ts: Date; id: string } | null {
  try {
    const [ts, id] = Buffer.from(c, 'base64url').toString().split('|');
    if (!ts || !id) return null;
    return { ts: new Date(ts), id };
  } catch { return null; }
}

export async function campaignResponses(
  db: Db, campaignId: string,
  opts: { minRating?: number; maxRating?: number; cursor?: string; limit: number },
): Promise<{ items: ResponseFeedItem[]; next_cursor: string | null } | null> {
  const [campaign] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, campaignId));
  if (!campaign) return null;
  const conds = [eq(responses.campaignId, campaignId)];
  if (opts.minRating !== undefined) conds.push(gte(responses.ratingValue, opts.minRating));
  if (opts.maxRating !== undefined) conds.push(lte(responses.ratingValue, opts.maxRating));
  const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
  if (cur) conds.push(sql`(${responses.respondedAt}, ${responses.id}) < (${cur.ts.toISOString()}::timestamptz, ${cur.id}::uuid)`);
  const rows = await db.select().from(responses)
    .where(and(...conds))
    .orderBy(desc(responses.respondedAt), desc(responses.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  const next = rows.length > opts.limit && page.length > 0
    ? encodeCursor(page[page.length - 1]!.respondedAt, page[page.length - 1]!.id) : null;
  return {
    items: page.map((r) => ({
      id: r.id, rating_value: r.ratingValue, chip_selected: r.chipSelected, other_text: r.otherText,
      other_image_url: r.otherImageUrl, location: r.location, client_id: r.clientId,
      device_os: r.deviceOs, app_version: r.appVersion,
      shown_at: r.shownAt.toISOString(), responded_at: r.respondedAt.toISOString(),
    })),
    next_cursor: next,
  };
}
```
Endpoint parses `responseFeedQuerySchema` (422 on bad range), calls `campaignResponses`, 404 if null.

**Step 3: Verify green. Step 4: Commit** — `feat(api): paginated response drill-down feed filterable by score`

---

### Task 5: 30-day trend series + endpoint

**Files:** modify `queries.ts`, `reporting.ts`; extend `console-reporting.int.test.ts`

**Step 1: Failing integration tests** (inject the route's `clock` for a deterministic "now"):
1. Responses across three distinct UTC days within 30 days → `points` has one entry per day with data, `responses` count and `positive_score` correct per day
2. A day with responses but none positive → `positive_score: 0`; a day outside the 30-day window is excluded
3. Unknown campaign → 404

**Step 2: Implement** — group responses in the last 30 days by `date_trunc('day', responded_at)`, count and `count(*) filter (where rating_value >= positive_threshold)`. Return points ordered by date. Endpoint `GET /campaigns/:id/trend`.

**Step 3: Verify green. Step 4: Commit** — `feat(api): 30-day campaign positive-score trend endpoint`

---

## PHASE B — Client sync

### Task 6: BeatRoute env (fail-fast in prod)

**Files:**
- Modify: `apps/api/src/env.ts`, `apps/api/src/env.test.ts`, `.env.example`

**Step 1: Failing env tests** — in development, `BEATROUTE_TOKEN_URL`/`BEATROUTE_CLIENTS_API_URL`/`BEATROUTE_CLIENT_ID`/`BEATROUTE_CLIENT_SECRET` default to local mock values and `BEATROUTE_OAUTH_SCOPE` defaults to `clients:read`; in production with them unset, `parseEnv` throws naming the missing vars.

**Step 2: Implement** — add to the schema:
```ts
BEATROUTE_TOKEN_URL: z.url().optional(),
BEATROUTE_CLIENTS_API_URL: z.url().optional(),
BEATROUTE_CLIENT_ID: z.string().optional(),
BEATROUTE_CLIENT_SECRET: z.string().optional(),
BEATROUTE_OAUTH_SCOPE: z.string().default('clients:read'),
```
In `parseEnv`, for non-production default the four to `http://localhost:4599/oauth/token`, `http://localhost:4599/v1/clients`, `signal-backend`, `dev-beatroute-secret`; in production add any unset ones to the existing "missing required" list. Expose all five on `Env`.

**Step 3: `.env.example`** — add the five vars with the local mock values and a comment that prod values come from BeatRoute + a secrets manager.

**Step 4: Verify green. Step 5: Commit** — `chore(api): beatroute oauth env with prod fail-fast`

---

### Task 7: BeatRouteClient (OAuth token + client list)

**Files:**
- Create: `apps/api/src/sync/beatrouteClient.ts`
- Test: `apps/api/src/sync/beatrouteClient.test.ts` (unit — ephemeral `node:http` mock, no Docker)

**Step 1: Failing tests** — start a `node:http` server in the test that scripts the token + list endpoints:
1. `fetchToken()` POSTs `grant_type=client_credentials` with id/secret/scope and returns the `access_token`
2. `fetchClients(token)` sends `Authorization: Bearer <token>` and returns `[{id,name,status}]`, mapping a source `client_id` field to `id`
3. Token endpoint 401 → throws `BeatRouteError('token', ...)`
4. List endpoint 500 → throws `BeatRouteError('clients', ...)`

**Step 2: Implement**

```ts
export type SourceClient = { id: string; name: string; status: 'active' | 'inactive' };
export class BeatRouteError extends Error {
  constructor(public step: 'token' | 'clients', message: string) { super(message); }
}
export interface BeatRouteConfig {
  tokenUrl: string; clientsUrl: string; clientId: string; clientSecret: string; scope: string;
}

export class BeatRouteClient {
  constructor(private readonly cfg: BeatRouteConfig) {}

  async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials', client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret, scope: this.cfg.scope,
    });
    const res = await fetch(this.cfg.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    });
    if (!res.ok) throw new BeatRouteError('token', `token endpoint returned ${res.status}`);
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new BeatRouteError('token', 'no access_token in response');
    return json.access_token;
  }

  async fetchClients(token: string): Promise<SourceClient[]> {
    const res = await fetch(this.cfg.clientsUrl, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new BeatRouteError('clients', `clients endpoint returned ${res.status}`);
    const json = (await res.json()) as Array<{ id?: string; client_id?: string; name: string; status: string }>;
    return json.map((c) => ({
      id: (c.id ?? c.client_id)!, name: c.name,
      status: c.status === 'inactive' ? 'inactive' : 'active',
    }));
  }
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 200): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e) { last = e; await new Promise((r) => setTimeout(r, baseMs * 2 ** i)); }
  }
  throw last;
}
```

**Step 3: Verify green. Step 4: Commit** — `feat(api): beatroute oauth client for token and client-list fetch`

---

### Task 8: syncClients upsert service

**Files:**
- Create: `apps/api/src/sync/syncClients.ts`
- Test: `apps/api/test/sync.int.test.ts` (Testcontainers Postgres; inject a fake fetcher)

**Step 1: Failing integration tests** (pass a stub `() => Promise<SourceClient[]>` so the DB logic is tested without HTTP):
1. Empty `clients` + source `[cl_A active, cl_B active]` → both inserted, both `active`, `last_synced_at` set → returns `{ inserted: 2, updated: 0, deactivated: 0 }`
2. Existing `cl_A` with a stale name/status + source has it renamed/active → updated in place → `{ updated: 1 }`
3. Local `cl_X active`, source omits it → `cl_X` becomes `inactive`, **row still present** → `{ deactivated: 1 }`
4. `last_synced_at` bumped for touched rows
5. A stub that throws → `clients` table unchanged, error propagates (cache intact)

**Step 2: Implement**

```ts
export interface SyncSummary { inserted: number; updated: number; deactivated: number }

export async function syncClients(
  db: Db, fetchClients: () => Promise<SourceClient[]>, now: Date,
): Promise<SyncSummary> {
  const source = await fetchClients(); // throws before any write → cache untouched (M4-D9)
  return db.transaction(async (tx) => {
    const existing = await tx.select().from(clients);
    const existingIds = new Set(existing.map((c) => c.id));
    let inserted = 0, updated = 0, deactivated = 0;

    for (const c of source) {
      if (existingIds.has(c.id)) {
        await tx.update(clients).set({ name: c.name, status: c.status, lastSyncedAt: now })
          .where(eq(clients.id, c.id));
        updated++;
      } else {
        await tx.insert(clients).values({ id: c.id, name: c.name, status: c.status, lastSyncedAt: now });
        inserted++;
      }
    }
    const sourceIds = source.map((c) => c.id);
    const toDeactivate = existing.filter(
      (c) => !sourceIds.includes(c.id) && c.status !== 'inactive',
    );
    for (const c of toDeactivate) {
      await tx.update(clients).set({ status: 'inactive', lastSyncedAt: now }).where(eq(clients.id, c.id));
      deactivated++;
    }
    return { inserted, updated, deactivated };
  });
}
```
(For a large client list this per-row loop is fine at BeatRoute's scale; if N grows, batch later.)

**Step 3: Verify green. Step 4: Commit** — `feat(api): idempotent client upsert — insert/update, deactivate-not-delete`

---

### Task 9: sync-clients CLI

**Files:**
- Create: `apps/api/src/scripts/sync-clients.ts`
- Modify: `apps/api/package.json` (`"sync-clients": "tsx src/scripts/sync-clients.ts"`)

**Step 1: Implement** (no unit test — operational CLI; the upsert is covered by Task 8):
```ts
import { createDb } from '../db/client.js';
import { parseEnv } from '../env.js';
import { BeatRouteClient, BeatRouteError, withRetry } from '../sync/beatrouteClient.js';
import { syncClients } from '../sync/syncClients.js';

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const client = new BeatRouteClient({
    tokenUrl: env.BEATROUTE_TOKEN_URL, clientsUrl: env.BEATROUTE_CLIENTS_API_URL,
    clientId: env.BEATROUTE_CLIENT_ID, clientSecret: env.BEATROUTE_CLIENT_SECRET,
    scope: env.BEATROUTE_OAUTH_SCOPE,
  });
  const { db, close } = createDb(env.DATABASE_URL);
  try {
    const summary = await syncClients(db, async () => {
      const token = await withRetry(() => client.fetchToken());
      return withRetry(() => client.fetchClients(token));
    }, new Date());
    console.log(`client sync ok — inserted ${summary.inserted}, updated ${summary.updated}, deactivated ${summary.deactivated}`);
  } finally {
    await close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    const step = error instanceof BeatRouteError ? ` (step: ${error.step})` : '';
    console.error(`client sync FAILED${step} — cache left untouched:`, error);
    process.exit(1); // M4-D9: non-zero so the scheduler/alerting notices
  },
);
```

**Step 2: Verify manually** — start a throwaway mock (a `node:http` one-liner that serves a token + a two-client list on `:4599`), then:
```bash
docker compose up -d
pnpm --filter @signal/api db:migrate
BEATROUTE_TOKEN_URL=http://localhost:4599/oauth/token \
BEATROUTE_CLIENTS_API_URL=http://localhost:4599/v1/clients \
pnpm --filter @signal/api sync-clients
docker compose exec postgres psql -U signal -d signal -c "select id, name, status from clients;"
```
Expected: the mock's clients present; re-running is idempotent.

**Step 3: Verify** — `pnpm verify` (nothing regressed). **Step 4: Commit** — `feat(api): sync-clients CLI with fail-safe non-zero exit`

---

## PHASE C — Exit proof

### Task 10: Extend the console demo with reporting

**Files:**
- Modify: `scripts/console-demo.sh`

**Step 1:** After the existing steps record a response, add reporting assertions (each printing ✅/❌):
- `GET /v1/console/campaigns/:id/reasons` → 200; assert `chips` shape
- `GET .../clients` → 200; assert the acting client appears with `responses >= 1`
- `GET .../responses?min_rating=1&max_rating=2` → 200; assert `items` is an array
- `GET .../trend` → 200; assert `points` present
- `GET .../responses` unauthenticated (no cookie jar) → 401

(Client sync is proven by `sync.int.test.ts` + Task 9's manual run — not added to the cookie-based console demo, which has no BeatRoute mock.)

**Step 2: Run** the full `console-demo.sh` end to end → `ALL CONSOLE SCENARIOS PASSED` with the new reporting steps.

**Step 3: Commit** — `test: console demo covers reasons/clients/responses/trend`

---

### Task 11: README + closeout

**Files:**
- Modify: `README.md`

**Step 1:** Under the Console API section, list the four new reporting endpoints. Add a **Client sync** subsection: the `sync-clients` command, the `BEATROUTE_*` env placeholders, and the "asks for BeatRoute engineering" (register `signal-backend` client-credentials, issue id/secret scoped `clients:read`, confirm token URL + list response shape). Note the nightly cadence is owned by an external scheduler set up in the deploy milestone.

**Step 2: Full verification** — `pnpm verify` green; `pnpm test:unit` green with Docker stopped; `console-demo.sh` green with Docker up.

**Step 3: Commit** — `docs: reporting endpoints and client-sync usage`

---

## Milestone Exit Checklist

- [ ] `pnpm verify` green; `pnpm test:unit` green **without Docker**
- [ ] Reasons: ranked non-null chip counts with correct shares; empty → `[]`, `total 0`
- [ ] Clients: per-client triggers/response-rate/positive-score, null-safe; unknown campaign → 404
- [ ] Responses feed: score-range filter + cursor pagination with no overlap; comments/image/location present
- [ ] Trend: 30-day daily positive-score series, deterministic under an injected clock
- [ ] Client sync: insert new, update name/status, deactivate source-absent (**never delete**), `last_synced_at` bumped — proven against real Postgres
- [ ] Sync fail-safe: a fetch failure leaves the `clients` cache untouched and exits non-zero
- [ ] `BEATROUTE_*` env fail-fast in production; secret never committed; `.env.example` documents the placeholders
- [ ] `console-demo.sh` prints ALL CONSOLE SCENARIOS PASSED including the reporting endpoints
- [ ] Nothing from §10.5 built (no alerting, no non-client segments, no LLM)
- [ ] Git log: one focused commit per task

**Next:** M5 — deploy / go-live (hosting, CI/CD, secrets, prod S3, the client-sync scheduler); then M6 — the Console UI (React SPA on the design system) consuming this API. The real BeatRoute OAuth cutover and the SDK's integration into the Route app are people-gated, tracked separately.
```
