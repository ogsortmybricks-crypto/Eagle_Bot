const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const { Pool } = require('pg');
const { applyAIAmendments, chatAboutConstitution, getClient } = require('./ai-amendments');
const app = express();
const PORT = 5000;
const WIKI_DIR = path.resolve(__dirname, 'wiki');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=')
    ? undefined
    : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false)
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_config (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      password TEXT NOT NULL,
      salt TEXT,
      token TEXT,
      learner_token TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      studio TEXT,
      position TEXT,
      marks_blue INTEGER DEFAULT 0,
      marks_red INTEGER DEFAULT 0,
      marks_black INTEGER DEFAULT 0,
      strikes INTEGER DEFAULT 0,
      eligible BOOLEAN DEFAULT TRUE,
      join_date TEXT,
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'active',
      email TEXT,
      password_hash TEXT,
      salt TEXT,
      learner_token TEXT
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      detail TEXT,
      date TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invitations (
      id SERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      sent_at TEXT,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS election (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      phase TEXT DEFAULT 'setup',
      studio TEXT,
      candidates JSONB DEFAULT '[]',
      votes JSONB DEFAULT '{}',
      opened_at TEXT,
      closed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS election_history (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      studio TEXT,
      candidates JSONB,
      tally JSONB,
      vote_count INTEGER
    );
    CREATE TABLE IF NOT EXISTS amendments (
      id SERIAL PRIMARY KEY,
      page TEXT NOT NULL,
      note TEXT NOT NULL,
      applied BOOLEAN DEFAULT TRUE,
      created_at TEXT NOT NULL
    );
    INSERT INTO election (id, phase, studio, candidates, votes)
    VALUES (1, 'setup', NULL, '[]', '{}')
    ON CONFLICT (id) DO NOTHING;
  `);
  const adminPw = process.env.ADMIN_PASSWORD || 'changeme';
  await pool.query(
    `INSERT INTO admin_config (id, password, salt, token, learner_token)
     VALUES (1, $1, NULL, NULL, NULL)
     ON CONFLICT (id) DO NOTHING`,
    [adminPw]
  );
  console.log('Database tables initialized');
}

function getMailer() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

function hashPasswordLegacy(password, salt) {
  return crypto.createHash('sha256').update(password + salt).digest('hex');
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, storedHash) {
  const scryptHash = hashPassword(password, salt);
  if (scryptHash === storedHash) return true;
  const legacyHash = hashPasswordLegacy(password, salt);
  return legacyHash === storedHash;
}

function needsRehash(storedHash) {
  return storedHash.length === 64;
}

function generateToken() {
  return crypto.randomBytes(24).toString('hex');
}

function parsePositions(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(p => typeof p === 'string' && p.trim());
  } catch (e) { /* not JSON */ }
  return [raw];
}

function rowToUser(r) {
  return {
    id: r.id,
    name: r.name,
    studio: r.studio,
    positions: parsePositions(r.position),
    marks: { blue: r.marks_blue, red: r.marks_red, black: r.marks_black },
    strikes: r.strikes,
    eligible: r.eligible,
    joinDate: r.join_date,
    notes: r.notes,
    status: r.status,
    email: r.email,
    passwordHash: r.password_hash,
    salt: r.salt,
    learnerToken: r.learner_token
  };
}

function safeUser(u) {
  return {
    id: u.id,
    name: u.name,
    studio: u.studio,
    positions: u.positions,
    marks: u.marks,
    strikes: u.strikes,
    eligible: u.eligible,
    joinDate: u.joinDate,
    status: u.status
  };
}

async function getAdmin() {
  const res = await pool.query('SELECT * FROM admin_config WHERE id = 1');
  if (res.rows.length === 0) {
    const pw = process.env.ADMIN_PASSWORD || 'changeme';
    await pool.query('INSERT INTO admin_config (id, password, salt, token, learner_token) VALUES (1, $1, NULL, NULL, NULL)', [pw]);
    return { password: pw, salt: null, token: null, learnerToken: null };
  }
  const r = res.rows[0];
  return { password: r.password, salt: r.salt, token: r.token, learnerToken: r.learner_token };
}

async function updateAdmin(fields) {
  const sets = [];
  const vals = [];
  let i = 1;
  for (const [k, v] of Object.entries(fields)) {
    const col = k === 'learnerToken' ? 'learner_token' : k;
    sets.push(`${col} = $${i}`);
    vals.push(v);
    i++;
  }
  await pool.query(`UPDATE admin_config SET ${sets.join(', ')} WHERE id = 1`, vals);
}

async function verifyAdmin(req) {
  const token = req.headers['x-admin-token'];
  if (!token) return false;
  const admin = await getAdmin();
  return admin.token && token === admin.token;
}

async function verifyLearner(req) {
  const token = req.headers['x-learner-token'];
  if (!token) return null;
  const admin = await getAdmin();
  if (admin.learnerToken && token === admin.learnerToken) {
    return { id: 'admin', name: 'Admin', studio: null, role: 'admin', positions: [] };
  }
  const res = await pool.query('SELECT * FROM users WHERE learner_token = $1', [token]);
  if (res.rows.length === 0) return null;
  return rowToUser(res.rows[0]);
}

async function logActivity(action, detail) {
  await pool.query('INSERT INTO activity_log (action, detail, date) VALUES ($1, $2, $3)', [action, detail, new Date().toISOString()]);
  await pool.query(`DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT 100)`);
}

app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.static(path.join(__dirname, 'wiki')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-learner-token');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ================================================================
// AMENDMENT SYSTEM
// ================================================================

const relatedRulesMap = {
  'striker requirements': ['es-strikes.html', 'ms-strikes.html', 'positions.html'],
  'friendly reminder': ['es-strikes.html', 'es-roes.html', 'positions.html'],
  'mark threshold': ['positions.html', 'ms-strikes.html', 'es-strikes.html'],
  'apology letter': ['ms-strikes.html', 'positions.html'],
  'position ban': ['positions.html', 'ms-strikes.html'],
  'strike champion': ['positions.html', 'ms-rules.html', 'es-roes.html'],
  'blue mark': ['es-strikes.html', 'positions.html'],
  'red mark': ['es-strikes.html', 'positions.html'],
  'black mark': ['ms-strikes.html', 'positions.html'],
  'guardrail strike': ['es-strikes.html', 'ms-strikes.html', 'shared-roes.html'],
  'guardrail': ['es-strikes.html', 'ms-strikes.html', 'shared-roes.html'],
  'fun friday': ['es-strikes.html', 'shared-roes.html'],
  'core skills': ['es-roes.html', 'ms-rules.html'],
  'rules of engagement': ['es-roes.html', 'shared-roes.html'],
  'eligibility': ['positions.html', 'es-strikes.html', 'ms-strikes.html'],
  'eligible': ['positions.html', 'es-strikes.html', 'ms-strikes.html'],
  'silent lunch': ['ms-strikes.html', 'ms-rules.html'],
  'self-governance': ['ms-rules.html', 'positions.html'],
  'self governance': ['ms-rules.html', 'positions.html'],
  'lgg': ['ms-strikes.html', 'ms-rules.html'],
  'low grade guardrail': ['ms-strikes.html', 'ms-rules.html'],
};

function findRelatedPages(amendment, targetPage) {
  const lowerAmend = amendment.toLowerCase();
  const related = [targetPage];
  Object.entries(relatedRulesMap).forEach(([topic, pages]) => {
    if (lowerAmend.includes(topic)) {
      pages.forEach(p => {
        if (p !== targetPage && !related.includes(p)) related.push(p);
      });
    }
  });
  return related;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function applyAmendmentToPage(filePath, amendment) {
  let html = fs.readFileSync(filePath, 'utf-8');
  const dom = new JSDOM(html);
  const mainContent = dom.window.document.querySelector('.main-content');

  if (!mainContent) return { success: false, reason: 'No main content' };

  let modified = false;

  const requiresMatch = amendment.match(/now require[s]? (\d+|many|several|few) ([^]*?) instead of (\d+|many|several|few)/i);
  if (requiresMatch) {
    const newValStr = requiresMatch[1];
    const item = requiresMatch[2].trim();
    const oldValStr = requiresMatch[3];
    mainContent.querySelectorAll('*').forEach(el => {
      const text = el.textContent;
      if (text.includes(oldValStr) && text.toLowerCase().includes(item.toLowerCase())) {
        const oldRegex = new RegExp(`\\b${escapeRegex(oldValStr)}\\b`, 'gi');
        el.innerHTML = el.innerHTML.replace(oldRegex, escapeHtml(newValStr));
        modified = true;
      }
    });
  }

  const isNowMatch = amendment.match(/([\w\s]+) is now (?:a |an )?([\w\s]+)/i);
  if (isNowMatch && !modified) {
    const before = isNowMatch[1].trim();
    const after = isNowMatch[2].trim();
    mainContent.querySelectorAll('p, li, td, h3, h4').forEach(el => {
      if (el.textContent.toLowerCase().includes(before.toLowerCase())) {
        const regex = new RegExp(`\\b${escapeRegex(before)}\\b`, 'gi');
        el.innerHTML = el.innerHTML.replace(regex, escapeHtml(after));
        modified = true;
      }
    });
  }

  if (!modified) {
    const container = mainContent.querySelector('.rule-card') ||
                      mainContent.querySelector('.section-grid') ||
                      mainContent.querySelector('h2') ||
                      mainContent.querySelector('h1');
    if (container) {
      const para = dom.window.document.createElement('p');
      para.style.cssText = 'margin-top: 12px; font-size: 0.95rem; color: #333;';
      para.textContent = amendment.replace(/^[^:]*:\s*/, '');
      if (!container.classList.contains('rule-card')) {
        container.parentNode.insertBefore(para, container.nextSibling);
      } else {
        container.appendChild(para);
      }
      modified = true;
    }
  }

  if (modified) {
    fs.writeFileSync(filePath, dom.serialize(), 'utf-8');
    return { success: true };
  }

  return { success: false, reason: 'Could not parse amendment' };
}

app.post('/api/apply-amendments', async (req, res) => {
  try {
    const { amendments } = req.body;
    if (!amendments || typeof amendments !== 'object') {
      return res.status(400).json({ error: 'Invalid amendments data' });
    }

    const AMENDMENTS_FILE = path.join(__dirname, 'amendments-log.json');
    const results = {};
    const pagesModified = new Set();
    const now = new Date().toISOString();
    const fileEntries = [];

    for (const [page, notes] of Object.entries(amendments)) {
      if (page === 'uncategorized' || !Array.isArray(notes) || notes.length === 0) continue;

      const filePath = path.resolve(WIKI_DIR, page);
      if (!filePath.startsWith(WIKI_DIR + path.sep) && filePath !== WIKI_DIR) {
        results[page] = { success: false, error: 'Invalid page path' };
        continue;
      }
      if (!fs.existsSync(filePath)) {
        results[page] = { success: false, error: 'File not found' };
        continue;
      }

      try {
        let anySuccess = false;
        for (const note of notes) {
          const r = applyAmendmentToPage(filePath, note);
          const applied = r.success;
          if (applied) anySuccess = true;
          await pool.query(
            'INSERT INTO amendments (page, note, applied, created_at) VALUES ($1, $2, $3, $4)',
            [page, note, applied, now]
          );
          fileEntries.push({ page, note, applied, createdAt: now });
        }
        if (anySuccess) pagesModified.add(page);
        results[page] = { success: anySuccess, count: notes.length };
      } catch (err) {
        results[page] = { success: false, error: err.message };
      }
    }

    const allNotes = Object.values(amendments).flat().filter(n => n !== 'uncategorized');
    for (const amendment of allNotes) {
      for (const relPage of findRelatedPages(amendment, '')) {
        if (!relPage || pagesModified.has(relPage)) continue;
        const relPath = path.resolve(WIKI_DIR, relPage);
        if (!relPath.startsWith(WIKI_DIR + path.sep) && relPath !== WIKI_DIR) continue;
        if (!fs.existsSync(relPath)) continue;
        try {
          const r = applyAmendmentToPage(relPath, amendment);
          if (r.success) {
            pagesModified.add(relPage);
            results[relPage] = { success: true, related: true };
            await pool.query(
              'INSERT INTO amendments (page, note, applied, created_at) VALUES ($1, $2, $3, $4)',
              [relPage, amendment, true, now]
            );
            fileEntries.push({ page: relPage, note: amendment, applied: true, createdAt: now });
          }
        } catch (e) { /* skip */ }
      }
    }

    const anySuccess = Object.values(results).some(r => r && r.success);
    if (!anySuccess) {
      return res.status(500).json({ error: 'No amendments could be applied', results });
    }

    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(AMENDMENTS_FILE, 'utf-8')); } catch (e) { /* file doesn't exist yet */ }
    fs.writeFileSync(AMENDMENTS_FILE, JSON.stringify([...existing, ...fileEntries], null, 2), 'utf-8');

    await logActivity('Amendments applied', `Updated pages: ${[...pagesModified].join(', ')}`);
    res.json({ success: true, message: 'Amendments applied to wiki', pagesUpdated: [...pagesModified], results });
  } catch (error) {
    console.error('Error applying amendments:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/amendments', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const result = await pool.query('SELECT id, page, note, applied, created_at as "createdAt" FROM amendments ORDER BY id DESC LIMIT 200');
    res.json({ amendments: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/ai/apply-amendments', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    if (!getClient()) return res.status(500).json({ error: 'Anthropic API key not configured' });
    const { notes } = req.body;
    if (!Array.isArray(notes) || notes.length === 0) {
      return res.status(400).json({ error: 'Provide an array of amendment notes' });
    }
    const result = await applyAIAmendments(notes, pool);
    if (result.pagesModified.length > 0) {
      await logActivity('AI Amendments applied', `Updated pages: ${result.pagesModified.join(', ')}`);
    }
    res.json(result);
  } catch (err) {
    console.error('AI amendment error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/chat', async (req, res) => {
  try {
    if (!getClient()) return res.status(500).json({ error: 'Anthropic API key not configured' });
    const learner = await verifyLearner(req);
    if (!learner) return res.status(403).json({ error: 'Sign in to use the assistant' });
    const { question, history } = req.body;
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'Provide a question' });
    }
    const answer = await chatAboutConstitution(question, history || []);
    res.json({ answer });
  } catch (err) {
    console.error('AI chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// ADMIN AUTH
// ================================================================

app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;
    const admin = await getAdmin();
    let match = false;
    if (admin.salt) {
      match = verifyPassword(password, admin.salt, admin.password);
    } else {
      match = (password === admin.password);
      if (match) {
        const salt = crypto.randomBytes(16).toString('hex');
        await updateAdmin({ password: hashPassword(password, salt), salt });
      }
    }
    if (!match) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    const token = generateToken();
    await updateAdmin({ token });
    await logActivity('Admin login', 'Admin logged in');
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/logout', async (req, res) => {
  try {
    if (await verifyAdmin(req)) {
      await logActivity('Admin logout', 'Admin logged out');
      await updateAdmin({ token: null });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/password', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    await updateAdmin({ password: hashPassword(newPassword, salt), salt, token: null });
    await logActivity('Password changed', 'Admin changed the password');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ================================================================
// USER DATABASE ROUTES
// ================================================================

app.get('/api/users', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const result = await pool.query('SELECT * FROM users ORDER BY name');
    res.json({ users: result.rows.map(rowToUser) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/public', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users ORDER BY name');
    res.json({ users: result.rows.map(r => safeUser(rowToUser(r))) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users/stats', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users');
    const users = result.rows;
    res.json({
      total: users.length,
      es: users.filter(u => u.studio === 'ES').length,
      ms: users.filter(u => u.studio === 'MS').length,
      noStudio: users.filter(u => !u.studio).length,
      withPosition: users.filter(u => parsePositions(u.position).length > 0).length,
      eligible: users.filter(u => u.eligible).length
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/activity', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const result = await pool.query('SELECT action, detail, date FROM activity_log ORDER BY id DESC LIMIT 100');
    res.json({ log: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const { name, studio, positions, notes } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    const id = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const joinDate = new Date().toISOString().split('T')[0];
    const posVal = Array.isArray(positions) && positions.length > 0 ? JSON.stringify(positions) : null;

    await pool.query(
      `INSERT INTO users (id, name, studio, position, marks_blue, marks_red, marks_black, strikes, eligible, join_date, notes, status)
       VALUES ($1, $2, $3, $4, 0, 0, 0, 0, true, $5, $6, 'active')`,
      [id, name.trim(), studio || null, posVal, joinDate, notes || '']
    );

    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    const user = rowToUser(result.rows[0]);

    await logActivity('User added', `Added ${user.name}${user.studio ? ' (' + user.studio + ')' : ''}`);
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/users/:id', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const user = rowToUser(result.rows[0]);
    const before = user.name;

    const allowed = ['name', 'studio', 'positions', 'marks', 'strikes', 'notes', 'status'];
    const updates = Object.create(null);
    for (const k of allowed) {
      if (Object.prototype.hasOwnProperty.call(req.body, k)) {
        updates[k] = req.body[k];
      }
    }

    const sets = [];
    const vals = [];
    let i = 1;

    if (updates.name !== undefined) { sets.push(`name = $${i++}`); vals.push(updates.name); }
    if (updates.studio !== undefined) { sets.push(`studio = $${i++}`); vals.push(updates.studio); }
    if (updates.positions !== undefined) {
      const posVal = Array.isArray(updates.positions) && updates.positions.length > 0 ? JSON.stringify(updates.positions) : null;
      sets.push(`position = $${i++}`); vals.push(posVal);
    }
    if (updates.notes !== undefined) { sets.push(`notes = $${i++}`); vals.push(updates.notes); }
    if (updates.status !== undefined) { sets.push(`status = $${i++}`); vals.push(updates.status); }
    if (updates.strikes !== undefined) { sets.push(`strikes = $${i++}`); vals.push(updates.strikes); }
    if (updates.marks !== undefined) {
      sets.push(`marks_blue = $${i++}`); vals.push(updates.marks.blue || 0);
      sets.push(`marks_red = $${i++}`); vals.push(updates.marks.red || 0);
      sets.push(`marks_black = $${i++}`); vals.push(updates.marks.black || 0);
    }

    if (sets.length > 0) {
      vals.push(req.params.id);
      await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    }

    const updated = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    const u = rowToUser(updated.rows[0]);

    let eligible;
    if (u.studio === 'ES') {
      eligible = (u.marks.blue < 10) && (u.marks.red < 10);
    } else if (u.studio === 'MS') {
      eligible = (u.marks.black < 2) && (u.strikes < 2);
    } else {
      eligible = true;
    }
    await pool.query('UPDATE users SET eligible = $1 WHERE id = $2', [eligible, req.params.id]);
    u.eligible = eligible;

    await logActivity('User updated', `Updated ${before}`);
    res.json({ success: true, user: u });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/users/:id/studio', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const { studio } = req.body;
    if (!['ES', 'MS'].includes(studio)) return res.status(400).json({ error: 'Studio must be ES or MS' });

    const u = rowToUser(result.rows[0]);
    let eligible;
    if (studio === 'ES') eligible = (u.marks.blue < 10) && (u.marks.red < 10);
    else eligible = (u.marks.black < 2) && (u.strikes < 2);

    await pool.query('UPDATE users SET studio = $1, eligible = $2 WHERE id = $3', [studio, eligible, req.params.id]);
    await logActivity('Studio set', `${u.name} set studio to ${studio}`);

    const updated = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true, user: rowToUser(updated.rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const result = await pool.query('SELECT name FROM users WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const name = result.rows[0].name;
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    await logActivity('User removed', `Removed ${name}`);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/users/:id/password', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const salt = crypto.randomBytes(16).toString('hex');
    await pool.query('UPDATE users SET password_hash = $1, salt = $2, status = $3 WHERE id = $4',
      [hashPassword(password, salt), salt, 'active', req.params.id]);
    await logActivity('Password set', `Admin set password for ${result.rows[0].name}`);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ================================================================
// INVITATIONS
// ================================================================

const ALLOWED_DOMAIN = '@triumphactonacademy.com';

app.get('/api/invitations', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const result = await pool.query('SELECT token, email, user_id as "userId", expires_at as "expiresAt", used, sent_at as "sentAt", used_at as "usedAt" FROM invitations ORDER BY id DESC');
    res.json({ invitations: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/invitations', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });

    const { email, name, studio } = req.body;
    if (!email || !name) return res.status(400).json({ error: 'Email and name are required' });
    if (!email.toLowerCase().endsWith(ALLOWED_DOMAIN)) {
      return res.status(400).json({ error: `Email must end with ${ALLOWED_DOMAIN}` });
    }

    const existingUser = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }
    const existingInv = await pool.query('SELECT id FROM invitations WHERE LOWER(email) = LOWER($1) AND used = false', [email]);
    if (existingInv.rows.length > 0) {
      return res.status(400).json({ error: 'A pending invitation already exists for this email' });
    }

    const userId = 'u_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const joinDate = new Date().toISOString().split('T')[0];

    await pool.query(
      `INSERT INTO users (id, name, studio, position, marks_blue, marks_red, marks_black, strikes, eligible, join_date, notes, status, email)
       VALUES ($1, $2, $3, NULL, 0, 0, 0, 0, true, $4, '', 'pending', $5)`,
      [userId, name.trim(), studio || null, joinDate, email.toLowerCase()]
    );

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const sentAt = new Date().toISOString();

    await pool.query(
      'INSERT INTO invitations (token, email, user_id, expires_at, used, sent_at) VALUES ($1, $2, $3, $4, false, $5)',
      [token, email.toLowerCase(), userId, expiresAt, sentAt]
    );

    await logActivity('Invitation sent', `Invited ${name} (${email})`);

    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const inviteLink = `${baseUrl}/invite.html?token=${token}`;

    try {
      const mailer = getMailer();
      await mailer.sendMail({
        from: `"Triumph Academy" <${process.env.GMAIL_USER}>`,
        to: email,
        subject: 'You\'ve been invited to Triumph Academy',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">
            <h2 style="color:#1d4ed8;">Welcome to Triumph Academy, ${escapeHtml(name)}!</h2>
            <p>You've been added to the Triumph Academy member system. Click the button below to create your account.</p>
            <p style="margin:28px 0;">
              <a href="${inviteLink}" style="background:#1d4ed8;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">
                Create My Account
              </a>
            </p>
            <p style="color:#6b7280;font-size:0.85rem;">This link expires in 24 hours. If you didn't expect this email, you can ignore it.</p>
          </div>
        `
      });
      res.json({ success: true, message: `Invitation sent to ${email}`, inviteLink });
    } catch (err) {
      console.error('Email send error:', err);
      res.json({ success: true, emailFailed: true, inviteLink, warning: 'Email could not be sent — share this link manually.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/invitations/:token', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM invitations WHERE token = $1', [req.params.token]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invalid invitation link' });
    const inv = result.rows[0];
    if (inv.used) return res.status(400).json({ error: 'This invitation has already been used' });
    if (new Date(inv.expires_at) < new Date()) return res.status(400).json({ error: 'This invitation link has expired' });

    const userRes = await pool.query('SELECT name FROM users WHERE id = $1', [inv.user_id]);
    res.json({ valid: true, email: inv.email, name: userRes.rows.length > 0 ? userRes.rows[0].name : '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/invitations/:token/accept', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM invitations WHERE token = $1', [req.params.token]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Invalid invitation link' });

    const inv = result.rows[0];
    if (inv.used) return res.status(400).json({ error: 'This invitation has already been used' });
    if (new Date(inv.expires_at) < new Date()) return res.status(400).json({ error: 'This invitation link has expired' });

    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [inv.user_id]);
    if (userRes.rows.length === 0) return res.status(500).json({ error: 'Account not found' });

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);
    const learnerToken = generateToken();

    await pool.query(
      'UPDATE users SET password_hash = $1, salt = $2, learner_token = $3, status = $4 WHERE id = $5',
      [passwordHash, salt, learnerToken, 'active', inv.user_id]
    );
    await pool.query(
      'UPDATE invitations SET used = true, used_at = $1 WHERE token = $2',
      [new Date().toISOString(), req.params.token]
    );

    const updatedUser = await pool.query('SELECT * FROM users WHERE id = $1', [inv.user_id]);
    const u = rowToUser(updatedUser.rows[0]);
    await logActivity('Account created', `${u.name} accepted their invitation`);

    const { passwordHash: _ph, salt: _s, ...su } = u;
    res.json({ success: true, learnerToken, user: su });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ================================================================
// LEARNER AUTH
// ================================================================

app.post('/api/learner/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const isAdminLogin = email.trim().toLowerCase() === 'admin';
    if (isAdminLogin) {
      const admin = await getAdmin();
      let adminMatch = false;
      if (admin.salt) {
        adminMatch = verifyPassword(password, admin.salt, admin.password);
      } else {
        adminMatch = (password === admin.password);
        if (adminMatch) {
          const salt = crypto.randomBytes(16).toString('hex');
          await updateAdmin({ password: hashPassword(password, salt), salt });
        }
      }
      if (adminMatch) {
        const learnerToken = generateToken();
        const adminToken = generateToken();
        await updateAdmin({ learnerToken, token: adminToken });
        await logActivity('Admin login', 'Admin logged in via unified portal');
        return res.json({
          success: true,
          learnerToken,
          adminToken,
          user: { id: 'admin', name: 'Admin', studio: null, role: 'admin', positions: [] }
        });
      }
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    let result = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (result.rows.length === 0) {
      result = await pool.query('SELECT * FROM users WHERE LOWER(name) = LOWER($1)', [email]);
    }
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = rowToUser(result.rows[0]);
    if (!user.passwordHash || !user.salt) return res.status(401).json({ error: 'Account not yet activated. Check your invitation email.' });

    if (!verifyPassword(password, user.salt, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (needsRehash(user.passwordHash)) {
      const newSalt = crypto.randomBytes(16).toString('hex');
      await pool.query('UPDATE users SET password_hash = $1, salt = $2 WHERE id = $3',
        [hashPassword(password, newSalt), newSalt, user.id]);
    }

    const learnerToken = generateToken();
    await pool.query('UPDATE users SET learner_token = $1 WHERE id = $2', [learnerToken, user.id]);

    const { passwordHash: _ph, salt: _s, ...su } = user;
    res.json({ success: true, learnerToken, user: { ...su, role: 'learner' } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/learner/logout', async (req, res) => {
  try {
    const token = req.headers['x-learner-token'];

    const admin = await getAdmin();
    if (token && admin.learnerToken && token === admin.learnerToken) {
      await updateAdmin({ learnerToken: null, token: null });
      await logActivity('Admin logout', 'Admin signed out');
      return res.json({ success: true });
    }

    const user = await verifyLearner(req);
    if (user && user.id !== 'admin') {
      await pool.query('UPDATE users SET learner_token = NULL WHERE id = $1', [user.id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/learner/me', async (req, res) => {
  try {
    const user = await verifyLearner(req);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    if (user.id === 'admin') return res.json({ user });
    const { passwordHash: _ph, salt: _s, learnerToken: _lt, ...su } = user;
    res.json({ user: { ...su, role: 'learner' } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ================================================================
// ELECTION (server-side)
// ================================================================

async function getElection() {
  const res = await pool.query('SELECT * FROM election WHERE id = 1');
  if (res.rows.length === 0) {
    await pool.query("INSERT INTO election (id, phase, studio, candidates, votes) VALUES (1, 'setup', NULL, '[]', '{}')");
    return { phase: 'setup', studio: null, candidates: [], votes: {} };
  }
  const r = res.rows[0];
  return { phase: r.phase, studio: r.studio, candidates: r.candidates || [], votes: r.votes || {} };
}

app.get('/api/election', async (req, res) => {
  try {
    const e = await getElection();
    res.json({
      phase: e.phase,
      studio: e.studio,
      candidates: e.candidates,
      voteCount: Object.keys(e.votes).length
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/election/results', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const e = await getElection();

    const tally = {};
    e.candidates.forEach(c => { tally[c] = 0; });
    Object.values(e.votes).forEach(v => {
      if (tally[v] !== undefined) tally[v]++;
      else tally[v] = 1;
    });

    const histRes = await pool.query('SELECT date, studio, candidates, tally, vote_count as "voteCount" FROM election_history ORDER BY id DESC LIMIT 20');

    res.json({
      phase: e.phase,
      studio: e.studio,
      candidates: e.candidates,
      tally,
      voteCount: Object.keys(e.votes).length,
      history: histRes.rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/election/setup', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const { candidates, studio } = req.body;
    if (!candidates || !Array.isArray(candidates) || candidates.length < 2) {
      return res.status(400).json({ error: 'At least 2 candidates required' });
    }
    const cleanCandidates = candidates.map(c => c.trim()).filter(Boolean);
    await pool.query(
      "UPDATE election SET candidates = $1, studio = $2, votes = '{}', phase = 'setup' WHERE id = 1",
      [JSON.stringify(cleanCandidates), studio || null]
    );
    await logActivity('Election setup', `Candidates: ${cleanCandidates.join(', ')}`);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/election/open', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const e = await getElection();
    if (!e.candidates || e.candidates.length < 2) {
      return res.status(400).json({ error: 'Set up candidates before opening voting' });
    }
    await pool.query(
      "UPDATE election SET phase = 'voting', votes = '{}', opened_at = $1 WHERE id = 1",
      [new Date().toISOString()]
    );
    await logActivity('Election opened', `Voting open for ${e.studio || 'all studios'}`);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/election/close', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const e = await getElection();
    await pool.query(
      "UPDATE election SET phase = 'results', closed_at = $1 WHERE id = 1",
      [new Date().toISOString()]
    );
    await logActivity('Election closed', `${Object.keys(e.votes).length} votes cast`);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/election/reset', async (req, res) => {
  try {
    if (!(await verifyAdmin(req))) return res.status(403).json({ error: 'Unauthorized' });
    const e = await getElection();

    if (e.candidates.length > 0) {
      const tally = {};
      e.candidates.forEach(c => { tally[c] = 0; });
      Object.values(e.votes).forEach(v => { if (tally[v] !== undefined) tally[v]++; });
      await pool.query(
        'INSERT INTO election_history (date, studio, candidates, tally, vote_count) VALUES ($1, $2, $3, $4, $5)',
        [new Date().toISOString(), e.studio, JSON.stringify(e.candidates), JSON.stringify(tally), Object.keys(e.votes).length]
      );
    }

    await pool.query(
      "UPDATE election SET phase = 'setup', studio = NULL, candidates = '[]', votes = '{}', opened_at = NULL, closed_at = NULL WHERE id = 1"
    );
    await logActivity('Election reset', 'Election archived and reset');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/election/vote', async (req, res) => {
  try {
    const user = await verifyLearner(req);
    if (!user) return res.status(401).json({ error: 'You must be logged in to vote' });

    const e = await getElection();
    if (e.phase !== 'voting') return res.status(400).json({ error: 'Voting is not currently open' });

    if (e.studio && user.studio && e.studio !== user.studio) {
      return res.status(403).json({ error: `This election is for ${e.studio} only` });
    }

    if (e.votes[user.id]) return res.status(400).json({ error: 'You have already voted in this election' });

    const { candidate } = req.body;
    if (!candidate || !e.candidates.includes(candidate)) {
      return res.status(400).json({ error: 'Invalid candidate' });
    }

    e.votes[user.id] = candidate;
    await pool.query('UPDATE election SET votes = $1 WHERE id = 1', [JSON.stringify(e.votes)]);
    await logActivity('Vote cast', `${user.name} voted`);

    res.json({ success: true, message: 'Your vote has been recorded!' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ================================================================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

initDatabase().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Eagle Bot running on http://0.0.0.0:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
