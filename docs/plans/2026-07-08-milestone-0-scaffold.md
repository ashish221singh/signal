# Milestone 0 — Repository Scaffold Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** A clean, verified foundation — git repo, pnpm monorepo, TypeScript, tests, lint, local Postgres, CI — such that `pnpm verify` passes on a fresh clone and Milestone 1 can start with zero setup friction.

**Architecture:** pnpm workspace monorepo per `signal-architecture-v1.md` §2: `apps/api` (Fastify), `packages/contracts` (Zod schemas), `apps/console` deferred to Milestone 2, `sdk-android/` deferred to Milestone 3. One root-level test/lint/typecheck pipeline; Postgres via docker-compose (not yet wired to the API — that's Milestone 1).

**Tech Stack:** Node 22 LTS, pnpm 10, TypeScript (strict), Vitest, Biome (lint + format), Fastify 5, Zod 4, Postgres 17 (Docker), GitHub Actions.

---

## Decisions & Edge Cases (settled here so nothing stays open)

| # | Decision | Rationale / edge case covered |
|---|---|---|
| D1 | Node 22 LTS pinned via `.nvmrc` + `engines` + `packageManager` field | Prevents "works on my machine" version drift; corepack auto-selects pnpm version |
| D2 | ESM everywhere (`"type": "module"`) | One module system; avoids CJS/ESM interop bugs. Runtime via `tsx` (no build step in dev); production build strategy decided in Milestone 4 |
| D3 | `moduleResolution: "bundler"`, typecheck-only (`noEmit`) | Lets `apps/api` import `@signal/contracts` TS source directly — no watch/rebuild dance in the monorepo |
| D4 | Biome instead of ESLint + Prettier | One fast tool for lint + format; less config surface for solo/AI maintenance |
| D5 | Postgres on host port **5433** (not 5432) | Avoids clashing with any Postgres already running locally |
| D6 | Env vars parsed by a Zod schema; process exits with a clear message on invalid env | Fail-fast at boot, never at first request. `.env` gitignored; `.env.example` committed |
| D7 | Test suite must pass **without Docker running** in Milestone 0 | No DB-dependent code yet; CI stays green without services. Milestone 1 adds Testcontainers |
| D8 | `/health` returns a body validated against a schema from `@signal/contracts` | Proves the cross-package contract wiring end-to-end on day one |
| D9 | Graceful shutdown on SIGTERM/SIGINT | Required for container platforms (Fly/Railway/Render) later; cheap now |
| D10 | `apps/console` and `sdk-android/` NOT scaffolded now | YAGNI — empty stubs rot; each is created at the start of its own milestone |
| D11 | Pushing to GitHub is a user step | CI workflow file is written and committed; activating it requires the user to create the remote and push |

---

### Task 1: Initialize the git repository

**Files:**
- Create: `.gitignore`
- Existing (committed as-is): `README.md`, `docs/`, `design/`

**Step 1: Create `.gitignore`**

```gitignore
# dependencies
node_modules/

# build output
dist/
*.tsbuildinfo

# environment — never commit real env values
.env
.env.*
!.env.example

# test artifacts
coverage/

# OS / editor noise
.DS_Store
*.log
.idea/
.vscode/*
!.vscode/extensions.json
```

**Step 2: Initialize repo and make the first commit**

Run (from `Signal/`):
```bash
git init
git add .gitignore README.md docs/ design/
git commit -m "chore: initial commit — spec, architecture, design system, plans"
```
Expected: commit succeeds; `git log --oneline` shows 1 commit.

**Step 3: Verify nothing is untracked that shouldn't be**

Run: `git status --short`
Expected: empty output.

---

### Task 2: pnpm workspace root

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `.editorconfig`

**Step 1: Create root `package.json`**

```json
{
  "name": "signal",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.0.0",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r typecheck",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "verify": "pnpm typecheck && pnpm lint && pnpm test"
  }
}
```

**Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

**Step 3: Create `.nvmrc`**

```
22
```

**Step 4: Create `.editorconfig`**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
```

**Step 5: Verify pnpm resolves the workspace**

Run: `pnpm install`
Expected: succeeds, creates `pnpm-lock.yaml` (empty-ish is fine — no packages yet).

**Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml .nvmrc .editorconfig pnpm-lock.yaml
git commit -m "chore: pnpm workspace root with pinned node/pnpm versions"
```

---

### Task 3: TypeScript base configuration

**Files:**
- Create: `tsconfig.base.json`

**Step 1: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  }
}
```

**Step 2: Install TypeScript + node types at the root**

Run: `pnpm add -D -w typescript @types/node`
Expected: added to root `devDependencies`.

**Step 3: Commit**

```bash
git add tsconfig.base.json package.json pnpm-lock.yaml
git commit -m "chore: strict TypeScript base config (ESM, bundler resolution, noEmit)"
```

---

### Task 4: Biome (lint + format)

**Files:**
- Create: `biome.json`

**Step 1: Install Biome**

Run: `pnpm add -D -w @biomejs/biome`

**Step 2: Create `biome.json`**

```json
{
  "files": {
    "includes": ["apps/**", "packages/**", "*.json", "*.ts"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "always"
    }
  }
}
```

(If the installed Biome major uses a different schema key — e.g. `files.include` vs `files.includes` — run `pnpm biome migrate --write` and keep the generated shape.)

**Step 3: Verify lint runs clean**

Run: `pnpm lint`
Expected: exits 0 (nothing to lint yet is fine).

**Step 4: Commit**

```bash
git add biome.json package.json pnpm-lock.yaml
git commit -m "chore: biome for lint and format"
```

---

### Task 5: `packages/contracts` — first real package, first real test

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/src/health.ts`
- Test: `packages/contracts/src/health.test.ts`
- Create: `vitest.config.ts` (root)

**Step 1: Create `packages/contracts/package.json`**

```json
{
  "name": "@signal/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^4.0.0"
  }
}
```

**Step 2: Create `packages/contracts/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

**Step 3: Install deps and create root Vitest config**

Run: `pnpm install` then `pnpm add -D -w vitest`

Create `vitest.config.ts` (root):
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts'],
  },
});
```

**Step 4: Write the failing test**

`packages/contracts/src/health.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { healthResponseSchema, SIGNAL_API_VERSION } from './index.js';

describe('health contract', () => {
  it('accepts a valid health response', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      version: SIGNAL_API_VERSION,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status value', () => {
    const result = healthResponseSchema.safeParse({
      status: 'sideways',
      version: SIGNAL_API_VERSION,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing version', () => {
    const result = healthResponseSchema.safeParse({ status: 'ok' });
    expect(result.success).toBe(false);
  });
});
```

**Step 5: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — cannot resolve `./index.js` exports.

**Step 6: Write the implementation**

`packages/contracts/src/health.ts`:
```ts
import { z } from 'zod';

export const SIGNAL_API_VERSION = '0.1.0';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
```

`packages/contracts/src/index.ts`:
```ts
export * from './health.js';
```

**Step 7: Run tests to verify they pass**

Run: `pnpm test`
Expected: 3 passing.

Run: `pnpm typecheck`
Expected: clean.

**Step 8: Commit**

```bash
git add packages/contracts vitest.config.ts package.json pnpm-lock.yaml
git commit -m "feat(contracts): package skeleton with health response schema"
```

---

### Task 6: `apps/api` — env validation (fail-fast boot)

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/env.ts`
- Test: `apps/api/src/env.test.ts`

**Step 1: Create `apps/api/package.json`**

```json
{
  "name": "@signal/api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@signal/contracts": "workspace:*",
    "fastify": "^5.0.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0"
  }
}
```

**Step 2: Create `apps/api/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src"]
}
```

Run: `pnpm install`

**Step 3: Write the failing test**

`apps/api/src/env.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseEnv } from './env.js';

describe('parseEnv', () => {
  it('applies defaults when optional vars are absent', () => {
    const env = parseEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('coerces PORT from string', () => {
    const env = parseEnv({ PORT: '8080' });
    expect(env.PORT).toBe(8080);
  });

  it('throws a readable error on invalid NODE_ENV', () => {
    expect(() => parseEnv({ NODE_ENV: 'staging-ish' })).toThrow(/NODE_ENV/);
  });

  it('throws a readable error on non-numeric PORT', () => {
    expect(() => parseEnv({ PORT: 'yes' })).toThrow(/PORT/);
  });
});
```

**Step 4: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `./env.js` does not exist.

**Step 5: Write the implementation**

`apps/api/src/env.ts`:
```ts
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }
  return result.data;
}
```

**Step 6: Run tests to verify they pass**

Run: `pnpm test`
Expected: all passing (contracts + env).

**Step 7: Commit**

```bash
git add apps/api package.json pnpm-lock.yaml
git commit -m "feat(api): zod-validated environment parsing with fail-fast errors"
```

---

### Task 7: `apps/api` — app factory with `/health`

**Files:**
- Create: `apps/api/src/app.ts`
- Test: `apps/api/src/app.test.ts`

**Step 1: Write the failing test**

`apps/api/src/app.test.ts`:
```ts
import { healthResponseSchema } from '@signal/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { parseEnv } from './env.js';

describe('GET /health', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp(parseEnv({ NODE_ENV: 'test' }));
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with a body matching the health contract', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const parsed = healthResponseSchema.safeParse(response.json());
    expect(parsed.success).toBe(true);
  });

  it('returns 404 for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test`
Expected: FAIL — `./app.js` does not exist.

**Step 3: Write the implementation**

`apps/api/src/app.ts`:
```ts
import { SIGNAL_API_VERSION } from '@signal/contracts';
import Fastify from 'fastify';
import type { Env } from './env.js';

export async function buildApp(env: Env) {
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
  });

  app.get('/health', async () => ({
    status: 'ok' as const,
    version: SIGNAL_API_VERSION,
  }));

  return app;
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test` and `pnpm typecheck`
Expected: all green — this proves `apps/api` consumes `@signal/contracts` source directly (decision D3/D8).

**Step 5: Commit**

```bash
git add apps/api/src/app.ts apps/api/src/app.test.ts
git commit -m "feat(api): app factory with /health validated against contracts"
```

---

### Task 8: `apps/api` — server entry with graceful shutdown

**Files:**
- Create: `apps/api/src/server.ts`

**Step 1: Write the server entry**

`apps/api/src/server.ts`:
```ts
import { buildApp } from './app.js';
import { parseEnv } from './env.js';

const env = parseEnv(process.env);
const app = await buildApp(env);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
```

**Step 2: Verify manually**

Run: `pnpm --filter @signal/api dev` (leave running), then in another shell:
```bash
curl -s localhost:3000/health
```
Expected: `{"status":"ok","version":"0.1.0"}`. Then Ctrl-C the dev server — expect a clean "shutting down" log, no hang.

**Step 3: Verify fail-fast env behavior**

Run: `PORT=banana pnpm --filter @signal/api dev`
Expected: exits immediately with `Invalid environment configuration — PORT: ...` (not a stack-trace soup).

**Step 4: Commit**

```bash
git add apps/api/src/server.ts
git commit -m "feat(api): server entry with graceful shutdown and fail-fast env"
```

---

### Task 9: Local Postgres via docker-compose

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

**Step 1: Create `docker-compose.yml`**

```yaml
services:
  postgres:
    image: postgres:17-alpine
    container_name: signal-postgres
    environment:
      POSTGRES_USER: signal
      POSTGRES_PASSWORD: signal_local_dev
      POSTGRES_DB: signal
    ports:
      - "5433:5432"
    volumes:
      - signal_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U signal -d signal"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  signal_pgdata:
```

**Step 2: Create `.env.example`**

```bash
# Copy to .env for local development. Never commit .env.
NODE_ENV=development
PORT=3000
LOG_LEVEL=info

# Local Postgres (docker compose up -d). Wired into the API in Milestone 1.
DATABASE_URL=postgresql://signal:signal_local_dev@localhost:5433/signal
```

**Step 3: Verify Postgres comes up healthy**

Run:
```bash
docker compose up -d
docker compose ps
```
Expected: `signal-postgres` shows `healthy` (wait a few seconds). Then:
```bash
docker compose exec postgres psql -U signal -d signal -c "select 1;"
```
Expected: returns one row.

**Step 4: Verify tests still pass with Docker DOWN (decision D7)**

Run: `docker compose down && pnpm test`
Expected: all green — Milestone 0 has no DB dependency.

**Step 5: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "chore: local postgres via docker-compose on port 5433"
```

---

### Task 10: GitHub Actions CI

**Files:**
- Create: `.github/workflows/ci.yml`

**Step 1: Create the workflow**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
```

**Step 2: Verify the same pipeline locally**

Run: `pnpm verify`
Expected: typecheck + lint + test all green (this is exactly what CI runs).

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: typecheck, lint, and test on every push and PR"
```

**Note (D11):** activating CI requires the user to create the GitHub repo and push — flag this at milestone completion, don't block on it.

---

### Task 11: README quickstart + fresh-clone proof

**Files:**
- Modify: `README.md` (add a Development section; keep existing content)

**Step 1: Add a Development section to `README.md`**

```markdown
## Development

**Prerequisites:** Node 22+ (`nvm use`), pnpm 10 (`corepack enable`), Docker.

```bash
pnpm install          # install all workspace deps
docker compose up -d  # local Postgres on :5433
cp .env.example .env  # local config
pnpm --filter @signal/api dev   # API on :3000
pnpm verify           # typecheck + lint + tests (what CI runs)
```

**Layout:** `apps/api` (Fastify backend) · `packages/contracts` (shared Zod API schemas) ·
`apps/console` (React SPA, from Milestone 2) · `sdk-android/` (Kotlin SDK, from Milestone 3) ·
`docs/` (spec, architecture, plans) · `design/` (design system, tokens, logo).
```

**Step 2: The fresh-clone proof (milestone exit test)**

Run:
```bash
git clone /Users/ashishsingh/Documents/Claude/Projects/BeatRoute/Signal /tmp/signal-clone-test
cd /tmp/signal-clone-test
pnpm install
pnpm verify
```
Expected: everything green on the clone. Then clean up: `rm -rf /tmp/signal-clone-test`.

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: development quickstart"
```

---

## Milestone Exit Checklist

- [ ] `git log` shows small, single-purpose commits
- [ ] `pnpm verify` green from a **fresh clone** (Task 11 Step 2)
- [ ] `curl localhost:3000/health` returns contract-valid JSON
- [ ] Dev server shuts down cleanly on Ctrl-C
- [ ] Invalid env (`PORT=banana`) fails fast with a readable message
- [ ] `docker compose up -d` yields a healthy Postgres on :5433; tests pass with Docker down
- [ ] `.env` is gitignored; `.env.example` is committed; no secrets anywhere in history
- [ ] CI workflow committed (activation pending user's GitHub push — flag it)

**Next:** Milestone 1 plan (contracts for §8, Drizzle schema, the three endpoints).
