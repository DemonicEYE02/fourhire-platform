const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { initDB, getDB, saveDB } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'fourhire-super-secret-change-in-prod';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
// Ensure uploads dir exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Auth middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// ---- Auth Routes ----
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });
  const db = getDB();
  const stmt = db.prepare('SELECT id FROM users WHERE email = ?');
  stmt.bind([email]);
  if (stmt.step()) { stmt.free(); return res.status(400).json({ error: 'Email exists' }); }
  stmt.free();
  const hash = await bcrypt.hash(password, 10);
  // ALL new registrations are clients. Freelancer is seeded only.
  db.run('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)', [name, email, hash, 'client']);
  saveDB();
  const id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
  const token = jwt.sign({ id, name, email, role: 'client' }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id, name, email, role: 'client' } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const db = getDB();
  const stmt = db.prepare('SELECT id,name,email,password,role,gmail,gmail_verified,linkedin,fiverr FROM users WHERE email = ?');
  stmt.bind([email]);
  if (!stmt.step()) { stmt.free(); return res.status(400).json({ error: 'Invalid credentials' }); }
  const row = stmt.getAsObject();
  stmt.free();
  const ok = await bcrypt.compare(password, row.password);
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: row.id, name: row.name, email: row.email, role: row.role }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: row.id, name: row.name, email: row.email, role: row.role, gmail: row.gmail, gmail_verified: row.gmail_verified, linkedin: row.linkedin, fiverr: row.fiverr } });
});

// ---- Profile / Verification ----
app.get('/api/profile', auth, (req, res) => {
  const db = getDB();
  const stmt = db.prepare('SELECT id,name,email,role,gmail,gmail_verified,linkedin,fiverr FROM users WHERE id = ?');
  stmt.bind([req.user.id]);
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'Not found' }); }
  const row = stmt.getAsObject();
  stmt.free();
  res.json(row);
});

app.patch('/api/profile', auth, (req, res) => {
  const { gmail, linkedin, fiverr } = req.body;
  const db = getDB();
  if (gmail !== undefined) db.run('UPDATE users SET gmail = ?, gmail_verified = 0 WHERE id = ?', [gmail, req.user.id]);
  if (linkedin !== undefined) db.run('UPDATE users SET linkedin = ? WHERE id = ?', [linkedin, req.user.id]);
  if (fiverr !== undefined) db.run('UPDATE users SET fiverr = ? WHERE id = ?', [fiverr, req.user.id]);
  saveDB();
  res.json({ ok: true });
});

// Send verification (mock: generates token, returns it; in prod send via email)
app.post('/api/verify-gmail', auth, (req, res) => {
  const { gmail } = req.body;
  if (!gmail) return res.status(400).json({ error: 'Gmail required' });
  const db = getDB();
  const token = uuidv4();
  db.run('UPDATE users SET gmail = ?, verify_token = ?, gmail_verified = 0 WHERE id = ?', [gmail, token, req.user.id]);
  saveDB();
  // In production: send email with link containing token
  // For MVP: return token so user can verify (or auto-verify for demo)
  res.json({ ok: true, verify_token: token, message: 'Verification email sent (demo: token returned)' });
});

app.post('/api/verify-gmail/confirm', auth, (req, res) => {
  const { token } = req.body;
  const db = getDB();
  const stmt = db.prepare('SELECT id FROM users WHERE id = ? AND verify_token = ?');
  stmt.bind([req.user.id, token]);
  if (!stmt.step()) { stmt.free(); return res.status(400).json({ error: 'Invalid token' }); }
  stmt.free();
  db.run('UPDATE users SET gmail_verified = 1, verify_token = NULL WHERE id = ?', [req.user.id]);
  saveDB();
  res.json({ ok: true, verified: true });
});

// ---- Projects ----
app.post('/api/projects', auth, requireRole('client'), upload.array('files', 5), (req, res) => {
  const { title, description, category, budget_min, budget_max, deadline } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const db = getDB();
  db.run('INSERT INTO projects (client_id,title,description,category,budget_min,budget_max,deadline,status) VALUES (?,?,?,?,?,?,?,?)',
    [req.user.id, title, description || '', category || 'general', budget_min || 0, budget_max || 0, deadline || '', 'submitted']);
  saveDB();
  const id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
  res.json({ id, title, status: 'submitted' });
});

app.get('/api/projects', auth, (req, res) => {
  const db = getDB();
  let rows;
  if (req.user.role === 'client') {
    const stmt = db.prepare('SELECT * FROM projects WHERE client_id = ? ORDER BY created_at DESC');
    stmt.bind([req.user.id]);
    rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
  } else {
    const stmt = db.prepare('SELECT p.*, u.name as client_name, u.email as client_email, u.gmail as client_gmail FROM projects p JOIN users u ON p.client_id = u.id ORDER BY p.created_at DESC');
    rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
  }
  res.json(rows);
});

app.get('/api/projects/:id', auth, (req, res) => {
  const db = getDB();
  const stmt = db.prepare('SELECT p.*, u.name as client_name, u.email as client_email, u.gmail as client_gmail, u.gmail_verified as client_gmail_verified FROM projects p JOIN users u ON p.client_id = u.id WHERE p.id = ?');
  stmt.bind([req.params.id]);
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'Not found' }); }
  const project = stmt.getAsObject();
  stmt.free();
  if (req.user.role === 'client' && project.client_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  res.json(project);
});

app.patch('/api/projects/:id', auth, requireRole('freelancer', 'admin'), (req, res) => {
  const { status, advance_amount, final_amount } = req.body;
  const db = getDB();
  const stmt = db.prepare('SELECT * FROM projects WHERE id = ?');
  stmt.bind([req.params.id]);
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'Not found' }); }
  stmt.free();
  if (status) db.run('UPDATE projects SET status = ? WHERE id = ?', [status, req.params.id]);
  if (advance_amount !== undefined) db.run('UPDATE projects SET advance_amount = ? WHERE id = ?', [advance_amount, req.params.id]);
  if (final_amount !== undefined) db.run('UPDATE projects SET final_amount = ? WHERE id = ?', [final_amount, req.params.id]);
  saveDB();
  res.json({ ok: true });
});

// ---- Messages ----
app.get('/api/projects/:id/messages', auth, (req, res) => {
  const db = getDB();
  const stmt = db.prepare('SELECT m.*, u.name as sender_name, u.role as sender_role FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.project_id = ? ORDER BY m.created_at ASC');
  stmt.bind([req.params.id]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  res.json(rows);
});

// ---- Payments ----
app.post('/api/projects/:id/pay', auth, requireRole('client'), (req, res) => {
  const { type, amount } = req.body;
  if (!['advance', 'final'].includes(type)) return res.status(400).json({ error: 'Bad type' });
  const db = getDB();
  const stmt = db.prepare('SELECT * FROM projects WHERE id = ?');
  stmt.bind([req.params.id]);
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'Not found' }); }
  const project = stmt.getAsObject();
  stmt.free();
  if (project.client_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  db.run('INSERT INTO payments (project_id, amount, type, status) VALUES (?,?,?,?)', [req.params.id, amount, type, 'paid']);
  if (type === 'advance') {
    db.run('UPDATE projects SET payment_status = ?, advance_amount = ?, status = ? WHERE id = ?', ['advance_paid', amount, 'in_progress', req.params.id]);
  } else {
    db.run('UPDATE projects SET payment_status = ?, final_amount = ?, status = ? WHERE id = ?', ['fully_paid', amount, 'delivered', req.params.id]);
  }
  saveDB();
  res.json({ ok: true, status: type === 'advance' ? 'advance_paid' : 'fully_paid' });
});

// ---- Delivery ----
app.post('/api/projects/:id/deliver', auth, requireRole('freelancer', 'admin'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const db = getDB();
  db.run('UPDATE projects SET watermark_path = ?, final_path = ?, status = ? WHERE id = ?', [req.file.filename, req.file.filename, 'review', req.params.id]);
  saveDB();
  res.json({ ok: true, file: req.file.filename });
});

app.get('/api/projects/:id/preview', auth, (req, res) => {
  const db = getDB();
  const stmt = db.prepare('SELECT watermark_path FROM projects WHERE id = ?');
  stmt.bind([req.params.id]);
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'Not found' }); }
  const row = stmt.getAsObject();
  stmt.free();
  if (!row.watermark_path) return res.status(404).json({ error: 'No preview' });
  res.sendFile(path.join(UPLOADS_DIR, row.watermark_path));
});

app.get('/api/projects/:id/download', auth, (req, res) => {
  const db = getDB();
  const stmt = db.prepare('SELECT final_path, payment_status FROM projects WHERE id = ?');
  stmt.bind([req.params.id]);
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'Not found' }); }
  const row = stmt.getAsObject();
  stmt.free();
  if (row.payment_status !== 'fully_paid') return res.status(403).json({ error: 'Payment required' });
  if (!row.final_path) return res.status(404).json({ error: 'No file' });
  res.download(path.join(UPLOADS_DIR, row.final_path));
});

// ---- Socket.io Chat ----
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No token'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  socket.on('join_project', (projectId) => {
    socket.join('project_' + projectId);
  });
  socket.on('send_message', (data) => {
    const { projectId, content } = data;
    const db = getDB();
    db.run('INSERT INTO messages (project_id, sender_id, content) VALUES (?,?,?)', [projectId, socket.user.id, content]);
    saveDB();
    const msg = {
      project_id: projectId,
      sender_id: socket.user.id,
      sender_name: socket.user.name,
      sender_role: socket.user.role,
      content,
      created_at: new Date().toISOString()
    };
    io.to('project_' + projectId).emit('new_message', msg);
  });
});

// ---- Health Check ----
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'fourhire-platform' }));

// ---- Serve frontend ----
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- Start ----
initDB().then(() => {
  server.listen(PORT, () => {
    console.log('FourHire platform running on http://localhost:' + PORT);
    console.log('Freelancer login: fourhire8@gmail.com / FourHire@123321');
  });
});
