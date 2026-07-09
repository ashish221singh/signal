// apps/api/src/scripts/create-admin.ts
// Operational CLI to seed/refresh a console admin. Upserts into console_users by
// email: on conflict it updates passwordHash + name only (never demotes/changes
// role). Reads --email/--name/--password from argv (flags after `--` when run via
// pnpm) or falls back to ADMIN_EMAIL/ADMIN_NAME/ADMIN_PASSWORD env vars.
// Run with: pnpm --filter @signal/api create-admin -- --email x --name y --password z
import { z } from 'zod';
import { hashPassword } from '../auth/password.js';
import { createDb } from '../db/client.js';
import * as schema from '../db/schema.js';
import { parseEnv } from '../env.js';

const MIN_PASSWORD_LENGTH = 10;

const inputSchema = z.object({
  email: z.email('must be a valid email address'),
  name: z.string().trim().min(1, 'is required'),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`),
});

/** Parse `--flag value` pairs from argv; unknown flags are ignored. */
function parseArgs(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token?.startsWith('--')) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) {
        out[key] = value;
        i += 1;
      }
    }
  }
  return out;
}

function fail(message: string): never {
  console.error(`create-admin: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const raw = {
    email: args.email ?? process.env.ADMIN_EMAIL,
    name: args.name ?? process.env.ADMIN_NAME,
    password: args.password ?? process.env.ADMIN_PASSWORD,
  };

  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`)
      .join('; ');
    fail(details);
  }

  const { email, name, password } = parsed.data;
  const passwordHash = await hashPassword(password);

  const env = parseEnv(process.env);
  const { db, close } = createDb(env.DATABASE_URL);

  try {
    const [row] = await db
      .insert(schema.consoleUsers)
      .values({ email, name, passwordHash })
      .onConflictDoUpdate({
        target: schema.consoleUsers.email,
        // Refresh credentials/name only; never overwrite role on re-run.
        set: { passwordHash, name },
      })
      .returning({ email: schema.consoleUsers.email, role: schema.consoleUsers.role });

    console.log(`Admin upserted: ${row?.email} (role: ${row?.role})`);
  } finally {
    await close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('create-admin failed:', error);
    process.exit(1);
  },
);
