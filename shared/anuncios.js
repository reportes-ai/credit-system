'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Anuncios "push" a TODA la app (banner que baja desde arriba).
   Canal: tabla mantenimiento_config (la misma que humoradas/mantención), claves
   anuncio_*. El front (app-version.js) lo detecta en su poll de /api/mantenimiento.
   Frescura: solo se entrega si el anuncio tiene < FRESH_MS (para no mostrarle un
   "nuevo crédito" viejo a quien recién abre la app). Dedup por nonce en el cliente.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

const FRESH_MS = 45000;   // 45s: cubre el poll de 12s y no molesta a quien entra tarde

const setKv = (k, v) =>
  pool.query("INSERT INTO mantenimiento_config (clave, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)", [k, v]);

// Publica un anuncio para todos los usuarios conectados.
async function publicarAnuncio(texto) {
  try {
    const t = String(texto == null ? '' : texto).trim().slice(0, 200);
    if (!t) return;
    const now = String(Date.now());
    await setKv('anuncio_texto', t);
    await setKv('anuncio_nonce', now);   // instancia → el cliente lo muestra una vez
    await setKv('anuncio_at', now);      // marca de tiempo para la frescura
  } catch (e) { console.error('[anuncios publicar]', e.message); }
}

// Lee el anuncio vigente (o null si no hay / ya venció la frescura).
async function leerAnuncio() {
  try {
    const [rows] = await pool.query("SELECT clave, valor FROM mantenimiento_config WHERE clave IN ('anuncio_texto','anuncio_nonce','anuncio_at')");
    const m = {}; rows.forEach(r => { m[r.clave] = r.valor; });
    if (!m.anuncio_texto || !m.anuncio_nonce) return null;
    if (Date.now() - parseInt(m.anuncio_at || '0', 10) > FRESH_MS) return null;
    return { texto: m.anuncio_texto, nonce: m.anuncio_nonce };
  } catch (e) { return null; }
}

module.exports = { publicarAnuncio, leerAnuncio };
