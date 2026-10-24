'use strict';

const { Pool, types } = require('pg');
const { config } = require('./config');

// Return DATE columns as plain 'YYYY-MM-DD' strings instead of JS Dates
// (JS Dates would be shifted into the server's local timezone).
types.setTypeParser(1082, (value) => value);

let pool;

function getPool() {
  if (!pool) {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is not set');
    const needsSsl = /sslmode=require/.test(config.databaseUrl);
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      max: 5,
    });
    pool.on('error', (err) => console.error('Postgres pool error', err));
  }
  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

async function withClient(fn) {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function withTransaction(fn) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function close() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = { getPool, query, withClient, withTransaction, close };
