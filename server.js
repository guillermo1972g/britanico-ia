const express = require('express');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'britanico-ia-secret-2024';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const NOTIFY_EMAIL = 'wdreifus@gmail.com';

/* ══════ EMAIL HELPER ══════ */
async function sendEmail(subject, html) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.log('[Email] Variables GMAIL_USER / GMAIL_APP_PASSWORD no configuradas — email omitido.');
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass }
    });
    await transporter.sendMail({
      from: `"Shopping Británico IA" <${user}>`,
      to: NOTIFY_EMAIL,
      subject,
      html
    });
    console.log('[Email] Enviado:', subject);
  } catch (e) {
    console.error('[Email] Error:', e.message);
  }
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ══════ DATA ══════ */
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
function read(f) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f + '.json'), 'utf8')); } catch { return null; } }
function write(f, d) { fs.writeFileSync(path.join(DATA_DIR, f + '.json'), JSON.stringify(d, null, 2)); }

/* ══════ ROLES
   admin  → control total
   jefa   → aprueba/rechaza, ve reportes y alertas
   equipo → crea contenido, envía a revisión, publica aprobados,
             gestiona WhatsApp, reseñas y calendario
══════ */

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Sesión expirada. Ingresá de nuevo.' }); }
}
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Solo administradores.' });
const canApprove = (req, res, next) => ['admin','jefa'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Solo la jefa puede aprobar.' });

function addNotif(data) {
  const list = read('notifications') || [];
  list.unshift({ id: Date.now(), ...data, read: false, at: new Date().toISOString() });
  write('notifications', list.slice(0, 100));
}

/* SETTINGS */
app.get('/api/settings', auth, (req, res) => res.json(read('settings') || { autoApprove: false }));
app.put('/api/settings', auth, canApprove, (req, res) => {
  const settings = { ...(read('settings') || {}), ...req.body };
  write('settings', settings);
  if (req.body.autoApprove !== undefined) {
    const mode = req.body.autoApprove ? 'automático ✅' : 'manual 👁️';
    addNotif({ type: 'settings', from: req.user.name, message: `⚙️ ${req.user.name} cambió el modo de aprobación a: ${mode}. ${req.body.autoApprove ? 'Todo el contenido nuevo se aprueba y queda listo para publicar.' : 'El contenido nuevo requiere revisión antes de publicarse.'}` });
  }
  res.json({ ok: true });
});

/* AUTH */
app.post('/api/auth/check', (req, res) => {
  const { email } = req.body;
  const users = read('users') || [];
  const user = users.find(u => u.email.toLowerCase() === email?.toLowerCase());
  if (!user) return res.status(404).json({ error: 'No existe una cuenta con ese email.' });
  if (user.disabled) return res.status(403).json({ error: 'Tu acceso al sistema está deshabilitado. Contactá al administrador.' });
  res.json({ requiresPassword: !user.noPassword, name: user.name });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const users = read('users') || [];
  const user = users.find(u => u.email.toLowerCase() === email?.toLowerCase());
  if (!user) return res.status(401).json({ error: 'No existe una cuenta con ese email.' });
  if (user.disabled) return res.status(403).json({ error: 'Tu acceso al sistema está deshabilitado. Contactá al administrador.' });
  if (!user.noPassword && !bcrypt.compareSync(password || '', user.password || ''))
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  const token = jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
  const log = read('activity') || [];
  log.unshift({ user: user.name, role: user.role, action: 'login', at: new Date().toISOString() });
  write('activity', log.slice(0, 200));
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});
app.get('/api/auth/me', auth, (req, res) => res.json(req.user));

/* AI PROXY */
app.post('/api/ai/chat', auth, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada en Railway.' });
  if (req.user.role === 'jefa') return res.status(403).json({ error: 'La jefa no usa el agente de IA directamente.' });
  try {
    const { messages, system, tools } = req.body;
    const body = { model: 'claude-sonnet-4-20250514', max_tokens: 1000, system, messages };
    if (tools) body.tools = tools;
    const r1 = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
    const d1 = await r1.json();
    if (d1.stop_reason === 'tool_use') {
      const toolResults = d1.content.filter(c => c.type === 'tool_use').map(tu => ({ type: 'tool_result', tool_use_id: tu.id, content: 'Búsqueda completada.' }));
      const body2 = { ...body, messages: [...messages, { role: 'assistant', content: d1.content }, { role: 'user', content: toolResults }] };
      const r2 = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body2) });
      return res.json(await r2.json());
    }
    res.json(d1);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* BRAND */
app.get('/api/brand', auth, (req, res) => res.json(read('brand') || {}));
app.put('/api/brand', auth, (req, res) => {
  if (req.user.role === 'jefa') return res.status(403).json({ error: 'Sin permisos.' });
  write('brand', req.body); res.json({ ok: true });
});

/* QUEUE */
app.get('/api/queue', auth, (req, res) => {
  const q = read('queue') || [];
  if (['admin','jefa'].includes(req.user.role)) return res.json(q);
  return res.json(q.filter(i => i.authorId === req.user.id || i.status === 'approved'));
});
app.post('/api/queue', auth, (req, res) => {
  if (req.user.role === 'jefa') return res.status(403).json({ error: 'Sin permisos.' });
  const q = read('queue') || [];
  const settings = read('settings') || { autoApprove: false };
  const autoApp = settings.autoApprove;
  const item = { id: Date.now(), ...req.body, authorId: req.user.id, author: req.user.name, status: autoApp ? 'approved' : 'pending', createdAt: new Date().toISOString() };
  if (autoApp) {
    item.reviewedBy = 'Auto-aprobado';
    item.reviewedAt = new Date().toISOString();
    addNotif({ type: 'auto_approved', from: req.user.name, message: `✅ Auto-aprobado: "${(req.body.title||'').slice(0,60)}" de ${req.user.name} — listo para publicar.` });
  } else {
    addNotif({ type: 'review', from: req.user.name, message: `📬 ${req.user.name} envió contenido para revisión: "${(req.body.title||'').slice(0,60)}"` });
  }
  q.unshift(item); write('queue', q.slice(0, 300));
  res.json({ ok: true, id: item.id, status: item.status });
});
app.put('/api/queue/:id', auth, (req, res) => {
  const q = read('queue') || [];
  const idx = q.findIndex(i => i.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado.' });
  if (['approved','rejected'].includes(req.body.status) && !['admin','jefa'].includes(req.user.role))
    return res.status(403).json({ error: 'Solo la jefa puede aprobar o rechazar.' });
  q[idx] = { ...q[idx], ...req.body, updatedBy: req.user.name, updatedAt: new Date().toISOString() };
  write('queue', q);
  if (req.body.status === 'approved') addNotif({ type: 'approved', from: req.user.name, message: `✅ Aprobado: "${(q[idx].title||'').slice(0,60)}" — listo para publicar.` });
  if (req.body.status === 'rejected') addNotif({ type: 'rejected', from: req.user.name, message: `❌ Rechazado: "${(q[idx].title||'').slice(0,60)}". ${req.body.feedback||''}` });
  if (req.body.status === 'published') addNotif({ type: 'published', from: req.user.name, message: `📤 Publicado: "${(q[idx].title||'').slice(0,60)}" por ${req.user.name}.` });
  res.json({ ok: true });
});
app.delete('/api/queue/:id', auth, adminOnly, (req, res) => { write('queue', (read('queue')||[]).filter(i => i.id != req.params.id)); res.json({ ok: true }); });

/* CALENDAR */
app.get('/api/calendar', auth, (req, res) => res.json(read('calendar') || {}));
app.post('/api/calendar', auth, (req, res) => {
  if (req.user.role === 'jefa') return res.status(403).json({ error: 'Sin permisos.' });
  const cal = read('calendar') || {};
  const { date, post } = req.body;
  if (!cal[date]) cal[date] = [];
  cal[date].push({ ...post, addedBy: req.user.name, addedAt: new Date().toISOString() });
  write('calendar', cal); res.json({ ok: true });
});
app.delete('/api/calendar/:date/:idx', auth, (req, res) => {
  if (req.user.role === 'jefa') return res.status(403).json({ error: 'Sin permisos.' });
  const cal = read('calendar') || {};
  if (cal[req.params.date]) { cal[req.params.date].splice(req.params.idx, 1); write('calendar', cal); }
  res.json({ ok: true });
});

/* NOTIFICATIONS */
app.get('/api/notifications', auth, (req, res) => res.json(read('notifications') || []));
app.put('/api/notifications/read', auth, (req, res) => { write('notifications', (read('notifications')||[]).map(n => ({ ...n, read: true }))); res.json({ ok: true }); });

/* USERS */
app.get('/api/users', auth, adminOnly, (req, res) => res.json((read('users')||[]).map(u => ({ ...u, password: undefined }))));
app.post('/api/users', auth, adminOnly, (req, res) => {
  const users = read('users') || [];
  const { name, email, password, role } = req.body;
  const noPassword = req.body.noPassword === true;
  if (!name||!email||!role) return res.status(400).json({ error: 'Nombre, email y rol son requeridos.' });
  if (!noPassword && !password) return res.status(400).json({ error: 'Contraseña requerida para este usuario.' });
  if (users.find(u => u.email.toLowerCase() === email.toLowerCase())) return res.status(400).json({ error: 'Email ya existe.' });
  if (!['admin','jefa','equipo'].includes(role)) return res.status(400).json({ error: 'Rol inválido.' });
  users.push({ id: Date.now(), name, email, password: noPassword ? null : bcrypt.hashSync(password, 10), noPassword, role });
  write('users', users); res.json({ ok: true });
});
app.put('/api/users/:id', auth, adminOnly, (req, res) => {
  const users = read('users') || [];
  const idx = users.findIndex(u => u.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado.' });
  const { name, email, role, password } = req.body;
  const noPasswordUpd = req.body.noPassword === true;
  users[idx] = { ...users[idx], name, email, role, noPassword: noPasswordUpd };
  if (noPasswordUpd) { users[idx].password = null; }
  else if (password) { users[idx].password = bcrypt.hashSync(password, 10); }
  write('users', users); res.json({ ok: true });
});
app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  if (req.user.id == req.params.id) return res.status(400).json({ error: 'No podés eliminarte a vos mismo.' });
  write('users', (read('users')||[]).filter(u => u.id != req.params.id)); res.json({ ok: true });
});

app.get('/api/activity', auth, adminOnly, (req, res) => res.json(read('activity') || []));

/* ══════ COMPETITORS ══════ */
app.get('/api/competitors', auth, (req, res) => res.json(read('competitors') || []));
app.post('/api/competitors', auth, async (req, res) => {
  const list = read('competitors') || [];
  if (list.find(c => c.name.toLowerCase() === req.body.name?.toLowerCase()))
    return res.status(400).json({ error: 'Ya existe un competidor con ese nombre.' });
  const item = { id: Date.now(), ...req.body, addedBy: req.user.name, addedAt: new Date().toISOString(), research: [], researching: true };
  list.push(item); write('competitors', list);
  res.json({ ok: true, id: item.id, autoResearching: true });
  // Auto-research in background (non-blocking)
  if (ANTHROPIC_KEY) {
    performResearch(item.name, 'competitor', item, 'competitors', req.user.name).catch(err => {
      const l = read('competitors') || []; const i = l.findIndex(c => c.id === item.id);
      if (i !== -1) { l[i].researching = false; write('competitors', l); }
    });
  }
});
app.put('/api/competitors/:id', auth, (req, res) => {
  const list = read('competitors') || [];
  const idx = list.findIndex(c => c.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado.' });
  list[idx] = { ...list[idx], ...req.body }; write('competitors', list);
  res.json({ ok: true });
});
app.delete('/api/competitors/:id', auth, (req, res) => {
  write('competitors', (read('competitors') || []).filter(c => c.id != req.params.id));
  res.json({ ok: true });
});

/* ══════ REFERENCE BRANDS ══════ */
app.get('/api/refbrands', auth, (req, res) => res.json(read('refbrands') || []));
app.post('/api/refbrands', auth, async (req, res) => {
  const list = read('refbrands') || [];
  if (list.find(b => b.name.toLowerCase() === req.body.name?.toLowerCase()))
    return res.status(400).json({ error: 'Ya existe esa marca referencial.' });
  const item = { id: Date.now(), ...req.body, addedBy: req.user.name, addedAt: new Date().toISOString(), research: [], researching: true };
  list.push(item); write('refbrands', list);
  res.json({ ok: true, id: item.id, autoResearching: true });
  // Auto-research in background (non-blocking)
  if (ANTHROPIC_KEY) {
    performResearch(item.name, 'refbrand', item, 'refbrands', req.user.name).catch(err => {
      const l = read('refbrands') || []; const i = l.findIndex(b => b.id === item.id);
      if (i !== -1) { l[i].researching = false; write('refbrands', l); }
    });
  }
});
app.put('/api/refbrands/:id', auth, (req, res) => {
  const list = read('refbrands') || [];
  const idx = list.findIndex(b => b.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'No encontrado.' });
  list[idx] = { ...list[idx], ...req.body }; write('refbrands', list);
  res.json({ ok: true });
});
app.delete('/api/refbrands/:id', auth, (req, res) => {
  write('refbrands', (read('refbrands') || []).filter(b => b.id != req.params.id));
  res.json({ ok: true });
});

/* ══════ AI RESEARCH (competitors + brands) ══════ */

// Helper: call Claude with optional web search
async function callClaude(system, userMsg, useSearch = false) {
  const body = {
    model: 'claude-sonnet-4-20250514', max_tokens: 1000,
    system, messages: [{ role: 'user', content: userMsg }]
  };
  if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  const HEADERS = { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' };
  const r1 = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
  const d1 = await r1.json();
  if (d1.stop_reason === 'tool_use') {
    const toolResults = d1.content.filter(c => c.type === 'tool_use').map(tu => ({ type: 'tool_result', tool_use_id: tu.id, content: 'Búsqueda realizada.' }));
    const body2 = { ...body, messages: [...body.messages, { role: 'assistant', content: d1.content }, { role: 'user', content: toolResults }] };
    const r2 = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: HEADERS, body: JSON.stringify(body2) });
    const d2 = await r2.json();
    return d2.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
  }
  return d1.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
}

// Core research logic — used by both auto and manual research
async function performResearch(entityName, entityType, entityDetails, collection, requestedBy) {
  const isComp = entityType === 'competitor';
  const brand = read('brand') || {};
  const brandCtx = `Shopping Británico es una cadena de ropa masculina premium de Asunción, Paraguay, con 6 sucursales, 54K seguidores en Instagram, fabrica su propia ropa con Plastimar. Tono: ${brand.tono || 'Elegante y aspiracional'}. Cliente: ${brand.cliente || 'Hombre profesional 28-50 años'}.`;

  // ─── STEP 1: Research with web search ───
  const resSystem = isComp
    ? `${brandCtx} Sos un analista de inteligencia competitiva. Investigás competidores con búsqueda web y presentás hallazgos concretos y actualizados.`
    : `${brandCtx} Sos un analista de tendencias de moda y marketing digital. Investigás marcas internacionales de referencia para extraer las mejores prácticas adaptables a Paraguay.`;

  const resMsg = isComp
    ? `Investigá con búsqueda web todo lo que está haciendo "${entityName}" recientemente.${entityDetails.instagram ? ' Instagram: ' + entityDetails.instagram + '.' : ''}${entityDetails.description ? ' Descripción: ' + entityDetails.description + '.' : ''} Analizá: campañas actuales en redes sociales, tipo de contenido que publican, frecuencia de publicación, promociones y descuentos activos, novedades de productos, posicionamiento de precio, y cualquier noticia reciente. Presentá los hallazgos con subtítulos claros.`
    : `Investigá con búsqueda web qué está haciendo la marca "${entityName}"${entityDetails.country ? ' (' + entityDetails.country + ')' : ''} recientemente.${entityDetails.why ? ' Por qué nos inspira: ' + entityDetails.why + '.' : ''} Analizá: últimas campañas, estrategia de contenido en Instagram y TikTok, lanzamientos de productos, tendencias que están marcando, y cualquier innovación de marketing reciente. Presentá con subtítulos claros.`;

  const findings = await callClaude(resSystem, resMsg, true);

  // ─── STEP 2 (competitors only): Counter-measures + ideas ───
  let countermeasures = null;
  if (isComp && findings) {
    const cmSystem = `${brandCtx} Sos un estratega de marketing experto en retail de moda masculina en Paraguay. Recibís análisis de competidores y generás planes de acción específicos para Shopping Británico.`;
    const cmMsg = `Basándote en este análisis del competidor "${entityName}":

${findings}

Generá un plan de acción completo para Shopping Británico con estas secciones:

## ⚔️ Contramedidas inmediatas
[3-4 acciones concretas que Shopping Británico debe tomar en los próximos 7 días para responder a lo que está haciendo este competidor]

## 💡 Ideas de marketing para diferenciarse
[4-5 ideas creativas específicas de contenido, campañas o acciones que aprovechen los puntos débiles del competidor y los puntos fuertes de Shopping Británico]

## 🎯 Oportunidades que el competidor no está aprovechando
[2-3 huecos del mercado o estrategias que el competidor está ignorando y que Shopping Británico puede capturar]

## 📣 Mensaje de posicionamiento sugerido
[Cómo Shopping Británico debería comunicar su diferencial frente a este competidor en redes sociales]

Sé muy específico y accionable. Evitá consejos genéricos.`;
    countermeasures = await callClaude(cmSystem, cmMsg, false);
  }

  // ─── Save to entity ───
  const list = read(collection) || [];
  const idx = list.findIndex(e => e.name === entityName);
  if (idx !== -1) {
    if (!list[idx].research) list[idx].research = [];
    const record = { id: Date.now(), findings, countermeasures, date: new Date().toISOString(), requestedBy, auto: true };
    list[idx].research.unshift(record);
    list[idx].research = list[idx].research.slice(0, 10);
    list[idx].lastResearched = new Date().toISOString();
    list[idx].researching = false;
    write(collection, list);
    addNotif({ type: 'research', from: 'IA', message: `🔍 Investigación completada: "${entityName}" — ${isComp ? 'análisis + contramedidas listos' : 'análisis listo'}.` });
  }
  return { findings, countermeasures };
}

app.post('/api/research', auth, async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY no configurada.' });
  const { entityName, entityType, entityDetails, collection } = req.body;
  const col = collection || (entityType === 'competitor' ? 'competitors' : 'refbrands');
  try {
    // Mark as researching
    const list = read(col) || [];
    const idx = list.findIndex(e => e.name === entityName);
    if (idx !== -1) { list[idx].researching = true; write(col, list); }
    const result = await performResearch(entityName, entityType, entityDetails || {}, col, req.user?.name || 'Sistema');
    res.json({ ok: true, ...result, date: new Date().toISOString() });
  } catch (e) {
    // Clear researching flag on error
    const list = read(col) || [];
    const idx = list.findIndex(e => e.name === entityName);
    if (idx !== -1) { list[idx].researching = false; write(col, list); }
    res.status(500).json({ error: e.message });
  }
});

/* ══════ TOGGLE USER ACCESS ══════ */
app.put('/api/users/:id/toggle-access', auth, adminOnly, async (req, res) => {
  if (req.user.id == req.params.id)
    return res.status(400).json({ error: 'No podés deshabilitar tu propio acceso.' });
  const users = read('users') || [];
  const idx = users.findIndex(u => u.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado.' });
  users[idx].disabled = !users[idx].disabled;
  write('users', users);
  const action = users[idx].disabled ? 'deshabilitado' : 'habilitado';
  addNotif({ type: 'settings', from: req.user.name, message: `🔐 ${req.user.name} ${action} el acceso de ${users[idx].name}.` });
  const when = new Date().toLocaleString('es-PY', { timeZone: 'America/Asuncion', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  await sendEmail(
    `🔐 Acceso ${action} — ${users[idx].name} · Shopping Británico IA`,
    `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:${users[idx].disabled?'#e05060':'#00d4a0'};margin-bottom:4px">Shopping Británico IA</h2>
      <p style="color:#666;font-size:13px;margin-bottom:20px">Notificación de acceso</p>
      <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin-bottom:16px">
        <p style="margin:0 0 8px"><strong>Usuario:</strong> ${users[idx].name}</p>
        <p style="margin:0 0 8px"><strong>Email:</strong> ${users[idx].email}</p>
        <p style="margin:0 0 8px"><strong>Acción:</strong> Acceso <strong>${action}</strong> por ${req.user.name}</p>
        <p style="margin:0"><strong>Fecha y hora:</strong> ${when}</p>
      </div>
    </div>`
  );
  res.json({ ok: true, disabled: users[idx].disabled });
});

/* ══════ CHANGE PASSWORD ══════ */
app.put('/api/auth/change-password', auth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword || newPassword.length < 6)
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres.' });

  const users = read('users') || [];
  const idx = users.findIndex(u => u.id === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'Usuario no encontrado.' });

  const user = users[idx];

  // If user has password, verify current one
  if (!user.noPassword && user.password) {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, user.password))
      return res.status(401).json({ error: 'La contraseña actual es incorrecta.' });
  }

  users[idx].password = bcrypt.hashSync(newPassword, 10);
  users[idx].noPassword = false;
  write('users', users);

  // Log activity
  const log = read('activity') || [];
  log.unshift({ user: user.name, role: user.role, action: 'password_changed', at: new Date().toISOString() });
  write('activity', log.slice(0, 200));

  // Notify admin by email
  const when = new Date().toLocaleString('es-PY', { timeZone: 'America/Asuncion', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  await sendEmail(
    `🔐 Cambio de contraseña — ${user.name} · Shopping Británico IA`,
    `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#00d4a0;margin-bottom:4px">Shopping Británico IA</h2>
      <p style="color:#666;font-size:13px;margin-bottom:20px">Notificación de seguridad</p>
      <div style="background:#f5f5f5;border-radius:8px;padding:16px;margin-bottom:16px">
        <p style="margin:0 0 8px"><strong>Usuario:</strong> ${user.name}</p>
        <p style="margin:0 0 8px"><strong>Email:</strong> ${user.email}</p>
        <p style="margin:0 0 8px"><strong>Rol:</strong> ${user.role}</p>
        <p style="margin:0"><strong>Fecha y hora:</strong> ${when}</p>
      </div>
      <p style="color:#888;font-size:12px">Si no reconocés este cambio, ingresá al panel de administración y revisá los usuarios.</p>
    </div>`
  );

  addNotif({ type: 'settings', from: user.name, message: `🔐 ${user.name} cambió su contraseña.` });
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

/* INIT */
function initData() {
  if (!read('users')) {
    write('users', [
      { id: 1, name: 'Soporte Técnico', email: 'wdreifus@gmail.com', password: null, noPassword: true, role: 'admin' },
      { id: 2, name: 'Sra Lidia', email: 'lidiadreifus@gmail.com', password: null, noPassword: true, role: 'jefa' },
      { id: 3, name: 'Mirella', email: 'equipo1@britanico.com.py', password: bcrypt.hashSync('Equipo2024!', 10), noPassword: false, role: 'equipo' },
      { id: 4, name: 'Jorge', email: 'equipo2@britanico.com.py', password: bcrypt.hashSync('Equipo2024!', 10), noPassword: false, role: 'equipo' },
    ]);
  }
  if (!read('brand')) write('brand', { nombre: 'Shopping Británico', tono: 'Elegante y aspiracional', cliente: 'Hombre profesional 28-50 años Asunción Paraguay', inspo: 'Massimo Dutti, Tommy Hilfiger', tags: ['Plastimar fabrica la ropa — es un diferencial clave'] });
  ['calendar','queue','notifications','activity','competitors','refbrands'].forEach(f => { if (!read(f)) write(f, f==='calendar'?{}:[]); });
  if (!read('settings')) write('settings', { autoApprove: false });
}
initData();
app.listen(PORT, () => console.log(`🚀 Shopping Británico IA — puerto ${PORT}`));
