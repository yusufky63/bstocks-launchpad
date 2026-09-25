import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { createPostgresDb } from './client';
import { migrate } from './migrate';

function loadEnv(): void {
  for (const candidate of ['.env', '../../apps/indexer/.env', '../../apps/web/.env.local']) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) {
      try {
        process.loadEnvFile(path);
      } catch {
        // ignore malformed lines; DATABASE_URL must still be present
      }
    }
  }
}

async function main(): Promise<void> {
  // Migrate is the only command. There is deliberately no reset: DATABASE_URL is the production
  // database on every machine that has one, and a command that drops it is one habit away from
  // being run. Tests use the embedded database. The command is checked before any connection.
  const command = process.argv[2];
  if (command !== 'migrate') throw new Error('Usage: cli.ts migrate');
  loadEnv();
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL is required.');
  const db = await createPostgresDb(url);
  try {
    await migrate(db);
    process.stdout.write('Schema applied and stocks seeded.\n');
  } finally {
    await db.close();
  }
}

await main();
