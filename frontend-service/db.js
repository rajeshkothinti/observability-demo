/**
 * Postgres user store (kind-local). When DATABASE_URL is set, use this; else in-memory in server.js.
 */
const { Pool } = require('pg');

let pool = null;

async function init() {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  pool = new Pool({ connectionString: url, max: 5 });
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ
      )
    `);
  } finally {
    client.release();
  }
}

async function findUserByEmail(emailNorm) {
  if (!pool) return null;
  const r = await pool.query(
    'SELECT id, email, password_hash, name, created_at, updated_at FROM users WHERE LOWER(email) = $1',
    [emailNorm]
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];
  return rowToUser(row);
}

async function findUserById(id) {
  if (!pool) return null;
  const r = await pool.query(
    'SELECT id, email, password_hash, name, created_at, updated_at FROM users WHERE id = $1',
    [id]
  );
  if (r.rows.length === 0) return null;
  return rowToUser(r.rows[0]);
}

function rowToUser(row) {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    name: row.name,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

async function createUser(user) {
  if (!pool) return;
  await pool.query(
    'INSERT INTO users (id, email, password_hash, name, created_at) VALUES ($1,$2,$3,$4,$5)',
    [user.id, user.email, user.passwordHash, user.name, user.createdAt]
  );
}

async function updateUser(user) {
  if (!pool) return;
  await pool.query(
    'UPDATE users SET name = $2, email = $3, updated_at = $4 WHERE id = $1',
    [user.id, user.name, user.email, user.updatedAt]
  );
}

module.exports = { init, findUserByEmail, findUserById, createUser, updateUser, getPool: () => pool };
