'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Google Calendar — DOS modos:
   (A) CENTRALIZADO (preferido, Google Workspace): cuenta de servicio con
       delegación a nivel de dominio. La app lee el calendario de cada usuario
       por su correo @autofacilchile.cl SIN que nadie conecte nada.
       Env: GOOGLE_SA_JSON_B64 (JSON de la cuenta de servicio en base64) o
       GOOGLE_SA_CLIENT_EMAIL + GOOGLE_SA_PRIVATE_KEY.
       Requiere que un Súper Admin autorice el client_id de la cuenta en
       admin.google.com → Delegación de todo el dominio, con scope
       calendar.events.readonly.
   (B) POR USUARIO (respaldo): OAuth 2.0, cada usuario conecta su cuenta.
       Env: GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET.
   ──────────────────────────────────────────────────────────────────────────── */
const axios = require('axios');
const jwt = require('jsonwebtoken');
const pool = require('../../../../shared/config/database');

const SCOPE_CAL = 'https://www.googleapis.com/auth/calendar.events.readonly';
const TOKEN_URI = 'https://oauth2.googleapis.com/token';

// ── Cuenta de servicio (modo centralizado) ──
let SA = null;
try {
  if (process.env.GOOGLE_SA_JSON_B64) SA = JSON.parse(Buffer.from(process.env.GOOGLE_SA_JSON_B64, 'base64').toString('utf8'));
  else if (process.env.GOOGLE_SA_CLIENT_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY)
    SA = { client_email: process.env.GOOGLE_SA_CLIENT_EMAIL, private_key: process.env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, '\n') };
} catch (e) { console.error('[google SA parse]', e.message); SA = null; }
const centralizado = () => !!(SA && SA.client_email && SA.private_key);

// ── OAuth por usuario (modo respaldo) ──
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const APP_URL = (process.env.APP_URL || 'https://afbs.autofacilchile.cl').replace(/\/+$/, '');
const REDIRECT_URI = APP_URL + '/api/mi-dia/google/callback';
const oauthConfig = () => !!(CLIENT_ID && CLIENT_SECRET);

const configurado = () => centralizado() || oauthConfig();

require('../../../../shared/migrate').enFila('google-calendar', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mi_dia_google (
        id_usuario    INT PRIMARY KEY,
        email         VARCHAR(200) NULL,
        refresh_token TEXT NULL,
        connected_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
  } catch (e) { console.error('[mi_dia_google migration]', e.message); }
});

/* ── Utilidades comunes ── */
function rangoHoyChile() {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return { timeMin: `${partes}T00:00:00-04:00`, timeMax: `${partes}T23:59:59-04:00` };
}
const fmtHora = iso => { try { return new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); } catch (_) { return ''; } };
async function listarEventos(accessToken) {
  const { timeMin, timeMax } = rangoHoyChile();
  const { data } = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    headers: { Authorization: 'Bearer ' + accessToken },
    params: { timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 20, timeZone: 'America/Santiago' },
  });
  return (data.items || []).filter(e => e.status !== 'cancelled').map(e => ({
    titulo: e.summary || '(sin título)',
    hora: e.start && e.start.dateTime ? fmtHora(e.start.dateTime) : 'Todo el día',
    dia_completo: !!(e.start && e.start.date),
    ubicacion: e.location || null,
    link: e.htmlLink || null,
  }));
}

/* ── (A) Modo centralizado: cuenta de servicio impersonando al usuario ── */
async function accessTokenImpersonando(email) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({
    iss: SA.client_email, sub: email, scope: SCOPE_CAL, aud: TOKEN_URI, iat: now, exp: now + 3600,
  }, SA.private_key, { algorithm: 'RS256' });
  const { data } = await axios.post(TOKEN_URI, new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return data.access_token;
}

/* ── (B) Modo OAuth por usuario ── */
function authUrl(id_usuario) {
  const state = jwt.sign({ id_usuario, g: 1 }, process.env.JWT_SECRET || 'dev', { expiresIn: '15m' });
  const p = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code',
    scope: SCOPE_CAL + ' https://www.googleapis.com/auth/userinfo.email',
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}
async function exchangeCode(code) {
  const { data } = await axios.post(TOKEN_URI, new URLSearchParams({
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return data;
}
async function accessTokenDe(refresh_token) {
  const { data } = await axios.post(TOKEN_URI, new URLSearchParams({
    refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token',
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return data.access_token;
}
async function guardarDesdeCallback(code, state) {
  const payload = jwt.verify(state, process.env.JWT_SECRET || 'dev');
  const tok = await exchangeCode(code);
  let email = null;
  try { const { data } = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tok.access_token } }); email = data.email || null; } catch (_) {}
  if (tok.refresh_token) {
    await pool.query(`INSERT INTO mi_dia_google (id_usuario, email, refresh_token, connected_at) VALUES (?,?,?,NOW())
       ON DUPLICATE KEY UPDATE email=VALUES(email), refresh_token=VALUES(refresh_token), connected_at=NOW()`, [payload.id_usuario, email, tok.refresh_token]);
  } else {
    await pool.query('UPDATE mi_dia_google SET email=COALESCE(?,email), connected_at=NOW() WHERE id_usuario=?', [email, payload.id_usuario]);
  }
  return { id_usuario: payload.id_usuario, email };
}
async function desconectar(id_usuario) { await pool.query('DELETE FROM mi_dia_google WHERE id_usuario=?', [id_usuario]); }

/* ── API unificada para el panel ──
   Devuelve { disponible, auto, conectado, email, eventos, error }. */
async function agendaHoy({ id_usuario, email }) {
  if (!configurado()) return { disponible: false };
  // (A) Centralizado: lee el calendario del usuario por su correo, sin conectar
  if (centralizado()) {
    if (!email) return { disponible: true, auto: true, conectado: false, error: 'sin_email' };
    try {
      const at = await accessTokenImpersonando(email);
      const eventos = await listarEventos(at);
      return { disponible: true, auto: true, conectado: true, email, eventos };
    } catch (e) {
      console.error('[google SA agenda]', e.response ? JSON.stringify(e.response.data) : e.message);
      return { disponible: true, auto: true, conectado: false, email, error: 'no_lectura' };
    }
  }
  // (B) OAuth por usuario
  const [[r]] = await pool.query('SELECT email, refresh_token FROM mi_dia_google WHERE id_usuario=? LIMIT 1', [id_usuario]);
  if (!r || !r.refresh_token) return { disponible: true, auto: false, conectado: false };
  try {
    const at = await accessTokenDe(r.refresh_token);
    const eventos = await listarEventos(at);
    return { disponible: true, auto: false, conectado: true, email: r.email, eventos };
  } catch (e) {
    console.error('[google oauth agenda]', e.response ? JSON.stringify(e.response.data) : e.message);
    return { disponible: true, auto: false, conectado: false, email: r.email, error: 'no_lectura' };
  }
}

module.exports = { configurado, centralizado, agendaHoy, authUrl, guardarDesdeCallback, desconectar };
