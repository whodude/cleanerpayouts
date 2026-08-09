// The one place that opens the Postgres connection. Everything else in the app requires this
// module and shares the pool it exports.
//
// This is a thin compatibility shim over `pg`: `db.prepare(sql).get/all/run(...params)` with
// `?` placeholders (auto-converted to Postgres's `$1, $2...`), and `.run()` auto-appends
// `RETURNING *` to INSERT statements that don't already have one, setting `lastInsertRowid`
// from the returned row's `id` column when present.
//
// `ready` resolves once the one-time schema setup is done; src/app.js awaits it on the first
// incoming request (and every request after that resolves instantly, it's a cached Promise).

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set in .env. See .env.example.');
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const txStorage = new AsyncLocalStorage();

function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function isInsert(sql) {
  return /^\s*insert/i.test(sql);
}

async function execute(sql, params) {
  const client = txStorage.getStore();
  const runner = client || pool;
  return runner.query(sql, params);
}

function prepare(sql) {
  const pgSql = convertPlaceholders(sql);
  return {
    async get(...params) {
      const res = await execute(pgSql, params);
      return res.rows[0];
    },
    async all(...params) {
      const res = await execute(pgSql, params);
      return res.rows;
    },
    async run(...params) {
      let finalSql = pgSql;
      if (isInsert(pgSql) && !/returning/i.test(pgSql)) {
        finalSql = `${pgSql} RETURNING *`;
      }
      const res = await execute(finalSql, params);
      const first = res.rows[0];
      return {
        changes: res.rowCount,
        lastInsertRowid: first && first.id !== undefined ? first.id : undefined,
        row: first
      };
    }
  };
}

function transaction(fn) {
  return async (...args) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await txStorage.run(client, () => fn(...args));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };
}

async function setup() {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  await pool.query(schema);
}

const ready = setup();
ready.catch((err) => {
  console.error('[db] startup failed:', err.message);
});

module.exports = { prepare, transaction, pool, ready };
