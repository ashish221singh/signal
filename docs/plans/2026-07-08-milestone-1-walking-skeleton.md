# Milestone 1 — Walking Skeleton Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** The complete product core loop — eligible → shown → answered/dismissed → suppressed → correctly re-eligible or never again — running against real Postgres, proven by unit tests, integration tests, and a scripted end-to-end demo. No UI.

**Architecture:** Per `signal-architecture-v1.md` §3–4. Layering: routes → services → repositories. Pure decision logic separated from I/O. In-memory campaign cache. One atomic SQL statement for the suppression claim. All time injected via a Clock; the database never calls `now()` for suppression math.

**Tech Stack:** Fastify 5, Drizzle ORM + drizzle-kit (migrations), postgres-js driver, Zod 4 (contracts), Vitest, Testcontainers (`@testcontainers/postgresql`), tsx.

**Prerequisite:** Milestone 0 exit checklist green. Commit any untracked files in `docs/plans/` before starting.

---

## Decisions & Edge Cases (binding — do not re-litigate during execution)

| # | Decision | Rationale / edge case covered |
|---|---|---|
| M1-D1 | Eligibility request gains `rep_tenure_days` (optional int) | Signal has no rep DB; the SDK session knows tenure. Not a security boundary — worst case a survey shows early |
| M1-D2 | Eligibility response gains `trigger_id` (the `trigger_log` row UUID); `/response` and `/dismiss` are keyed on it | Server-generated idempotency key: outbox retries can never double-count; immune to device clock skew; exact join response→trigger |
| M1-D3 | One active campaign per (target, client). Runtime tie-break: oldest `created_at` wins. Console will also block overlap at publish (M2) | Spec says "find the campaign", singular — this makes plural impossible to observe |
| M1-D4 | Ratings and thresholds are integers everywhere: star 1–5, emoji 1–3 (3=happy), effort 1–`rating_scale_max` (3 or 5). No string thresholds like "happy_emoji_only" | Backend never parses semantic strings; Console renders semantics |
| M1-D5 | Cooldowns are rolling windows: `once_per_day` = 24h, `once_per_week` = 168h — measured from `last_shown_at` | No calendar/timezone math; no "11:58pm then 12:01am" absurdity |
| M1-D6 | `no_cooldown` still sets a debounce cooldown of `SIGNAL_NO_COOLDOWN_DEBOUNCE_SECONDS` (default 60) | Without it, the double-trigger race double-shows on no-cooldown campaigns. Env-configurable so the demo script can use 2s |
| M1-D7 | `daily_cap` = max shows per (user, campaign) per rolling 24h, counted from `trigger_log` | Only bites with `no_cooldown`; belt-and-braces otherwise, matching the spec's own examples |
| M1-D8 | Unknown tenure fails closed on tenure-gated campaigns | Never guess in the direction of annoying a rep |
| M1-D9 | Suppression claim is ONE atomic SQL statement (`INSERT … ON CONFLICT … WHERE next_eligible_at <= $now RETURNING`) executed in the same transaction as the `trigger_log` insert | Two concurrent eligibility calls → exactly one claim. Postgres row-locks the PK; the loser's WHERE fails |
| M1-D10 | Show-time provisional suppression: claiming sets `next_eligible_at = now + cooldown` with `last_action = NULL` | "Shown but never answered" (app killed) behaves as dismissed |
| M1-D11 | Submitted → `next_eligible_at = NULL` + `last_action = 'submitted'` = never re-ask. In-row NULL means never; absent row means never asked | Matches spec §6 exactly |
| M1-D12 | Responses accepted regardless of current campaign status (paused/archived after show) | A rep's effort is never discarded; the trigger was legitimately granted |
| M1-D13 | Boundary validates shape (rating 1–5 integer); the service validates against the campaign's actual `rating_type`/`rating_scale_max` (a "4" on an emoji campaign → 422). `chip_selected` is stored as sent, not validated against the campaign's chip list | Protects score math; tolerates chip edits mid-flight |
| M1-D14 | SDK auth = static `X-Signal-App-Key` header checked against env `SIGNAL_APP_KEYS` (comma-separated set). 401 on missing/wrong | App-level auth, not user auth. Upgrade path documented, not built |
| M1-D15 | All suppression/trigger timestamps come from an injectable app `Clock`, passed into SQL as parameters — the DB never computes `now()` for logic | Cooldown tests advance a fake clock against a real database; zero sleeps, zero flakes |
| M1-D16 | Test split: `*.test.ts` = unit (no Docker), `*.int.test.ts` = integration (Testcontainers). `pnpm test` runs both; `pnpm test:unit` runs unit only. CI runs both (ubuntu runners have Docker) | Milestone 0's "tests pass without Docker" survives via `test:unit`; the default stays honest |
| M1-D17 | Primary keys are UUIDs (`gen_random_uuid()`); `clients.id` is text (BeatRoute's own ID) | No coordination needed; BeatRoute IDs mirrored as-is |
| M1-D18 | Error body shape: `{ "error": { "code": string, "message": string } }`. Semantics: 200 eligible, 204 not eligible / accepted, 401 auth, 404 unknown trigger_id, 422 validation, 500 unexpected (logged, opaque message) | One shape everywhere; SDK can parse errors blind |
| M1-D19 | Env additions: `DATABASE_URL` (defaults to local compose URL in development/test; **required** in production), `SIGNAL_APP_KEYS` (defaults to `dev-app-key` in development/test; **required** in production) | Fail-fast in prod; zero-config locally |
| M1-D20 | Trigger counted at grant time; SDK crash before render = tiny overcount, accepted and documented. No fourth "confirmed shown" endpoint | YAGNI; spec §10 metrics tolerate this |

---

### Task 1: Spec amendment v1.1 (docs before code)

**Files:**
- Modify: `docs/signal-spec-v1.md`
- Modify: `docs/signal-architecture-v1.md`

**Step 1: Amend the spec**

Make these edits (keep everything else intact):

1. Title block: change `Product & Technical Spec — v1` to `Product & Technical Spec — v1.1` and add a changelog line under it: `v1.1 (2026-07-XX): eligibility carries rep_tenure_days; trigger_id introduced as the response/dismiss idempotency key; one-active-campaign-per-(target,client) rule; ratings/thresholds normalized to integers.`
2. §3: add after the scoring formula: `All rating values and positive thresholds are integers: star 1–5, emoji 1–3 (3 = 😊), effort 1–3 or 1–5. "Only 😊 counts" is expressed as positive_threshold = 3.`
3. §6: add fixed rule: `At most one active campaign may exist per (target, client) pair. The Console enforces this at publish; the backend tie-breaks deterministically (oldest active campaign wins) as defense in depth.`
4. §8.1 request: `screen_id, user_id, client_id, rep_tenure_days (optional int — supplied by the SDK from the app session; if absent and the campaign sets min_tenure_days, the user is not eligible)`
5. §8.1 response: add `"trigger_id": "tl_9f2…",` as the first field, with note: `server-generated ID of the TriggerLog row; the SDK must echo it in /response or /dismiss.`
6. §8.2 and §8.3 requests: add `"trigger_id"` and note that `(campaign_id, user_id, shown_at)` is no longer the idempotency key — `trigger_id` is.
7. §7.5 Response model: add `trigger_id` field.

**Step 2: Amend the architecture doc**

In §3.1, update the flow to show `rep_tenure_days` in the query and `trigger_id` in the config return; update the Idempotency line to: `keyed on trigger_id (unique constraint on responses.trigger_id)`.

**Step 3: Commit**

```bash
git add docs/signal-spec-v1.md docs/signal-architecture-v1.md docs/plans/
git commit -m "docs: spec v1.1 — tenure in eligibility, trigger_id idempotency, campaign overlap rule, integer ratings"
```

---

### Task 2: Contracts — shared primitives

**Files:**
- Create: `packages/contracts/src/primitives.ts`
- Test: `packages/contracts/src/primitives.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Step 1: Write the failing test**

```ts
// packages/contracts/src/primitives.test.ts
import { describe, expect, it } from 'vitest';
import { ratingBoundsFor } from './index.js';

describe('ratingBoundsFor', () => {
  it('star is always 1..5', () => {
    expect(ratingBoundsFor('star', null)).toEqual({ min: 1, max: 5 });
  });
  it('emoji is always 1..3', () => {
    expect(ratingBoundsFor('emoji', null)).toEqual({ min: 1, max: 3 });
  });
  it('effort_scale uses the campaign scale max', () => {
    expect(ratingBoundsFor('effort_scale', 3)).toEqual({ min: 1, max: 3 });
    expect(ratingBoundsFor('effort_scale', 5)).toEqual({ min: 1, max: 5 });
  });
  it('effort_scale defaults to 5 when scale max is absent', () => {
    expect(ratingBoundsFor('effort_scale', null)).toEqual({ min: 1, max: 5 });
  });
});
```

**Step 2: Run to verify failure** — `pnpm test:unit` → FAIL (module missing).

**Step 3: Implement**

```ts
// packages/contracts/src/primitives.ts
import { z } from 'zod';

export const metricTypeSchema = z.enum(['CSAT', 'CES']);
export const ratingTypeSchema = z.enum(['star', 'emoji', 'effort_scale']);
export const askFrequencySchema = z.enum(['once_per_week', 'once_per_day', 'no_cooldown']);
export const onPositiveActionSchema = z.enum(['none', 'play_store_review']);
export const campaignStatusSchema = z.enum(['draft', 'active', 'paused']);
export const triggerMechanismSchema = z.enum(['action', 'dwell']);

export type RatingType = z.infer<typeof ratingTypeSchema>;

export function ratingBoundsFor(
  ratingType: RatingType,
  ratingScaleMax: number | null,
): { min: number; max: number } {
  switch (ratingType) {
    case 'star':
      return { min: 1, max: 5 };
    case 'emoji':
      return { min: 1, max: 3 };
    case 'effort_scale':
      return { min: 1, max: ratingScaleMax === 3 ? 3 : 5 };
  }
}

export const errorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;
```

Append to `packages/contracts/src/index.ts`: `export * from './primitives.js';`

**Step 4: Run to verify green** — `pnpm test:unit` and `pnpm typecheck`.

**Step 5: Commit** — `git commit -m "feat(contracts): rating/metric primitives and error body shape"`

---

### Task 3: Contracts — eligibility request & response

**Files:**
- Create: `packages/contracts/src/eligibility.ts`
- Test: `packages/contracts/src/eligibility.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Step 1: Write the failing test**

```ts
// packages/contracts/src/eligibility.test.ts
import { describe, expect, it } from 'vitest';
import { eligibilityQuerySchema, eligibilityConfigSchema } from './index.js';

describe('eligibilityQuerySchema', () => {
  it('accepts minimal valid query and coerces tenure from string', () => {
    const r = eligibilityQuerySchema.safeParse({
      screen_id: 'order_completion',
      user_id: 'u_1',
      client_id: 'cl_A',
      rep_tenure_days: '210',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.rep_tenure_days).toBe(210);
  });
  it('tenure is optional', () => {
    const r = eligibilityQuerySchema.safeParse({
      screen_id: 's',
      user_id: 'u',
      client_id: 'c',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.rep_tenure_days).toBeUndefined();
  });
  it('rejects negative tenure and empty ids', () => {
    expect(
      eligibilityQuerySchema.safeParse({ screen_id: '', user_id: 'u', client_id: 'c' }).success,
    ).toBe(false);
    expect(
      eligibilityQuerySchema.safeParse({
        screen_id: 's', user_id: 'u', client_id: 'c', rep_tenure_days: '-4',
      }).success,
    ).toBe(false);
  });
});

describe('eligibilityConfigSchema', () => {
  it('accepts a full campaign config with trigger_id', () => {
    const r = eligibilityConfigSchema.safeParse({
      trigger_id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
      campaign_id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2f',
      metric_type: 'CSAT',
      header: 'How satisfied were you with placing this order?',
      rating_type: 'star',
      rating_scale_max: 5,
      positive_threshold: 4,
      chips_on_negative: ['Slow to load', 'Sync failed'],
      other_requires_text: true,
      other_allows_image: true,
      on_positive_action: 'play_store_review',
      skip_enabled: true,
    });
    expect(r.success).toBe(true);
  });
  it('rejects a config missing trigger_id', () => {
    const r = eligibilityConfigSchema.safeParse({ campaign_id: 'x' });
    expect(r.success).toBe(false);
  });
});
```

**Step 2: Run to verify failure.**

**Step 3: Implement**

```ts
// packages/contracts/src/eligibility.ts
import { z } from 'zod';
import { metricTypeSchema, onPositiveActionSchema, ratingTypeSchema } from './primitives.js';

export const eligibilityQuerySchema = z.object({
  screen_id: z.string().min(1),
  user_id: z.string().min(1),
  client_id: z.string().min(1),
  rep_tenure_days: z.coerce.number().int().nonnegative().optional(),
});
export type EligibilityQuery = z.infer<typeof eligibilityQuerySchema>;

export const eligibilityConfigSchema = z.object({
  trigger_id: z.uuid(),
  campaign_id: z.uuid(),
  metric_type: metricTypeSchema,
  header: z.string().min(1),
  rating_type: ratingTypeSchema,
  rating_scale_max: z.number().int(),
  positive_threshold: z.number().int(),
  chips_on_negative: z.array(z.string()),
  other_requires_text: z.boolean(),
  other_allows_image: z.boolean(),
  on_positive_action: onPositiveActionSchema,
  skip_enabled: z.boolean(),
});
export type EligibilityConfig = z.infer<typeof eligibilityConfigSchema>;
```

Append export to `index.ts`.

**Step 4: Verify green. Step 5: Commit** — `feat(contracts): eligibility query and config schemas (tenure + trigger_id)`

---

### Task 4: Contracts — response & dismiss payloads

**Files:**
- Create: `packages/contracts/src/feedback.ts`
- Test: `packages/contracts/src/feedback.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Step 1: Write the failing test**

```ts
// packages/contracts/src/feedback.test.ts
import { describe, expect, it } from 'vitest';
import { dismissBodySchema, responseBodySchema } from './index.js';

const base = {
  trigger_id: '3f0e6f2e-6f2e-4e2e-8e2e-6f2e6f2e6f2e',
  rating_value: 4,
  device_os: 'Android 14',
  app_version: '4.12.0',
  shown_at: '2026-07-07T10:12:00Z',
  responded_at: '2026-07-07T10:12:18Z',
};

describe('responseBodySchema', () => {
  it('accepts a minimal positive response', () => {
    expect(responseBodySchema.safeParse(base).success).toBe(true);
  });
  it('accepts a negative response with chip, text, image, location', () => {
    const r = responseBodySchema.safeParse({
      ...base,
      rating_value: 1,
      chip_selected: 'Sync failed',
      other_text: 'kept timing out',
      other_image_url: 'https://cdn.example.com/x.jpg',
      location: { lat: 30.9, lng: 75.8, state: 'Punjab', country: 'IN' },
      rep_tenure_days: 210,
    });
    expect(r.success).toBe(true);
  });
  it('rejects rating outside 1..5, bad uuid, bad timestamps', () => {
    expect(responseBodySchema.safeParse({ ...base, rating_value: 0 }).success).toBe(false);
    expect(responseBodySchema.safeParse({ ...base, rating_value: 6 }).success).toBe(false);
    expect(responseBodySchema.safeParse({ ...base, trigger_id: 'nope' }).success).toBe(false);
    expect(responseBodySchema.safeParse({ ...base, shown_at: 'yesterday' }).success).toBe(false);
  });
});

describe('dismissBodySchema', () => {
  it('accepts trigger_id + timestamps', () => {
    const r = dismissBodySchema.safeParse({
      trigger_id: base.trigger_id,
      shown_at: base.shown_at,
      dismissed_at: '2026-07-07T10:12:03Z',
    });
    expect(r.success).toBe(true);
  });
});
```

**Step 2: Verify failure.**

**Step 3: Implement**

```ts
// packages/contracts/src/feedback.ts
import { z } from 'zod';

const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
  message: 'must be an ISO-8601 timestamp',
});

export const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  state: z.string().optional(),
  country: z.string().optional(),
});

export const responseBodySchema = z.object({
  trigger_id: z.uuid(),
  rating_value: z.number().int().min(1).max(5),
  chip_selected: z.string().nullish(),
  other_text: z.string().max(2000).nullish(),
  other_image_url: z.url().nullish(),
  location: locationSchema.nullish(),
  device_os: z.string().min(1),
  app_version: z.string().min(1),
  rep_tenure_days: z.number().int().nonnegative().nullish(),
  shown_at: isoInstant,
  responded_at: isoInstant,
});
export type ResponseBody = z.infer<typeof responseBodySchema>;

export const dismissBodySchema = z.object({
  trigger_id: z.uuid(),
  shown_at: isoInstant,
  dismissed_at: isoInstant,
});
export type DismissBody = z.infer<typeof dismissBodySchema>;
```

Append export to `index.ts`.

**Step 4: Verify green. Step 5: Commit** — `feat(contracts): response and dismiss payload schemas keyed on trigger_id`

---

### Task 5: Drizzle setup + test database helper

**Files:**
- Create: `apps/api/drizzle.config.ts`, `apps/api/src/db/client.ts`
- Create: `apps/api/test/testDb.ts`
- Modify: `apps/api/package.json`, `apps/api/src/env.ts`, `apps/api/src/env.test.ts`, root `package.json`, `.github/workflows/ci.yml`

**Step 1: Install dependencies**

```bash
pnpm --filter @signal/api add drizzle-orm postgres
pnpm --filter @signal/api add -D drizzle-kit @testcontainers/postgresql
```

**Step 2: Extend env schema (TDD — add to `env.test.ts` first)**

New tests: `DATABASE_URL` defaults to the local compose URL in development; `SIGNAL_APP_KEYS` defaults to `dev-app-key`; both **throw when NODE_ENV=production and unset**; `SIGNAL_APP_KEYS: 'k1, k2'` parses to `['k1','k2']`; `SIGNAL_NO_COOLDOWN_DEBOUNCE_SECONDS` defaults 60, coerces.

Implementation additions to `env.ts`:

```ts
DATABASE_URL: z.string().url().optional(),
SIGNAL_APP_KEYS: z.string().optional(),
SIGNAL_NO_COOLDOWN_DEBOUNCE_SECONDS: z.coerce.number().int().positive().default(60),
```

…then in `parseEnv`, after schema parse: default `DATABASE_URL` to `postgresql://signal:signal_local_dev@localhost:5433/signal` and `SIGNAL_APP_KEYS` to `dev-app-key` when `NODE_ENV !== 'production'`; throw listing the missing names when production and unset. Expose `appKeys: string[]` (split on comma, trim, drop empties).

**Step 3: Create db client + drizzle config**

```ts
// apps/api/src/db/client.ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 10 });
  return { db: drizzle(sql, { schema }), close: () => sql.end() };
}
export type Db = ReturnType<typeof createDb>['db'];
```

```ts
// apps/api/drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://signal:signal_local_dev@localhost:5433/signal',
  },
});
```

Add scripts to `apps/api/package.json`: `"db:generate": "drizzle-kit generate"`, `"db:migrate": "drizzle-kit migrate"`. Create empty `apps/api/src/db/schema.ts` (populated next task).

**Step 4: Test DB helper (one container per test file, truncate between tests)**

```ts
// apps/api/test/testDb.ts
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Db } from '../src/db/client.js';

export async function startTestDb(): Promise<{
  db: Db;
  truncateAll: () => Promise<void>;
  stop: () => Promise<void>;
}> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:17-alpine',
  ).start();
  const { db, close } = createDb(container.getConnectionUri());
  await migrate(db, { migrationsFolder: 'drizzle' });
  return {
    db,
    truncateAll: async () => {
      await db.execute(sql`
        truncate responses, trigger_log, suppression_state, campaigns, target_registry, clients
        restart identity cascade
      `);
    },
    stop: async () => {
      await close();
      await container.stop();
    },
  };
}
```

**Step 5: Test-split scripts**

Root `package.json`: `"test": "vitest run"`, `"test:unit": "vitest run --exclude '**/*.int.test.ts'"`. Update `verify` to `pnpm typecheck && pnpm lint && pnpm test`. CI: no change needed (ubuntu runners run Docker); bump the CI job timeout if needed.

**Step 6: Verify** — `pnpm test:unit` green; `pnpm typecheck` green.

**Step 7: Commit** — `chore(api): drizzle + postgres driver, env extensions, testcontainers helper, unit/integration test split`

---

### Task 6: Database schema — all six tables + first migration

**Files:**
- Create: `apps/api/src/db/schema.ts` (full), `apps/api/drizzle/` (generated)
- Test: `apps/api/test/schema.int.test.ts`

**Step 1: Write the failing integration test**

```ts
// apps/api/test/schema.int.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDb } from './testDb.js';
import * as s from '../src/db/schema.js';

describe('schema', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  beforeAll(async () => { t = await startTestDb(); }, 120_000);
  afterAll(async () => { await t.stop(); });

  it('migrations create all six tables and accept a full row cycle', async () => {
    const [target] = await t.db.insert(s.targetRegistry).values({
      name: 'Order Completion', screenId: 'order_completion',
      triggerMechanism: 'action', integrationStatus: 'confirmed_live',
    }).returning();
    const [campaign] = await t.db.insert(s.campaigns).values({
      targetId: target!.id, clientIds: ['cl_A'], metricType: 'CSAT', ratingType: 'star',
      ratingScaleMax: 5, headerText: 'How was it?', positiveThreshold: 4,
      chipsOnNegative: ['Slow'], askFrequency: 'once_per_week', status: 'active',
      createdBy: 'test',
    }).returning();
    const [trigger] = await t.db.insert(s.triggerLog).values({
      campaignId: campaign!.id, userId: 'u_1', clientId: 'cl_A',
      screenId: 'order_completion', shownAt: new Date(),
    }).returning();
    expect(trigger!.id).toMatch(/[0-9a-f-]{36}/);
  });

  it('rejects a second response for the same trigger_id (unique constraint)', async () => {
    await t.truncateAll();
    const [target] = await t.db.insert(s.targetRegistry).values({
      name: 'X', screenId: 'x', triggerMechanism: 'action', integrationStatus: 'confirmed_live',
    }).returning();
    const [campaign] = await t.db.insert(s.campaigns).values({
      targetId: target!.id, clientIds: ['cl_A'], metricType: 'CSAT', ratingType: 'star',
      ratingScaleMax: 5, headerText: 'h', positiveThreshold: 4, chipsOnNegative: [],
      askFrequency: 'no_cooldown', status: 'active', createdBy: 'test',
    }).returning();
    const [trigger] = await t.db.insert(s.triggerLog).values({
      campaignId: campaign!.id, userId: 'u', clientId: 'cl_A', screenId: 'x', shownAt: new Date(),
    }).returning();
    const row = {
      triggerId: trigger!.id, campaignId: campaign!.id, userId: 'u', clientId: 'cl_A',
      screenId: 'x', ratingValue: 5, deviceOs: 'Android', appVersion: '1',
      shownAt: new Date(), respondedAt: new Date(),
    };
    await t.db.insert(s.responses).values(row);
    await expect(t.db.insert(s.responses).values(row)).rejects.toThrow();
  });
});
```

**Step 2: Run to verify failure** — `pnpm test` → FAIL (schema empty / migration missing).

**Step 3: Implement the schema**

```ts
// apps/api/src/db/schema.ts
import {
  boolean, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, index,
} from 'drizzle-orm/pg-core';

export const triggerMechanismEnum = pgEnum('trigger_mechanism', ['action', 'dwell']);
export const integrationStatusEnum = pgEnum('integration_status', [
  'not_sent', 'sent_to_engineering', 'confirmed_live',
]);
export const metricTypeEnum = pgEnum('metric_type', ['CSAT', 'CES']);
export const ratingTypeEnum = pgEnum('rating_type', ['star', 'emoji', 'effort_scale']);
export const onPositiveActionEnum = pgEnum('on_positive_action', ['none', 'play_store_review']);
export const askFrequencyEnum = pgEnum('ask_frequency', [
  'once_per_week', 'once_per_day', 'no_cooldown',
]);
export const campaignStatusEnum = pgEnum('campaign_status', ['draft', 'active', 'paused']);
export const lastActionEnum = pgEnum('last_action', ['dismissed', 'submitted']);
export const clientStatusEnum = pgEnum('client_status', ['active', 'inactive']);

export const targetRegistry = pgTable('target_registry', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  screenId: text('screen_id').notNull().unique(),
  triggerMechanism: triggerMechanismEnum('trigger_mechanism').notNull(),
  integrationStatus: integrationStatusEnum('integration_status').notNull().default('not_sent'),
});

export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetId: uuid('target_id').notNull().references(() => targetRegistry.id),
  clientIds: jsonb('client_ids').$type<string[]>().notNull(),
  metricType: metricTypeEnum('metric_type').notNull(),
  ratingType: ratingTypeEnum('rating_type').notNull(),
  ratingScaleMax: integer('rating_scale_max').notNull(),
  headerText: text('header_text').notNull(),
  positiveThreshold: integer('positive_threshold').notNull(),
  chipsOnNegative: jsonb('chips_on_negative').$type<string[]>().notNull(),
  otherRequiresText: boolean('other_requires_text').notNull().default(true),
  otherAllowsImage: boolean('other_allows_image').notNull().default(false),
  onPositiveAction: onPositiveActionEnum('on_positive_action').notNull().default('none'),
  askFrequency: askFrequencyEnum('ask_frequency').notNull(),
  dailyCap: integer('daily_cap'),
  minTenureDays: integer('min_tenure_days'),
  status: campaignStatusEnum('status').notNull().default('draft'),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('campaigns_status_target_idx').on(t.status, t.targetId)]);

export const suppressionState = pgTable('suppression_state', {
  userId: text('user_id').notNull(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  lastShownAt: timestamp('last_shown_at', { withTimezone: true }).notNull(),
  lastAction: lastActionEnum('last_action'),
  nextEligibleAt: timestamp('next_eligible_at', { withTimezone: true }),
}, (t) => [primaryKey({ columns: [t.userId, t.campaignId] })]);

export const triggerLog = pgTable('trigger_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  userId: text('user_id').notNull(),
  clientId: text('client_id').notNull(),
  screenId: text('screen_id').notNull(),
  shownAt: timestamp('shown_at', { withTimezone: true }).notNull(),
}, (t) => [index('trigger_log_cap_idx').on(t.campaignId, t.userId, t.shownAt)]);

export const responses = pgTable('responses', {
  id: uuid('id').primaryKey().defaultRandom(),
  triggerId: uuid('trigger_id').notNull().references(() => triggerLog.id),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  userId: text('user_id').notNull(),
  clientId: text('client_id').notNull(),
  screenId: text('screen_id').notNull(),
  ratingValue: integer('rating_value').notNull(),
  chipSelected: text('chip_selected'),
  otherText: text('other_text'),
  otherImageUrl: text('other_image_url'),
  location: jsonb('location').$type<{ lat: number; lng: number; state?: string; country?: string }>(),
  deviceOs: text('device_os').notNull(),
  appVersion: text('app_version').notNull(),
  repTenureDays: integer('rep_tenure_days'),
  shownAt: timestamp('shown_at', { withTimezone: true }).notNull(),
  respondedAt: timestamp('responded_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('responses_trigger_id_unique').on(t.triggerId),
  index('responses_reporting_idx').on(t.campaignId, t.respondedAt),
]);

export const clients = pgTable('clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  status: clientStatusEnum('status').notNull(),
  lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }).notNull().defaultNow(),
});
```

**Step 4: Generate the migration** — `pnpm --filter @signal/api db:generate`. Inspect the generated SQL in `apps/api/drizzle/` — confirm it contains all six tables, both unique constraints, and the three indexes.

**Step 5: Run tests to verify green** — `pnpm test` (integration test spins its own container).

**Step 6: Commit** — `feat(api): full v1.1 database schema with idempotency and hot-path indexes`

---

### Task 7: Clock + cooldown math (pure logic)

**Files:**
- Create: `apps/api/src/clock.ts`, `apps/api/src/eligibility/cooldown.ts`
- Test: `apps/api/src/eligibility/cooldown.test.ts`

**Step 1: Write the failing test**

```ts
// apps/api/src/eligibility/cooldown.test.ts
import { describe, expect, it } from 'vitest';
import { cooldownEndsAt } from './cooldown.js';

const now = new Date('2026-07-08T10:00:00Z');
const HOUR = 3_600_000;

describe('cooldownEndsAt', () => {
  it('once_per_day = now + 24h (rolling, not calendar)', () => {
    expect(cooldownEndsAt('once_per_day', now, 60).getTime()).toBe(now.getTime() + 24 * HOUR);
  });
  it('once_per_week = now + 168h', () => {
    expect(cooldownEndsAt('once_per_week', now, 60).getTime()).toBe(now.getTime() + 168 * HOUR);
  });
  it('no_cooldown = now + debounce seconds (M1-D6)', () => {
    expect(cooldownEndsAt('no_cooldown', now, 60).getTime()).toBe(now.getTime() + 60_000);
    expect(cooldownEndsAt('no_cooldown', now, 2).getTime()).toBe(now.getTime() + 2_000);
  });
});
```

**Step 2: Verify failure.**

**Step 3: Implement**

```ts
// apps/api/src/clock.ts
export interface Clock { now(): Date }
export const systemClock: Clock = { now: () => new Date() };
```

```ts
// apps/api/src/eligibility/cooldown.ts
import type { askFrequencySchema } from '@signal/contracts';
import type { z } from 'zod';

type AskFrequency = z.infer<typeof askFrequencySchema>;
const HOUR_MS = 3_600_000;

export function cooldownEndsAt(
  frequency: AskFrequency,
  from: Date,
  noCooldownDebounceSeconds: number,
): Date {
  switch (frequency) {
    case 'once_per_day': return new Date(from.getTime() + 24 * HOUR_MS);
    case 'once_per_week': return new Date(from.getTime() + 168 * HOUR_MS);
    case 'no_cooldown': return new Date(from.getTime() + noCooldownDebounceSeconds * 1000);
  }
}
```

**Step 4: Verify green. Step 5: Commit** — `feat(api): injectable clock and rolling cooldown math`

---

### Task 8: Eligibility decision (pure — every branch tested)

**Files:**
- Create: `apps/api/src/eligibility/decide.ts`
- Test: `apps/api/src/eligibility/decide.test.ts`

**Step 1: Write the failing tests — one per branch, no exceptions**

```ts
// apps/api/src/eligibility/decide.test.ts
import { describe, expect, it } from 'vitest';
import { decide, type DecisionInput } from './decide.js';

const now = new Date('2026-07-08T10:00:00Z');
const past = new Date('2026-07-08T09:00:00Z');
const future = new Date('2026-07-08T11:00:00Z');

const campaign = { minTenureDays: null as number | null, dailyCap: null as number | null };

function input(overrides: Partial<DecisionInput>): DecisionInput {
  return {
    campaign, suppression: undefined, repTenureDays: undefined,
    showsInLast24h: 0, now, ...overrides,
  };
}

describe('decide', () => {
  it('never-asked user is eligible', () => {
    expect(decide(input({}))).toEqual({ eligible: true });
  });
  it('suppressed until a future time → not eligible (reason: suppressed)', () => {
    expect(decide(input({ suppression: { nextEligibleAt: future, lastAction: 'dismissed' } })))
      .toEqual({ eligible: false, reason: 'suppressed' });
  });
  it('cooldown expired → eligible again', () => {
    expect(decide(input({ suppression: { nextEligibleAt: past, lastAction: 'dismissed' } })))
      .toEqual({ eligible: true });
  });
  it('cooldown boundary: eligible exactly AT next_eligible_at', () => {
    expect(decide(input({ suppression: { nextEligibleAt: now, lastAction: 'dismissed' } })))
      .toEqual({ eligible: true });
  });
  it('submitted (nextEligibleAt null) → never again', () => {
    expect(decide(input({ suppression: { nextEligibleAt: null, lastAction: 'submitted' } })))
      .toEqual({ eligible: false, reason: 'never_reask' });
  });
  it('under tenure → not eligible', () => {
    expect(decide(input({ campaign: { ...campaign, minTenureDays: 90 }, repTenureDays: 89 })))
      .toEqual({ eligible: false, reason: 'under_tenure' });
  });
  it('tenure boundary: exactly min → eligible', () => {
    expect(decide(input({ campaign: { ...campaign, minTenureDays: 90 }, repTenureDays: 90 })))
      .toEqual({ eligible: true });
  });
  it('tenure gate + unknown tenure → fails closed (M1-D8)', () => {
    expect(decide(input({ campaign: { ...campaign, minTenureDays: 90 } })))
      .toEqual({ eligible: false, reason: 'tenure_unknown' });
  });
  it('no tenure gate + unknown tenure → eligible', () => {
    expect(decide(input({}))).toEqual({ eligible: true });
  });
  it('daily cap reached → not eligible', () => {
    expect(decide(input({ campaign: { ...campaign, dailyCap: 2 }, showsInLast24h: 2 })))
      .toEqual({ eligible: false, reason: 'daily_cap' });
  });
  it('under daily cap → eligible', () => {
    expect(decide(input({ campaign: { ...campaign, dailyCap: 2 }, showsInLast24h: 1 })))
      .toEqual({ eligible: true });
  });
  it('no daily cap → shows count ignored', () => {
    expect(decide(input({ showsInLast24h: 500 }))).toEqual({ eligible: true });
  });
});
```

**Step 2: Verify failure.**

**Step 3: Implement**

```ts
// apps/api/src/eligibility/decide.ts
export interface DecisionInput {
  campaign: { minTenureDays: number | null; dailyCap: number | null };
  suppression: { nextEligibleAt: Date | null; lastAction: 'dismissed' | 'submitted' | null } | undefined;
  repTenureDays: number | undefined;
  showsInLast24h: number;
  now: Date;
}

export type Decision =
  | { eligible: true }
  | { eligible: false; reason: 'suppressed' | 'never_reask' | 'under_tenure' | 'tenure_unknown' | 'daily_cap' };

export function decide(input: DecisionInput): Decision {
  const { campaign, suppression, repTenureDays, showsInLast24h, now } = input;

  if (suppression) {
    if (suppression.nextEligibleAt === null) return { eligible: false, reason: 'never_reask' };
    if (suppression.nextEligibleAt.getTime() > now.getTime())
      return { eligible: false, reason: 'suppressed' };
  }
  if (campaign.minTenureDays !== null) {
    if (repTenureDays === undefined) return { eligible: false, reason: 'tenure_unknown' };
    if (repTenureDays < campaign.minTenureDays) return { eligible: false, reason: 'under_tenure' };
  }
  if (campaign.dailyCap !== null && showsInLast24h >= campaign.dailyCap)
    return { eligible: false, reason: 'daily_cap' };

  return { eligible: true };
}
```

**Step 4: Verify green (all 12). Step 5: Commit** — `feat(api): pure eligibility decision covering every suppression/tenure/cap branch`

---

### Task 9: Campaign cache (matching + tie-break + refresh)

**Files:**
- Create: `apps/api/src/campaigns/cache.ts`
- Test: `apps/api/src/campaigns/cache.test.ts` (unit — loader injected) and matching logic

**Step 1: Write the failing test**

```ts
// apps/api/src/campaigns/cache.test.ts
import { describe, expect, it } from 'vitest';
import { CampaignCache, type CachedCampaign } from './cache.js';

function c(partial: Partial<CachedCampaign>): CachedCampaign {
  return {
    id: crypto.randomUUID(), screenId: 'order_completion', clientIds: ['cl_A'],
    metricType: 'CSAT', ratingType: 'star', ratingScaleMax: 5, headerText: 'h',
    positiveThreshold: 4, chipsOnNegative: [], otherRequiresText: true,
    otherAllowsImage: false, onPositiveAction: 'none', askFrequency: 'once_per_week',
    dailyCap: null, minTenureDays: null, createdAt: new Date('2026-07-01T00:00:00Z'),
    ...partial,
  };
}

describe('CampaignCache.match', () => {
  it('matches on screen and client', async () => {
    const a = c({});
    const cache = new CampaignCache(async () => [a]);
    await cache.refresh();
    expect(cache.match('order_completion', 'cl_A')?.id).toBe(a.id);
    expect(cache.match('order_completion', 'cl_B')).toBeUndefined();
    expect(cache.match('other_screen', 'cl_A')).toBeUndefined();
  });
  it('overlapping campaigns → oldest created_at wins (M1-D3)', async () => {
    const older = c({ createdAt: new Date('2026-06-01T00:00:00Z') });
    const newer = c({ createdAt: new Date('2026-07-01T00:00:00Z') });
    const cache = new CampaignCache(async () => [newer, older]);
    await cache.refresh();
    expect(cache.match('order_completion', 'cl_A')?.id).toBe(older.id);
  });
  it('refresh swaps contents atomically', async () => {
    let rows: CachedCampaign[] = [c({})];
    const cache = new CampaignCache(async () => rows);
    await cache.refresh();
    rows = [];
    await cache.refresh();
    expect(cache.match('order_completion', 'cl_A')).toBeUndefined();
  });
});
```

**Step 2: Verify failure.**

**Step 3: Implement**

```ts
// apps/api/src/campaigns/cache.ts
export interface CachedCampaign {
  id: string; screenId: string; clientIds: string[];
  metricType: 'CSAT' | 'CES'; ratingType: 'star' | 'emoji' | 'effort_scale';
  ratingScaleMax: number; headerText: string; positiveThreshold: number;
  chipsOnNegative: string[]; otherRequiresText: boolean; otherAllowsImage: boolean;
  onPositiveAction: 'none' | 'play_store_review';
  askFrequency: 'once_per_week' | 'once_per_day' | 'no_cooldown';
  dailyCap: number | null; minTenureDays: number | null; createdAt: Date;
}

export type CampaignLoader = () => Promise<CachedCampaign[]>;

export class CampaignCache {
  private campaigns: CachedCampaign[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly load: CampaignLoader) {}

  async refresh(): Promise<void> {
    this.campaigns = await this.load();
  }

  match(screenId: string, clientId: string): CachedCampaign | undefined {
    return this.campaigns
      .filter((c) => c.screenId === screenId && c.clientIds.includes(clientId))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
  }

  startAutoRefresh(intervalMs = 60_000, onError: (e: unknown) => void = () => {}): void {
    this.timer = setInterval(() => void this.refresh().catch(onError), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
```

Also create the production loader in the same file's sibling `apps/api/src/campaigns/loader.ts`: a Drizzle query selecting **active** campaigns joined to `target_registry` for `screenId` (covered by the Task 10 integration test, no separate unit test needed).

```ts
// apps/api/src/campaigns/loader.ts
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { campaigns, targetRegistry } from '../db/schema.js';
import type { CachedCampaign, CampaignLoader } from './cache.js';

export function makeDbCampaignLoader(db: Db): CampaignLoader {
  return async (): Promise<CachedCampaign[]> => {
    const rows = await db
      .select()
      .from(campaigns)
      .innerJoin(targetRegistry, eq(campaigns.targetId, targetRegistry.id))
      .where(eq(campaigns.status, 'active'));
    return rows.map(({ campaigns: c, target_registry: t }) => ({
      id: c.id, screenId: t.screenId, clientIds: c.clientIds, metricType: c.metricType,
      ratingType: c.ratingType, ratingScaleMax: c.ratingScaleMax, headerText: c.headerText,
      positiveThreshold: c.positiveThreshold, chipsOnNegative: c.chipsOnNegative,
      otherRequiresText: c.otherRequiresText, otherAllowsImage: c.otherAllowsImage,
      onPositiveAction: c.onPositiveAction, askFrequency: c.askFrequency,
      dailyCap: c.dailyCap, minTenureDays: c.minTenureDays, createdAt: c.createdAt,
    }));
  };
}
```

**Step 4: Verify green. Step 5: Commit** — `feat(api): in-memory campaign cache with oldest-wins tie-break and 60s auto-refresh`

---

### Task 10: Atomic suppression claim + eligibility service (integration)

**Files:**
- Create: `apps/api/src/eligibility/claim.ts`, `apps/api/src/eligibility/service.ts`
- Test: `apps/api/test/eligibility.int.test.ts`

**Step 1: Write the failing integration tests** — the heart of the milestone:

```ts
// apps/api/test/eligibility.int.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CampaignCache } from '../src/campaigns/cache.js';
import { makeDbCampaignLoader } from '../src/campaigns/loader.js';
import { EligibilityService } from '../src/eligibility/service.js';
import * as s from '../src/db/schema.js';
import { startTestDb } from './testDb.js';
import type { Clock } from '../src/clock.js';

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now() { return this.current; }
  advanceHours(h: number) { this.current = new Date(this.current.getTime() + h * 3_600_000); }
}

describe('EligibilityService (real Postgres)', () => {
  let t: Awaited<ReturnType<typeof startTestDb>>;
  let clock: FakeClock;
  let service: EligibilityService;
  let cache: CampaignCache;

  beforeAll(async () => { t = await startTestDb(); }, 120_000);
  afterAll(async () => { await t.stop(); });

  beforeEach(async () => {
    await t.truncateAll();
    clock = new FakeClock(new Date('2026-07-08T10:00:00Z'));
    cache = new CampaignCache(makeDbCampaignLoader(t.db));
    service = new EligibilityService(t.db, cache, clock, { noCooldownDebounceSeconds: 60 });
  });

  async function seedCampaign(overrides: Partial<typeof s.campaigns.$inferInsert> = {}) {
    const [target] = await t.db.insert(s.targetRegistry).values({
      name: 'Order Completion', screenId: 'order_completion',
      triggerMechanism: 'action', integrationStatus: 'confirmed_live',
    }).onConflictDoNothing().returning();
    const [campaign] = await t.db.insert(s.campaigns).values({
      targetId: target!.id, clientIds: ['cl_A'], metricType: 'CSAT', ratingType: 'star',
      ratingScaleMax: 5, headerText: 'How was it?', positiveThreshold: 4,
      chipsOnNegative: ['Slow'], askFrequency: 'once_per_week', status: 'active',
      createdBy: 'test', ...overrides,
    }).returning();
    await cache.refresh();
    return campaign!;
  }

  const q = { screenId: 'order_completion', userId: 'u_1', clientId: 'cl_A' } as const;

  it('never-asked user gets config with trigger_id; a TriggerLog row exists', async () => {
    await seedCampaign();
    const result = await service.check(q);
    expect(result).not.toBeNull();
    expect(result!.trigger_id).toMatch(/[0-9a-f-]{36}/);
    const logs = await t.db.select().from(s.triggerLog);
    expect(logs).toHaveLength(1);
  });

  it('no matching campaign → null, and NO TriggerLog row', async () => {
    const result = await service.check(q);
    expect(result).toBeNull();
    expect(await t.db.select().from(s.triggerLog)).toHaveLength(0);
  });

  it('immediately after a show → suppressed (provisional cooldown, M1-D10)', async () => {
    await seedCampaign();
    expect(await service.check(q)).not.toBeNull();
    expect(await service.check(q)).toBeNull();
  });

  it('weekly cooldown: still suppressed at +167h, eligible at +169h', async () => {
    await seedCampaign();
    await service.check(q);
    clock.advanceHours(167);
    expect(await service.check(q)).toBeNull();
    clock.advanceHours(2);
    expect(await service.check(q)).not.toBeNull();
  });

  it('tenure gate: 89 days → null; 90 → config; unknown → null (fail closed)', async () => {
    await seedCampaign({ minTenureDays: 90 });
    expect(await service.check({ ...q, repTenureDays: 89 })).toBeNull();
    expect(await service.check({ ...q, repTenureDays: 90 })).not.toBeNull();
    await t.db.delete(s.suppressionState);
    expect(await service.check({ ...q, userId: 'u_2' })).toBeNull();
  });

  it('daily cap 2 on no_cooldown: third show within 24h → null; window rolls → eligible', async () => {
    await seedCampaign({ askFrequency: 'no_cooldown', dailyCap: 2 });
    expect(await service.check(q)).not.toBeNull();
    clock.advanceHours(1);
    expect(await service.check(q)).not.toBeNull();
    clock.advanceHours(1);
    expect(await service.check(q)).toBeNull(); // cap hit
    clock.advanceHours(23); // first show now >24h old
    expect(await service.check(q)).not.toBeNull();
  });

  it('no_cooldown debounce: immediate second call → null (M1-D6)', async () => {
    await seedCampaign({ askFrequency: 'no_cooldown' });
    expect(await service.check(q)).not.toBeNull();
    expect(await service.check(q)).toBeNull();
  });

  it('THE RACE: two concurrent checks → exactly one config, one TriggerLog row (M1-D9)', async () => {
    await seedCampaign();
    const [a, b] = await Promise.all([service.check(q), service.check(q)]);
    const granted = [a, b].filter((r) => r !== null);
    expect(granted).toHaveLength(1);
    expect(await t.db.select().from(s.triggerLog)).toHaveLength(1);
  });

  it('two campaigns, same screen, different clients — independent suppression', async () => {
    await seedCampaign();
    await seedCampaign({ clientIds: ['cl_B'] });
    expect(await service.check(q)).not.toBeNull();
    expect(await service.check({ ...q, clientId: 'cl_B' })).not.toBeNull();
  });
});
```

**Step 2: Verify failure.**

**Step 3: Implement claim + service**

```ts
// apps/api/src/eligibility/claim.ts
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

/**
 * Atomic check-and-claim (M1-D9/D10). Returns true if this call won the right
 * to show. Loses when a row exists with next_eligible_at NULL (never re-ask)
 * or in the future (suppressed) — including a row written microseconds ago
 * by a concurrent request.
 */
export async function claimShow(
  db: Db,
  userId: string,
  campaignId: string,
  now: Date,
  nextEligibleAt: Date,
): Promise<boolean> {
  const result = await db.execute(sql`
    insert into suppression_state (user_id, campaign_id, last_shown_at, last_action, next_eligible_at)
    values (${userId}, ${campaignId}, ${now}, null, ${nextEligibleAt})
    on conflict (user_id, campaign_id) do update
      set last_shown_at = ${now}, last_action = null, next_eligible_at = ${nextEligibleAt}
      where suppression_state.next_eligible_at is not null
        and suppression_state.next_eligible_at <= ${now}
    returning user_id
  `);
  return result.length === 1;
}
```

```ts
// apps/api/src/eligibility/service.ts
import { and, eq, gt, sql } from 'drizzle-orm';
import type { EligibilityConfig } from '@signal/contracts';
import type { CampaignCache } from '../campaigns/cache.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { suppressionState, triggerLog } from '../db/schema.js';
import { cooldownEndsAt } from './cooldown.js';
import { claimShow } from './claim.js';
import { decide } from './decide.js';

export interface EligibilityQueryInput {
  screenId: string; userId: string; clientId: string; repTenureDays?: number;
}

export class EligibilityService {
  constructor(
    private readonly db: Db,
    private readonly cache: CampaignCache,
    private readonly clock: Clock,
    private readonly opts: { noCooldownDebounceSeconds: number },
  ) {}

  async check(input: EligibilityQueryInput): Promise<EligibilityConfig | null> {
    const campaign = this.cache.match(input.screenId, input.clientId);
    if (!campaign) return null;

    const now = this.clock.now();

    const [suppression] = await this.db.select().from(suppressionState).where(and(
      eq(suppressionState.userId, input.userId),
      eq(suppressionState.campaignId, campaign.id),
    ));

    let showsInLast24h = 0;
    if (campaign.dailyCap !== null) {
      const windowStart = new Date(now.getTime() - 24 * 3_600_000);
      const [row] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(triggerLog)
        .where(and(
          eq(triggerLog.campaignId, campaign.id),
          eq(triggerLog.userId, input.userId),
          gt(triggerLog.shownAt, windowStart),
        ));
      showsInLast24h = row?.count ?? 0;
    }

    const decision = decide({
      campaign: { minTenureDays: campaign.minTenureDays, dailyCap: campaign.dailyCap },
      suppression: suppression
        ? { nextEligibleAt: suppression.nextEligibleAt, lastAction: suppression.lastAction }
        : undefined,
      repTenureDays: input.repTenureDays,
      showsInLast24h,
      now,
    });
    if (!decision.eligible) return null;

    const nextEligibleAt = cooldownEndsAt(
      campaign.askFrequency, now, this.opts.noCooldownDebounceSeconds,
    );

    return await this.db.transaction(async (tx) => {
      const claimed = await claimShow(tx as unknown as Db, input.userId, campaign.id, now, nextEligibleAt);
      if (!claimed) return null; // lost the race — someone else is showing right now
      const [trigger] = await tx.insert(triggerLog).values({
        campaignId: campaign.id, userId: input.userId, clientId: input.clientId,
        screenId: input.screenId, shownAt: now,
      }).returning();
      return {
        trigger_id: trigger!.id,
        campaign_id: campaign.id,
        metric_type: campaign.metricType,
        header: campaign.headerText,
        rating_type: campaign.ratingType,
        rating_scale_max: campaign.ratingScaleMax,
        positive_threshold: campaign.positiveThreshold,
        chips_on_negative: campaign.chipsOnNegative,
        other_requires_text: campaign.otherRequiresText,
        other_allows_image: campaign.otherAllowsImage,
        on_positive_action: campaign.onPositiveAction,
        skip_enabled: true,
      };
    });
  }
}
```

**Step 4: Run to green** — all 9 integration scenarios, especially THE RACE.

**Step 5: Commit** — `feat(api): eligibility service with atomic claim — race-proof, clock-injected, cap/tenure/cooldown proven against real postgres`

---

### Task 11: Response service (idempotent, status-tolerant)

**Files:**
- Create: `apps/api/src/feedback/respond.ts`
- Test: `apps/api/test/respond.int.test.ts`

**Step 1: Write the failing integration tests**

Scenarios (reuse `seedCampaign` + service pattern from Task 10 to create a real trigger first):
1. Valid response → row in `responses`; suppression becomes `last_action='submitted'`, `next_eligible_at=NULL`; subsequent `service.check` → null forever (advance clock 1000h to prove)
2. **Idempotency:** same payload POSTed twice → `ok` both times, exactly one row (M1-D2)
3. Unknown `trigger_id` → result `unknown_trigger`
4. Rating out of range for the campaign's type (emoji campaign, rating 4) → result `invalid_rating` (M1-D13)
5. Campaign paused after the trigger → response still accepted (M1-D12)
6. `chip_selected` not in the campaign's chip list → still accepted, stored as sent (M1-D13)

**Step 2: Verify failure.**

**Step 3: Implement**

```ts
// apps/api/src/feedback/respond.ts
import { and, eq } from 'drizzle-orm';
import { ratingBoundsFor, type ResponseBody } from '@signal/contracts';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { campaigns, responses, suppressionState, triggerLog } from '../db/schema.js';

export type RespondResult = 'ok' | 'unknown_trigger' | 'invalid_rating';

export async function recordResponse(
  db: Db, clock: Clock, body: ResponseBody,
): Promise<RespondResult> {
  const [trigger] = await db.select().from(triggerLog)
    .where(eq(triggerLog.id, body.trigger_id));
  if (!trigger) return 'unknown_trigger';

  // Campaign status deliberately NOT checked (M1-D12); we read it only for rating bounds.
  const [campaign] = await db.select().from(campaigns)
    .where(eq(campaigns.id, trigger.campaignId));
  if (!campaign) return 'unknown_trigger';

  const bounds = ratingBoundsFor(campaign.ratingType, campaign.ratingScaleMax);
  if (body.rating_value < bounds.min || body.rating_value > bounds.max) return 'invalid_rating';

  await db.transaction(async (tx) => {
    await tx.insert(responses).values({
      triggerId: trigger.id, campaignId: trigger.campaignId, userId: trigger.userId,
      clientId: trigger.clientId, screenId: trigger.screenId,
      ratingValue: body.rating_value, chipSelected: body.chip_selected ?? null,
      otherText: body.other_text ?? null, otherImageUrl: body.other_image_url ?? null,
      location: body.location ?? null, deviceOs: body.device_os, appVersion: body.app_version,
      repTenureDays: body.rep_tenure_days ?? null,
      shownAt: new Date(body.shown_at), respondedAt: new Date(body.responded_at),
      receivedAt: clock.now(),
    }).onConflictDoNothing({ target: responses.triggerId }); // idempotent (M1-D2)

    await tx.update(suppressionState)
      .set({ lastAction: 'submitted', nextEligibleAt: null }) // never re-ask (M1-D11)
      .where(and(
        eq(suppressionState.userId, trigger.userId),
        eq(suppressionState.campaignId, trigger.campaignId),
      ));
  });
  return 'ok';
}
```

**Step 4: Run to green. Step 5: Commit** — `feat(api): idempotent response recording; submitted means never re-ask`

---

### Task 12: Dismiss service

**Files:**
- Create: `apps/api/src/feedback/dismiss.ts`
- Test: `apps/api/test/dismiss.int.test.ts`

**Step 1: Write the failing integration tests**

Scenarios:
1. Dismiss → suppression `last_action='dismissed'`, `next_eligible_at = server now + campaign cooldown`; `service.check` → null before cooldown ends, config after (fake clock)
2. Idempotent: dismissing twice → `ok`, no error, cooldown anchored to the **first** dismiss (second call is a no-op because `last_action` is already set — guard on `last_action IS NULL`)
3. Unknown trigger → `unknown_trigger`
4. Dismiss arriving AFTER a response for the same trigger (outbox weirdness) → no-op: submitted wins, `next_eligible_at` stays NULL

**Step 2: Verify failure.**

**Step 3: Implement**

```ts
// apps/api/src/feedback/dismiss.ts
import { and, eq, isNull } from 'drizzle-orm';
import type { DismissBody } from '@signal/contracts';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { campaigns, suppressionState, triggerLog } from '../db/schema.js';
import { cooldownEndsAt } from '../eligibility/cooldown.js';

export type DismissResult = 'ok' | 'unknown_trigger';

export async function recordDismiss(
  db: Db, clock: Clock, body: DismissBody,
  opts: { noCooldownDebounceSeconds: number },
): Promise<DismissResult> {
  const [trigger] = await db.select().from(triggerLog).where(eq(triggerLog.id, body.trigger_id));
  if (!trigger) return 'unknown_trigger';
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, trigger.campaignId));
  if (!campaign) return 'unknown_trigger';

  const now = clock.now();
  await db.update(suppressionState)
    .set({
      lastAction: 'dismissed',
      nextEligibleAt: cooldownEndsAt(campaign.askFrequency, now, opts.noCooldownDebounceSeconds),
    })
    .where(and(
      eq(suppressionState.userId, trigger.userId),
      eq(suppressionState.campaignId, trigger.campaignId),
      isNull(suppressionState.lastAction), // only from provisional state: idempotent + submitted wins
    ));
  return 'ok';
}
```

**Step 4: Run to green. Step 5: Commit** — `feat(api): dismiss handling — cooldown from server time, idempotent, submitted wins`

---

### Task 13: App-key auth plugin

**Files:**
- Create: `apps/api/src/plugins/appKeyAuth.ts`
- Test: `apps/api/src/plugins/appKeyAuth.test.ts` (unit, via a throwaway Fastify instance + inject)

**Step 1: Write the failing test** — routes registered under the plugin return 401 with error body `{error:{code:'unauthorized'}}` when the header is missing or wrong; pass through when the key matches; multiple keys supported (rotation).

**Step 2: Verify failure.**

**Step 3: Implement**

```ts
// apps/api/src/plugins/appKeyAuth.ts
import type { FastifyPluginAsync } from 'fastify';

export function appKeyAuth(validKeys: readonly string[]): FastifyPluginAsync {
  const keys = new Set(validKeys);
  return async (app) => {
    app.addHook('onRequest', async (request, reply) => {
      const presented = request.headers['x-signal-app-key'];
      if (typeof presented !== 'string' || !keys.has(presented)) {
        await reply.code(401).send({
          error: { code: 'unauthorized', message: 'missing or invalid X-Signal-App-Key' },
        });
      }
    });
  };
}
```

**Step 4: Run to green. Step 5: Commit** — `feat(api): app-key auth plugin with key rotation support`

---

### Task 14: HTTP routes — wire the three endpoints

**Files:**
- Create: `apps/api/src/routes/sdk.ts`
- Modify: `apps/api/src/app.ts` (build services, register routes)
- Test: `apps/api/test/routes.int.test.ts`

**Step 1: Write the failing integration tests** (full app via `buildApp` + `app.inject`, Testcontainers DB):

1. `GET /v1/sdk/eligibility` with valid key + eligible seed → **200**, body parses with `eligibilityConfigSchema`
2. Same again → **204**, empty body
3. Missing `screen_id` → **422** with error body
4. No/wrong app key on all three routes → **401**
5. `POST /v1/sdk/response` valid → **204**; replay → **204**; DB has one row
6. `POST /v1/sdk/response` unknown trigger → **404**; emoji campaign + rating 4 → **422** code `invalid_rating`
7. `POST /v1/sdk/dismiss` valid → **204**
8. Malformed JSON body → **422**, never a crash or hang (fail-silent guarantee)

**Step 2: Verify failure.**

**Step 3: Implement**

```ts
// apps/api/src/routes/sdk.ts
import type { FastifyPluginAsync } from 'fastify';
import {
  dismissBodySchema, eligibilityQuerySchema, responseBodySchema,
} from '@signal/contracts';
import type { EligibilityService } from '../eligibility/service.js';
import type { Clock } from '../clock.js';
import type { Db } from '../db/client.js';
import { recordDismiss } from '../feedback/dismiss.js';
import { recordResponse } from '../feedback/respond.js';

export function sdkRoutes(deps: {
  db: Db; clock: Clock; eligibility: EligibilityService;
  noCooldownDebounceSeconds: number;
}): FastifyPluginAsync {
  return async (app) => {
    app.get('/eligibility', async (request, reply) => {
      const parsed = eligibilityQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'invalid_query', message: parsed.error.issues[0]?.message ?? 'invalid' },
        });
      }
      const config = await deps.eligibility.check({
        screenId: parsed.data.screen_id, userId: parsed.data.user_id,
        clientId: parsed.data.client_id, repTenureDays: parsed.data.rep_tenure_days,
      });
      if (!config) return reply.code(204).send();
      return reply.code(200).send(config);
    });

    app.post('/response', async (request, reply) => {
      const parsed = responseBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'invalid_body', message: parsed.error.issues[0]?.message ?? 'invalid' },
        });
      }
      const result = await recordResponse(deps.db, deps.clock, parsed.data);
      if (result === 'unknown_trigger')
        return reply.code(404).send({ error: { code: 'unknown_trigger', message: 'no such trigger_id' } });
      if (result === 'invalid_rating')
        return reply.code(422).send({ error: { code: 'invalid_rating', message: 'rating outside campaign scale' } });
      return reply.code(204).send();
    });

    app.post('/dismiss', async (request, reply) => {
      const parsed = dismissBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(422).send({
          error: { code: 'invalid_body', message: parsed.error.issues[0]?.message ?? 'invalid' },
        });
      }
      const result = await recordDismiss(deps.db, deps.clock, parsed.data, {
        noCooldownDebounceSeconds: deps.noCooldownDebounceSeconds,
      });
      if (result === 'unknown_trigger')
        return reply.code(404).send({ error: { code: 'unknown_trigger', message: 'no such trigger_id' } });
      return reply.code(204).send();
    });
  };
}
```

Rework `buildApp` to compose everything (keep `/health` as-is, unauthenticated):

```ts
// apps/api/src/app.ts  (new shape)
import { SIGNAL_API_VERSION } from '@signal/contracts';
import Fastify from 'fastify';
import { CampaignCache } from './campaigns/cache.js';
import { makeDbCampaignLoader } from './campaigns/loader.js';
import { systemClock, type Clock } from './clock.js';
import { createDb, type Db } from './db/client.js';
import { EligibilityService } from './eligibility/service.js';
import type { Env } from './env.js';
import { appKeyAuth } from './plugins/appKeyAuth.js';
import { sdkRoutes } from './routes/sdk.js';

export interface AppDeps { db?: Db; clock?: Clock; closeDb?: () => Promise<void> }

export async function buildApp(env: Env, deps: AppDeps = {}) {
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
  });

  let closeDb = deps.closeDb;
  let db = deps.db;
  if (!db) {
    const created = createDb(env.DATABASE_URL);
    db = created.db;
    closeDb = created.close;
  }
  const clock = deps.clock ?? systemClock;

  const cache = new CampaignCache(makeDbCampaignLoader(db));
  await cache.refresh();
  cache.startAutoRefresh(60_000, (e) => app.log.error(e, 'campaign cache refresh failed'));

  const eligibility = new EligibilityService(db, cache, clock, {
    noCooldownDebounceSeconds: env.SIGNAL_NO_COOLDOWN_DEBOUNCE_SECONDS,
  });

  app.get('/health', async () => ({ status: 'ok' as const, version: SIGNAL_API_VERSION }));

  await app.register(async (sdk) => {
    await sdk.register(appKeyAuth(env.appKeys));
    await sdk.register(sdkRoutes({
      db: db!, clock, eligibility,
      noCooldownDebounceSeconds: env.SIGNAL_NO_COOLDOWN_DEBOUNCE_SECONDS,
    }));
  }, { prefix: '/v1/sdk' });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    void reply.code(500).send({ error: { code: 'internal', message: 'internal error' } });
  });

  app.addHook('onClose', async () => {
    cache.stop();
    if (closeDb) await closeDb();
  });

  return app;
}
```

Note: `env.DATABASE_URL` is now non-optional after `parseEnv` resolves defaults (Task 5) — adjust the `Env` type accordingly (post-parse type has `DATABASE_URL: string`, `appKeys: string[]`). Update the M0 `app.test.ts` health test to pass a stub `db` dep or skip DB creation when `deps.db` provided — the health route must keep working without a real database in unit tests: pass `deps: { db: {} as Db, closeDb: async () => {} }` won't survive `cache.refresh()`; instead make `buildApp` skip cache refresh when the campaign loader fails at startup — **no**: keep it simple and honest — convert `app.test.ts` health checks into the integration suite (`routes.int.test.ts`) and delete the unit variant. Health is then covered with a real DB, which is what production does anyway.

**Step 4: Run to green** — `pnpm test` (all suites) + `pnpm verify`.

**Step 5: Commit** — `feat(api): /v1/sdk eligibility, response, dismiss routes with auth and error contract`

---

### Task 15: Dev seed script

**Files:**
- Create: `apps/api/src/scripts/seed-dev.ts`
- Modify: `apps/api/package.json` (add `"seed": "tsx src/scripts/seed-dev.ts"`)

**Step 1: Implement (no test — it's dev tooling; correctness proven by the demo script using it)**

The script (idempotent — safe to re-run):
1. Connects using `parseEnv(process.env)`
2. Upserts clients: `cl_A` "Acme Distribution" (active), `cl_B` "Bharat FMCG" (active), `cl_X` "Churned Co" (inactive)
3. Upserts targets: `order_completion` (action), `new_customer_creation` (action), `goal_monitoring_page` (dwell) — all `confirmed_live`
4. Upserts four campaigns (match on a fixed `createdBy: 'seed'` + header, delete-then-insert for repeatability):
   - **Star / weekly** on `order_completion`, clients `[cl_A, cl_B]`, threshold 4, chips `["Slow to load","Items hard to find","Sync failed"]`, `on_positive_action: play_store_review`
   - **Emoji / daily** on `new_customer_creation`, client `[cl_A]`, threshold 3, `rating_scale_max: 3`
   - **Effort(3) / no_cooldown, daily_cap 2** on `goal_monitoring_page`, client `[cl_A]`, threshold 2, `rating_scale_max: 3`
   - **Star / weekly, min_tenure_days 90** on `new_customer_creation`, client `[cl_B]` (tenure-gate demo; note: cl_B not cl_A, to respect the one-active-campaign-per-(target,client) rule)
5. Prints a table of campaign IDs + screen/client pairs for use with curl

**Step 2: Verify manually**

```bash
docker compose up -d && pnpm --filter @signal/api db:migrate
pnpm --filter @signal/api seed   # run twice — second run must not error or duplicate
docker compose exec postgres psql -U signal -d signal -c "select count(*) from campaigns;"
```
Expected: 4 campaigns after both runs.

**Step 3: Commit** — `feat(api): idempotent dev seed — four campaigns covering every rating type and rule`

---### Task 16: The exit-proof demo script

**Files:**
- Create: `scripts/demo-loop.sh` (chmod +x)

**Step 1: Write the script**

Bash, `set -euo pipefail`, requires `jq`. Env: `BASE=${BASE:-http://localhost:3000}`, `KEY=${KEY:-dev-app-key}`. Helper functions `expect_status` / `expect_json`. Sequence (each step prints ✅/❌ and exits non-zero on failure):

1. `/health` → 200
2. **Auth:** eligibility without key → 401; with wrong key → 401
3. **Grant:** eligibility for `u_demo_1`/`cl_A`/`order_completion` (tenure 200) → 200; capture `trigger_id`; assert `rating_type == "star"`
4. **Debounce/suppress:** immediate repeat → 204
5. **Respond:** POST response (rating 5) with captured `trigger_id` → 204
6. **Idempotent replay:** same POST again → 204
7. **Never re-ask:** eligibility again → 204
8. **Dismiss path:** new user `u_demo_2` → 200, capture trigger; POST dismiss → 204; eligibility → 204 (cooldown)
9. **Validation:** eligibility for the emoji campaign (`u_demo_3`/`cl_A`/`new_customer_creation`) → 200; respond rating 4 → 422 `invalid_rating`; respond rating 3 → 204
10. **Tenure gate:** `u_demo_4`/`cl_B`/`new_customer_creation` with tenure 30 → 204; tenure 120 → 200; no tenure param (fresh user `u_demo_5`) → 204 (fail-closed)
11. **Daily cap:** `u_demo_6`/`cl_A`/`goal_monitoring_page` → 200, 200 (after debounce), then → 204 (cap 2). Requires server started with `SIGNAL_NO_COOLDOWN_DEBOUNCE_SECONDS=2`; script sleeps 3s between cap attempts
12. **Race:** two parallel eligibility calls for `u_demo_7` (`xargs -P2` or backgrounded curls) → exactly one 200
13. Prints `ALL SCENARIOS PASSED`

**Step 2: Run it end to end**

```bash
docker compose up -d
pnpm --filter @signal/api db:migrate && pnpm --filter @signal/api seed
SIGNAL_NO_COOLDOWN_DEBOUNCE_SECONDS=2 pnpm --filter @signal/api dev &
./scripts/demo-loop.sh
```
Expected: `ALL SCENARIOS PASSED`.

**Step 3: Commit** — `feat: end-to-end demo script proving the complete product loop`

---

### Task 17: README + closeout

**Files:**
- Modify: `README.md`

**Step 1: Add to README:** a "Core loop demo" section with the four commands from Task 16 Step 2, and a one-line pointer to the spec/architecture/plan docs.

**Step 2: Full verification** — `pnpm verify` green; `pnpm test:unit` green with Docker stopped; demo script green with Docker up.

**Step 3: Commit** — `docs: core loop demo instructions`

---

## Milestone Exit Checklist

- [ ] Spec reads v1.1; docs and code agree on every field name
- [ ] `pnpm verify` green; `pnpm test:unit` green **without Docker**
- [ ] Unit coverage: every `decide` branch (12 tests), cooldown math, cache tie-break, auth
- [ ] Integration coverage: cooldown expiry via fake clock, daily-cap rollover, tenure fail-closed, **concurrent-race single-grant**, response idempotency, dismiss-after-response (submitted wins), paused-campaign response accepted
- [ ] `./scripts/demo-loop.sh` prints ALL SCENARIOS PASSED against the seeded local server
- [ ] `responses.trigger_id` unique constraint exists in the generated migration SQL
- [ ] No `now()` inside suppression SQL — grep `apps/api/src` for it and confirm timestamps are parameters
- [ ] Git log: one focused commit per task

**Next:** Milestone 2 — Console (PM auth, campaign CRUD, builder UI on the Signal design system).
