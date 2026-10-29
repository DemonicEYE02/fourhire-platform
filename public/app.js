const API = '';
let token = localStorage.getItem('fh_token');
let currentUser = JSON.parse(localStorage.getItem('fh_user') || 'null');
let socket = null;
let currentProject = null;

// ---- Helpers ----
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return fetch(API + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
}

function showLogin() {
  document.getElementById('loginView').style.display = 'block';
  document.getElementById('registerView').style.display = 'none';
}
function showRegister() {
  document.getElementById('loginView').style.display = 'none';
  document.getElementById('registerView').style.display = 'block';
}

// ---- Auth ----
async function doRegister() {
  const name = document.getElementById('regName').value;
  const email = document.getElementById('regEmail').value;
  const password = document.getElementById('regPassword').value;
  const err = document.getElementById('registerError');
  err.style.display = 'none';
  try {
    const res = await api('/api/register', { method: 'POST', body: JSON.stringify({ name, email, password }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Register failed');
    token = data.token; currentUser = data.user;
    localStorage.setItem('fh_token', token);
    localStorage.setItem('fh_user', JSON.stringify(currentUser));
    enterApp();
  } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
}

async function doLogin() {
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  const err = document.getElementById('loginError');
  err.style.display = 'none';
  try {
    const res = await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    token = data.token; currentUser = data.user;
    localStorage.setItem('fh_token', token);
    localStorage.setItem('fh_user', JSON.stringify(currentUser));
    enterApp();
  } catch (e) { err.textContent = e.message; err.style.display = 'block'; }
}

function doLogout() {
  token = null; currentUser = null;
  localStorage.removeItem('fh_token'); localStorage.removeItem('fh_user');
  if (socket) socket.disconnect();
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('appScreen').style.display = 'none';
}

function enterApp() {
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('appScreen').style.display = 'block';
  document.getElementById('userName').textContent = currentUser.name;
  const badge = document.getElementById('roleBadge');
  badge.textContent = currentUser.role.toUpperCase();
  const newBtn = document.getElementById('newProjectBtn');
  newBtn.style.display = currentUser.role === 'client' ? 'inline-block' : 'none';
  document.getElementById('dashboardTitle').textContent = currentUser.role === 'client' ? 'Your Projects' : 'All Projects';
  initSocket();
  showDashboard();
}

// ---- Socket ----
function initSocket() {
  if (socket) socket.disconnect();
  socket = io({ auth: { token } });
  socket.on('new_message', (msg) => {
    if (currentProject && msg.project_id == currentProject.id) {
      appendMessage(msg);
    }
  });
}

// ---- Dashboard ----
async function showDashboard() {
  document.getElementById('dashboardView').style.display = 'block';
  document.getElementById('projectDetailView').style.display = 'none';
  currentProject = null;
  if (socket) socket.emit('leave_project'); // not strictly needed
  const res = await api('/api/projects');
  const projects = await res.json();
  const list = document.getElementById('projectList');
  list.innerHTML = '';
  const empty = document.getElementById('emptyState');
  if (!projects.length) { empty.style.display = 'block'; return; }
  empty.style.display = 'none';
  projects.forEach(p => {
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `
      <h3>${escapeHtml(p.title)}</h3>
      <p>${escapeHtml(p.description || '')}</p>
      <div class="meta">
        <span>${p.category}</span>
        <span>₹${p.budget_min}–${p.budget_max}</span>
        <span class="status">${p.status.replace('_',' ')}</span>
      </div>
    `;
    card.onclick = () => openProject(p.id);
    list.appendChild(card);
  });
}

// ---- Project Detail ----
async function openProject(id) {
  const res = await api('/api/projects/' + id);
  const p = await res.json();
  currentProject = p;
  document.getElementById('dashboardView').style.display = 'none';
  document.getElementById('projectDetailView').style.display = 'block';

  document.getElementById('pdTitle').textContent = p.title;
  document.getElementById('pdDesc').textContent = p.description || '';
  document.getElementById('pdCategory').textContent = p.category;
  document.getElementById('pdBudget').textContent = '₹' + p.budget_min + ' – ₹' + p.budget_max;
  document.getElementById('pdDeadline').textContent = p.deadline || '—';
  document.getElementById('pdAdvance').textContent = p.advance_amount ? '₹' + p.advance_amount : '—';
  document.getElementById('pdFinal').textContent = p.final_amount ? '₹' + p.final_amount : '—';

  const statusEl = document.getElementById('pdStatus');
  statusEl.textContent = p.status.replace('_',' ');
  statusEl.className = 'status-badge status-' + p.status;

  // Payment section
  const payInfo = document.getElementById('payInfo');
  const advanceBtn = document.getElementById('advanceBtn');
  const finalBtn = document.getElementById('finalBtn');
  const paySection = document.getElementById('paySection');
  // Only clients see payment section
  paySection.style.display = currentUser.role === 'client' ? 'block' : 'none';
  if (currentUser.role === 'client') {
    if (p.payment_status === 'none') {
      payInfo.textContent = 'Pay advance to start work.';
      advanceBtn.style.display = 'block'; advanceBtn.disabled = !p.advance_amount;
      finalBtn.style.display = 'none';
    } else if (p.payment_status === 'advance_paid') {
      payInfo.textContent = 'Advance paid. Work in progress. Pay final on completion.';
      advanceBtn.style.display = 'none';
      finalBtn.style.display = 'block'; finalBtn.disabled = !p.final_amount;
    } else {
      payInfo.textContent = 'Fully paid. Project delivered.';
      advanceBtn.style.display = 'none';
      finalBtn.style.display = 'none';
    }
  }

  // Delivery
  const previewBox = document.getElementById('previewBox');
  const downloadBtn = document.getElementById('downloadBtn');
  const downloadHint = document.getElementById('downloadHint');
  if (p.watermark_path) {
    previewBox.style.display = 'block';
    document.getElementById('previewImg').src = '/api/projects/' + p.id + '/preview?token=' + token;
  } else {
    previewBox.style.display = 'none';
  }
  if (p.payment_status === 'fully_paid') {
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Download Project';
    downloadHint.textContent = 'Unlocked — you can download now.';
  } else {
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Download Project (Locked)';
    downloadHint.textContent = 'Pay full amount to unlock download.';
  }

  // Freelancer controls
  const fc = document.getElementById('freelancerControls');
  fc.style.display = currentUser.role === 'freelancer' || currentUser.role === 'admin' ? 'block' : 'none';
  document.getElementById('setAdvance').value = p.advance_amount || '';
  document.getElementById('setFinal').value = p.final_amount || '';

  // Load messages
  const mres = await api('/api/projects/' + id + '/messages');
  const msgs = await mres.json();
  const chat = document.getElementById('chatMessages');
  chat.innerHTML = '';
  msgs.forEach(appendMessage);

  // Join socket room
  if (socket) socket.emit('join_project', id);
}

function appendMessage(msg) {
  const chat = document.getElementById('chatMessages');
  const div = document.createElement('div');
  const mine = msg.sender_id == currentUser.id;
  div.className = 'chat-msg ' + (mine ? 'mine' : 'theirs');
  div.innerHTML = `<div class="meta">${escapeHtml(msg.sender_name || 'User')} · ${msg.sender_role || ''}</div>${escapeHtml(msg.content)}`;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
}

function sendMessage() {
  const input = document.getElementById('chatInput');
  const content = input.value.trim();
  if (!content || !currentProject) return;
  if (socket) socket.emit('send_message', { projectId: currentProject.id, content });
  input.value = '';
}

// ---- Payments ----
async function payAdvance() {
  if (!currentProject || !currentProject.advance_amount) return toast('Advance amount not set yet.');
  const amount = currentProject.advance_amount;
  if (!confirm('Pay advance of ₹' + amount + '? (Demo payment)')) return;
  const res = await api('/api/projects/' + currentProject.id + '/pay', {
    method: 'POST', body: JSON.stringify({ type: 'advance', amount })
  });
  const data = await res.json();
  if (data.ok) { toast('Advance paid! Work started.'); openProject(currentProject.id); }
  else toast('Payment failed');
}

async function payFinal() {
  if (!currentProject || !currentProject.final_amount) return toast('Final amount not set yet.');
  const amount = currentProject.final_amount;
  if (!confirm('Pay final amount of ₹' + amount + '? (Demo payment)')) return;
  const res = await api('/api/projects/' + currentProject.id + '/pay', {
    method: 'POST', body: JSON.stringify({ type: 'final', amount })
  });
  const data = await res.json();
  if (data.ok) { toast('Fully paid! Download unlocked.'); openProject(currentProject.id); }
  else toast('Payment failed');
}

// ---- Freelancer Controls ----
async function updatePricing() {
  const advance = parseInt(document.getElementById('setAdvance').value) || 0;
  const final = parseInt(document.getElementById('setFinal').value) || 0;
  const res = await api('/api/projects/' + currentProject.id, {
    method: 'PATCH', body: JSON.stringify({ advance_amount: advance, final_amount: final })
  });
  const data = await res.json();
  if (data.ok) { toast('Pricing updated.'); openProject(currentProject.id); }
  else toast('Update failed');
}

async function deliverProject() {
  const fileInput = document.getElementById('deliverFile');
  if (!fileInput.files.length) return toast('Select a file first.');
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  const res = await fetch('/api/projects/' + currentProject.id + '/deliver', {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + token }, body: fd
  });
  const data = await res.json();
  if (data.ok) { toast('Project delivered with watermark.'); openProject(currentProject.id); }
  else toast('Delivery failed');
}

function downloadProject() {
  window.location.href = '/api/projects/' + currentProject.id + '/download?token=' + token;
}

// ---- New Project Modal ----
function showNewProjectModal() { document.getElementById('newProjectModal').classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

async function submitProject() {
  const title = document.getElementById('npTitle').value;
  const description = document.getElementById('npDesc').value;
  const category = document.getElementById('npCategory').value;
  const budget_min = parseInt(document.getElementById('npBudgetMin').value) || 0;
  const budget_max = parseInt(document.getElementById('npBudgetMax').value) || 0;
  const deadline = document.getElementById('npDeadline').value;
  const res = await api('/api/projects', {
    method: 'POST', body: JSON.stringify({ title, description, category, budget_min, budget_max, deadline })
  });
  const data = await res.json();
  if (data.id) {
    toast('Project submitted!');
    closeModal('newProjectModal');
    showDashboard();
  } else toast('Submission failed');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- Settings / Profile ----
function showSettings() {
  document.getElementById('settingsModal').classList.add('show');
  loadProfile();
}
async function loadProfile() {
  const res = await api('/api/profile');
  const p = await res.json();
  document.getElementById('setGmail').value = p.gmail || '';
  document.getElementById('setLinkedin').value = p.linkedin || '';
  document.getElementById('setFiverr').value = p.fiverr || '';
  const status = document.getElementById('gmailStatus');
  if (p.gmail_verified) status.innerHTML = '✓ Verified — ' + p.gmail;
  else if (p.gmail) status.innerHTML = '⚠ Not verified';
  else status.innerHTML = '';
}
async function saveProfile() {
  const gmail = document.getElementById('setGmail').value;
  const linkedin = document.getElementById('setLinkedin').value;
  const fiverr = document.getElementById('setFiverr').value;
  const res = await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ gmail, linkedin, fiverr }) });
  const data = await res.json();
  if (data.ok) { toast('Profile saved!'); closeModal('settingsModal'); }
  else toast('Save failed');
}
async function sendVerifyGmail() {
  const gmail = document.getElementById('setGmail').value;
  if (!gmail) return toast('Enter a Gmail first.');
  const res = await api('/api/verify-gmail', { method: 'POST', body: JSON.stringify({ gmail }) });
  const data = await res.json();
  if (data.ok) {
    // Demo: auto-verify with returned token
    const c = await api('/api/verify-gmail/confirm', { method: 'POST', body: JSON.stringify({ token: data.verify_token }) });
    const cd = await c.json();
    if (cd.verified) { toast('Gmail verified!'); loadProfile(); }
  } else toast('Verification failed');
}

// ---- Init ----
if (token && currentUser) enterApp();
else showLogin();
