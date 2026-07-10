'use strict';
/**
 * Cliente de la API de Fintoc (https://api.fintoc.com/v1) — lectura de cuentas
 * bancarias: SALDOS y CARTOLAS (movimientos). Cubre Banco de Chile, Santander, etc.
 *
 * Autenticación: header `Authorization: <secret_key>` (la key va cruda, sin "Bearer").
 *   - Sandbox:    sk_test_...   (gratis, datos ficticios — para desarrollar/probar)
 *   - Producción: sk_live_...   (se activa al contratar el plan)
 * La key NO va en el código: vive en el mantenedor (parametros_credito.fintoc_secret_key).
 *
 * Cada cuenta conectada tiene un `link_token` (se genera una vez al enlazar la cuenta
 * con las credenciales del banco). Los endpoints de lectura lo exigen como query param.
 *
 * Montos: Fintoc entrega enteros en la unidad base de la moneda. Para CLP (sin decimales)
 * el entero ES el monto en pesos. Positivo = abono, negativo = cargo.
 */
const axios = require('axios');

const BASE = 'https://api.fintoc.com/v1';

function clienteFintoc(secretKey) {
  if (!secretKey) { const e = new Error('Falta la API key de Fintoc'); e.code = 'NOKEY'; throw e; }
  return axios.create({
    baseURL: BASE,
    timeout: 20000,
    headers: { Authorization: secretKey, Accept: 'application/json' },
    validateStatus: () => true,   // el detalle del error viene en el body (error.message)
  });
}

// Extrae el mensaje real del error de Fintoc (body { error: { message, type, code } }).
function errorFintoc(r) {
  const b = r && r.data;
  const msg = (b && b.error && (b.error.message || b.error.type)) || ('Fintoc HTTP ' + (r && r.status));
  const e = new Error(msg); e.code = 'FINTOC'; e.status = r && r.status; return e;
}

// Lista de cuentas de un link (con saldo disponible/contable).
async function listarCuentas(secretKey, linkToken) {
  const api = clienteFintoc(secretKey);
  const r = await api.get('/accounts', { params: { link_token: linkToken } });
  if (r.status < 200 || r.status >= 300) throw errorFintoc(r);
  return (Array.isArray(r.data) ? r.data : []).map(normCuenta);
}

// Una cuenta puntual (refresca su saldo).
async function obtenerCuenta(secretKey, linkToken, accountId) {
  const api = clienteFintoc(secretKey);
  const r = await api.get('/accounts/' + encodeURIComponent(accountId), { params: { link_token: linkToken } });
  if (r.status < 200 || r.status >= 300) throw errorFintoc(r);
  return normCuenta(r.data);
}

/**
 * Movimientos (cartola) de una cuenta. Pagina con el header `Link` (rel="next");
 * seguimos hasta agotar o hasta `maxPaginas` (tope defensivo). `since` (YYYY-MM-DD)
 * acota el rango para no re-traer toda la historia en cada sync.
 */
async function listarMovimientos(secretKey, linkToken, accountId, { since, perPage = 300, maxPaginas = 30 } = {}) {
  const api = clienteFintoc(secretKey);
  const params = { link_token: linkToken, per_page: perPage };
  if (since) params.since = since;
  let url = '/accounts/' + encodeURIComponent(accountId) + '/movements';
  const out = [];
  for (let i = 0; i < maxPaginas && url; i++) {
    const r = await api.get(url, { params: i === 0 ? params : undefined });
    if (r.status < 200 || r.status >= 300) throw errorFintoc(r);
    (Array.isArray(r.data) ? r.data : []).forEach(m => out.push(normMovimiento(m)));
    url = siguientePagina(r.headers && r.headers.link);   // null cuando no hay más
  }
  return out;
}

// Header Link: <https://api.fintoc.com/v1/...&page=2>; rel="next" → devuelve el path relativo o null.
function siguientePagina(linkHeader) {
  if (!linkHeader) return null;
  const m = String(linkHeader).split(',').map(s => s.trim()).find(s => /rel="next"/.test(s));
  if (!m) return null;
  const u = m.match(/<([^>]+)>/);
  if (!u) return null;
  try { return u[1].replace(BASE, ''); } catch { return null; }
}

const num = v => { const n = Number(v); return isFinite(n) ? n : 0; };

function normCuenta(a) {
  a = a || {};
  const bal = a.balance || {};
  return {
    account_id:   a.id || null,
    nombre:       a.name || a.official_name || '',
    numero:       a.number || '',
    titular:      a.holder_name || '',
    rut_titular:  a.holder_id || '',
    tipo:         a.type || '',
    moneda:       a.currency || 'CLP',
    banco:        (a.institution && a.institution.name) || '',
    saldo_disponible: num(bal.available),
    saldo_contable:   num(bal.current),
  };
}

function normMovimiento(m) {
  m = m || {};
  return {
    fintoc_id:   m.id || null,
    monto:       num(m.amount),                 // + abono / − cargo
    moneda:      m.currency || 'CLP',
    fecha:       (m.post_date || m.transaction_date || '').slice(0, 10),
    descripcion: m.description || m.comment || '',
    tipo:        m.type || '',
    pendiente:   !!m.pending,
    contraparte_rut: (m.sender_account && m.sender_account.holder_id) ||
                     (m.recipient_account && m.recipient_account.holder_id) || '',
    contraparte:     (m.sender_account && m.sender_account.holder_name) ||
                     (m.recipient_account && m.recipient_account.holder_name) || '',
  };
}

module.exports = { clienteFintoc, listarCuentas, obtenerCuenta, listarMovimientos };
