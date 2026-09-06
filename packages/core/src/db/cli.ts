import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { createPostgresDb } from './client';
import { migrate, reset } from './migrate';

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
  loadEnv();
  const command = process.argv[2];
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error('DATABASE_URL is required.');
  const db = await createPostgresDb(url);
  try {
    if (command === 'migrate') {
      await migrate(db);
      process.stdout.write('Schema applied and stocks seeded.\n');
    } else if (command === 'reset') {
      if (process.env.CONFIRM_RESET !== 'yes') {
        throw new Error('Refusing to drop the database without CONFIRM_RESET=yes.');
      }
      await reset(db);
      process.stdout.write('Database reset and schema applied.\n');
    } else {
      throw new Error('Usage: cli.ts <migrate|reset>');
    }
  } finally {
    await db.close();
  }
}

await main();
