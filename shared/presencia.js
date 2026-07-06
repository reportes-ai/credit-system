'use strict';
/* ── Presencia de usuarios (para el Cuadro de Mando) ──────────────────────
   Middleware liviano en el gateway: en cada request /api con Bearer token
   registra "última actividad" del usuario (decodifica el payload del JWT
   SOLO para leer el id — la validación real la hace verifyToken en cada
   ruta; esto es telemetría, no autorización).
   Conectado = actividad en los últimos 5 minutos. */

const vivos = new Map(); // id_usuario -> ts última actividad
const VENTANA_MS = 5 * 60 * 1000;

function middleware(req, _res, next) {
  try {
    if (req.path.startsWith('/api/')) {
      const auth = req.headers.authorization || '';
      if (auth.startsWith('Bearer ')) {
        const payload = JSON.parse(Buffer.from(auth.slice(7).split('.')[1] || '', 'base64url').toString() || '{}');
        const id = payload.id_usuario || payload.id;
        if (id) vivos.set(Number(id), Date.now());
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
