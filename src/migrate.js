'use strict';

// Tiny forward-only migration runner. Applies migrations/*.sql in filename
// order, each inside a transaction, and records them in schema_migrations.
// Usage: npm run migrate

const fs = require('fs');
const path = require('path');
const db = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const LOCK_KEY = 727001; // arbitrary advisory-lock key for migrations

async function migrate({ log = console.log } = {}) {
  await db.withClient(async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          name TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query('SELECT name FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.name));
      const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        log(`Applying migration ${file}`);
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file} failed: ${err.message}`);
        }
      }
      log('Migrations up to date');
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]);
    }
  });
}

if (require.main === module) {
  migrate()
    .then(() => db.close())
    .catch(async (err) => {
      console.error(err);
      await db.close();
      process.exit(1);
    });
}

module.exports = { migrate };
