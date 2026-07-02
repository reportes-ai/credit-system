'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Google Calendar — OAuth 2.0 por usuario, con axios (sin SDK extra).
   Cada usuario conecta SU cuenta una vez; guardamos su refresh_token en
   mi_dia_google. En "Mi día" pedimos un access_token fresco y listamos los
   eventos de HOY (zona Chile). Requiere env: GOOGLE_OAUTH_CLIENT_ID,
   GOOGLE_OAUTH_CLIENT_SECRET. Redirect: {APP_URL}/api/mi-dia/google/callback.
   ──────────────────────────────────────────────────────────────────────────── */
const axios = require('axios');
const jwt = require('jsonwebtoken');
const pool = require('../../../../shared/config/database');

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const APP_URL = (process.env.APP_URL || 'https://credit-system-45em.onrender.com').replace(/\/+$/, '');
const REDIRECT_URI = APP_URL + '/api/mi-dia/google/callback';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/userinfo.email';

const configurado = () => !!(CLIENT_ID && CLIENT_SECRET);

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mi_dia_google (
        id_usuario    INT PRIMARY KEY,
        email         VARCHAR(200) NULL,
        refresh_token TEXT NULL,
        connected_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
  } catch (e) { console.error('[mi_dia_google migration]', e.message); }
})();

// URL de consentimiento. El state es un JWT corto con el id_usuario (el callback
// de Google no trae la sesión, así que viaja firmado y se valida a la vuelta).
function authUrl(id_usuario) {
  const state = jwt.sign({ id_usuario, g: 1 }, process.env.JWT_SECRET || 'dev', { expiresIn: '15m' });
  const p = new URLSearchParams({
    client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: 'code',
    scope: SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

async function exchangeCode(code) {
  const { data } = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return data; // { access_token, refresh_token, expires_in, ... }
}

async function accessTokenDe(refresh_token) {
  const { data } = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token',
  }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return data.access_token;
}

async function emailDe(access_token) {
  try {
    const { data } = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + access_token } });
    return data.email || null;
  } catch (_) { return null; }
}

// Callback: guarda el refresh_token del usuario (valida el state firmado)
async function guardarDesdeCallback(code, state) {
  const payload = jwt.verify(state, process.env.JWT_SECRET || 'dev'); // lanza si inválido/expirado
  const id_usuario = payload.id_usuario;
  const tok = await exchangeCode(code);
  const email = await emailDe(tok.access_token);
  // Google solo entrega refresh_token en el primer consentimiento; si no vino, conservamos el previo
  if (tok.refresh_token) {
    await pool.query(
      `INSERT INTO mi_dia_google (id_usuario, email, refresh_token, connected_at) VALUES (?,?,?,NOW())
       ON DUPLICATE KEY UPDATE email=VALUES(email), refresh_token=VALUES(refresh_token), connected_at=NOW()`,
      [id_usuario, email, tok.refresh_token]);
  } else {
    await pool.query('UPDATE mi_dia_google SET email=COALESCE(?,email), connected_at=NOW() WHERE id_usuario=?', [email, id_usuario]);
  }
  return { id_usuario, email };
}

async function estado(id_usuario) {
  if (!configurado()) return { disponible: false, conectado: false };
  const [[r]] = await pool.query('SELECT email FROM mi_dia_google WHERE id_usuario=? AND refresh_token IS NOT NULL LIMIT 1', [id_usuario]);
  return { disponible: true, conectado: !!r, email: r ? r.email : null };
}

async function desconectar(id_usuario) {
  await pool.query('DELETE FROM mi_dia_google WHERE id_usuario=?', [id_usuario]);
}

// Eventos de HOY (Chile) del usuario. Devuelve [] si no conectado o si falla.
async function eventosHoy(id_usuario) {
  if (!configurado()) return null;
  try {
    const [[r]] = await pool.query('SELECT refresh_token FROM mi_dia_google WHERE id_usuario=? LIMIT 1', [id_usuario]);
    if (!r || !r.refresh_token) return null;
    const at = await accessTokenDe(r.refresh_token);
    // Rango del día en Chile
    const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const timeMin = `${partes}T00:00:00-04:00`;
    const timeMax = `${partes}T23:59:59-04:00`;
    const { data } = await axios.get('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      headers: { Authorization: 'Bearer ' + at },
      params: { timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 20, timeZone: 'America/Santiago' },
    });
    const fmtHora = iso => { try { return new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso)); } catch (_) { return ''; } };
    return (data.items || []).filter(e => e.status !== 'cancelled').map(e => ({
      titulo: e.summary || '(sin título)',
      hora: e.start && e.start.dateTime ? fmtHora(e.start.dateTime) : 'Todo el día',
      dia_completo: !!(e.start && e.start.date),
      ubicacion: e.location || null,
      link: e.htmlLink || null,
    }));
  } catch (e) { console.error('[google eventosHoy]', e.response ? JSON.stringify(e.response.data) : e.message); return null; }
}

module.exports = { configurado, authUrl, guardarDesdeCallback, estado, desconectar, eventosHoy };
