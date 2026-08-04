// apps/api/src/scripts/create-account.ts
// Operational CLI to bootstrap a new account + its first admin user + a default
// publishable key, all in one transaction (B1-D2). Reads --email/--name/
// --password/--account from argv (flags after `--` when run via pnpm) or falls
// back to ADMIN_EMAIL/ADMIN_NAME/ADMIN_PASSWORD/ACCOUNT_NAME env vars.
// Run: pnpm --filter @signal/api create-account -- --email x --name y --password z --account "Acme"
import { z } from 'zod';
import { AccountsService } from '../accounts/service.js';
import { createDb } from '../db/client.js';
import { parseEnv } from '../env.js';

const MIN_PASSWORD_LENGTH = 8;

const inputSchema = z.object({
  email: z.email('must be a valid email address'),
  name: z.string().trim().min(1, 'is required'),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`),
  account: z.string().trim().min(1, 'is required'),
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
  console.error(`create-account: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const raw = {
    email: args.email ?? process.env.ADMIN_EMAIL,
    name: args.name ?? process.env.ADMIN_NAME,
    password: args.password ?? process.env.ADMIN_PASSWORD,
    account: args.account ?? process.env.ACCOUNT_NAME,
  };

  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'input'} ${issue.message}`)
      .join('; ');
    fail(details);
  }

  const env = parseEnv(process.env);
  const { db, close } = createDb(env.DATABASE_URL);
  const accounts = new AccountsService(db);

  try {
    const result = await accounts.signup(
      {
        email: parsed.data.email,
        password: parsed.data.password,
        name: parsed.data.name,
        accountName: parsed.data.account,
      },
      'live',
    );
    console.log(`Account created: ${result.account.name} (${result.account.id})`);
    console.log(`Admin user:      ${result.user.email} (role: ${result.user.role})`);
    console.log(`Publishable key: ${result.publishableKey}`);
  } finally {
    await close();
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error('create-account failed:', error);
    process.exit(1);
  },
);
