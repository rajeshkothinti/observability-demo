/**
 * Frontend service: serves UI, auth (login/signup/profile), and proxies /api/* to inventory and order services.
 * Uses Postgres for users when DATABASE_URL is set (kind-local); otherwise in-memory.
 */
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const INVENTORY_URL = process.env.INVENTORY_SERVICE_URL || 'http://localhost:8080';
const ORDER_URL = process.env.ORDER_SERVICE_URL || 'http://localhost:8000';
const PORT = parseInt(process.env.PORT || '3001', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'demo-secret-change-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';

const app = express();
app.use(express.json());

// ─── In-memory user store (fallback when DATABASE_URL is not set) ───
const users = new Map(); // id -> { id, email, passwordHash, name, createdAt }

function sanitizeUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.getPool() ? await db.findUserById(payload.sub) : users.get(payload.sub);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── Auth API ───
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'email, password, and name are required' });
  }
  const emailNorm = String(email).trim().toLowerCase();
  const existing = db.getPool() ? await db.findUserByEmail(emailNorm) : [...users.values()].find((u) => u.email.toLowerCase() === emailNorm);
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const id = 'user-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const passwordHash = await bcrypt.hash(String(password), 10);
  const user = { id, email: emailNorm, passwordHash, name: String(name).trim(), createdAt: new Date().toISOString() };
  if (db.getPool()) await db.createUser(user);
  else users.set(id, user);
  const token = jwt.sign({ sub: id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.status(201).json({ user: sanitizeUser(user), token });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const emailNorm = String(email).trim().toLowerCase();
  const user = db.getPool() ? await db.findUserByEmail(emailNorm) : [...users.values()].find((u) => u.email.toLowerCase() === emailNorm);
  if (!user || !(await bcrypt.compare(String(password), user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
  res.json({ user: sanitizeUser(user), token });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json(sanitizeUser(req.user));
});

app.put('/api/auth/profile', authMiddleware, async (req, res) => {
  const { name, email } = req.body || {};
  const user = req.user;
  if (name !== undefined) user.name = String(name).trim();
  if (email !== undefined) {
    const emailNorm = String(email).trim().toLowerCase();
    const existing = db.getPool() ? await db.findUserByEmail(emailNorm) : [...users.values()].find((u) => u.id !== user.id && u.email.toLowerCase() === emailNorm);
    if (existing && existing.id !== user.id) return res.status(409).json({ error: 'Email already in use' });
    user.email = emailNorm;
  }
  user.updatedAt = new Date().toISOString();
  if (db.getPool()) await db.updateUser(user);
  else users.set(user.id, user);
  res.json(sanitizeUser(user));
});

// Proxy: forward to inventory service (products)
app.use('/api/products', async (req, res) => {
  const pathPart = req.path === '/' ? '' : req.path;
  const queryPart = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const target = `${INVENTORY_URL}/api/v1/products${pathPart}${queryPart}`;
  try {
    const r = await fetch(target, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body: req.method !== 'GET' && req.method !== 'HEAD' ? await streamBody(req) : undefined,
    });
    const text = await r.text();
    if (!r.ok) {
      try {
        const json = JSON.parse(text);
        return res.status(r.status).json(json);
      } catch (_) {
        return res.status(r.status).json({ error: 'Failed to load products', detail: text || r.statusText });
      }
    }
    res.status(r.status).set(Object.fromEntries(r.headers.entries())).send(text);
  } catch (e) {
    res.status(502).json({ error: 'Inventory service unavailable', detail: e.message });
  }
});

// Proxy: forward to order service (orders)
app.use('/api/orders', async (req, res) => {
  const pathPart = req.path === '/' ? '' : req.path;
  const queryPart = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const target = `${ORDER_URL}/api/v1/orders${pathPart}${queryPart}`;
  try {
    const body = req.method !== 'GET' && req.method !== 'HEAD' ? await streamBody(req) : undefined;
    const r = await fetch(target, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const text = await r.text();
    if (!r.ok) {
      try {
        const json = JSON.parse(text);
        return res.status(r.status).json(json);
      } catch (_) {
        return res.status(r.status).json({ error: 'Order service error', detail: text || r.statusText });
      }
    }
    res.status(r.status).set(Object.fromEntries(r.headers.entries())).send(text);
  } catch (e) {
    res.status(502).json({ error: 'Order service unavailable', detail: e.message });
  }
});

function streamBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Root and home: redirect to login so users land on auth page first
app.get('/', (req, res) => {
  res.redirect(302, '/login.html');
});
app.get('/index.html', (req, res) => {
  res.redirect(302, '/login.html');
});

// Static files (UI)
app.use(express.static(path.join(__dirname, 'public')));

// Health
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'frontend-service', version: '1.0.0' });
});

async function start() {
  await db.init();
  if (db.getPool()) console.log('Frontend using Postgres for users (DATABASE_URL set)');
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Frontend listening on port ${PORT}; inventory=${INVENTORY_URL} order=${ORDER_URL}`);
  });
}
start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
