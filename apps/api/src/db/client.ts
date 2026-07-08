import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export function createDb(databaseUrl: string) {
  const sql = postgres(databaseUrl, { max: 10 });
  return { db: drizzle(sql, { schema }), close: () => sql.end() };
}

export type Db = ReturnType<typeof createDb>['db'];
