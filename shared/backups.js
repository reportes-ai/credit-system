'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Backups / Suplencias entre usuarios.
   Cuando un usuario (titular) está respaldado por otro (suplente), lo que el
   sistema le entregaría al titular también le llega al suplente, en 3 categorías
   independientes: Funciones (atribuciones), Alertas (campana) y Correos.
   La tabla usuario_backups la crea el módulo services/backups. Todos los helpers
   fallan en silencio devolviendo el valor original/neutro (si la tabla aún no
   existe o todo está desactivado, NO alteran el comportamiento del sistema).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

// ALERTAS: expande una lista de id_usuario destinatarios agregando los suplentes activos.
async function expandirAlerta(ids) {
  const base = [...new Set((ids || []).filter(Boolean))];
  if (!base.length) return base;
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT id_suplente FROM usuario_backups
        WHERE b_alertas = 1 AND id_suplente IS NOT NULL AND id_titular IN (?)`, [base]);
    const out = new Set(base);
    rows.forEach(r => out.add(r.id_suplente));
    return [...out];
  } catch (_) { return base; }
}

// FUNCIONES: ids de los titulares cuyo respaldo de funciones está activo y apuntan a este suplente.
async function titularesFunciones(idSuplente) {
  if (!idSuplente) return [];
  try {
    const [rows] = await pool.query(
      `SELECT id_titular FROM usuario_backups WHERE b_funciones = 1 AND id_suplente = ?`, [idSuplente]);
    return rows.map(r => r.id_titular);
  } catch (_) { return []; }
}

// CORREOS: dados los emails destinatarios (to), devuelve los emails de los suplentes activos.
async function ccCorreos(emails) {
  const list = (Array.isArray(emails) ? emails : String(emails || '').split(/[,;]/))
    .map(e => String(e).trim().toLowerCase()).filter(Boolean);
  if (!list.length) return [];
  try {
    const [rows] = await pool.query(
      `SELECT DISTINCT s.email
         FROM usuario_backups b
         JOIN usuarios t ON t.id_usuario = b.id_titular
         JOIN usuarios s ON s.id_usuario = b.id_suplente
        WHERE b.b_correos = 1 AND s.email IS NOT NULL AND s.email <> ''
          AND LOWER(t.email) IN (?)`, [list]);
    return rows.map(r => r.email);
  } catch (_) { return []; }
}

module.exports = { expandirAlerta, titularesFunciones, ccCorreos };
