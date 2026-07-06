'use strict';
/* ── Presencia de usuarios (para el Cuadro de Mando) ──────────────────────
   Middleware liviano en el gateway: en cada request /api con Bearer token
   registra "última actividad" del usuario (decodifica el payload del JWT
   SOLO para leer el id — la validación real la hace verifyToken en cada
   ruta; esto es telemetría, no autorización).
   Conectado = actividad en los últimos 5 minutos. */

const pool = require('./config/database');

const vivos = new Map(); // id_usuario -> ts última actividad
const VENTANA_MS = 5 * 60 * 1000;

/* ── Persistencia: bloques de 5 min por usuario (para "horas de conexión") ──
   Cada request marca el bloque de 5 min en curso; un flush por minuto los
   graba con INSERT IGNORE (máx 12 filas/usuario/hora — costo mínimo). */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS presencia_bloques (
        id_usuario INT NOT NULL,
        bloque DATETIME NOT NULL,
        PRIMARY KEY (id_usuario, bloque),
        INDEX idx_bloque (bloque)
      )`);
  } catch (e) { console.error('[presencia migration]', e.message); }
})();

const _buffer = new Set(); // "id|YYYY-MM-DD HH:MM:00" (bloque de 5 min)
function marcarBloque(id) {
  const d = new Date();
  d.setMinutes(Math.floor(d.getMinutes() / 5) * 5, 0, 0);
  const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':00';
  _buffer.add(id + '|' + iso);
}
setInterval(async () => {
  if (!_buffer.size) return;
  const filas = [..._buffer].map(x => x.split('|'));
  _buffer.clear();
  try {
    await pool.query('INSERT IGNORE INTO presencia_bloques (id_usuario, bloque) VALUES ' +
      filas.map(() => '(?,?)').join(','), filas.flat());
  } catch (e) { console.error('[presencia flush]', e.message); }
}, 60000).unref?.();

function middleware(req, _res, next) {
  try {
    if (req.path.startsWith('/api/')) {
      const auth = req.headers.authorization || '';
      if (auth.startsWith('Bearer ')) {
        const payload = JSON.parse(Buffer.from(auth.slice(7).split('.')[1] || '', 'base64url').toString() || '{}');
        const id = payload.id_usuario || payload.id;
        if (id) { vivos.set(Number(id), Date.now()); marcarBloque(Number(id)); }
      }
    }
  } catch (e) { /* nunca romper el request por telemetría */ }
  next();
}

function conectadosIds() {
  const corte = Date.now() - VENTANA_MS;
  const ids = new Set();
  for (const [id, ts] of vivos) { if (ts > corte) ids.add(id); else vivos.delete(id); }
  return ids;
}

module.exports = { middleware, conectadosIds };
