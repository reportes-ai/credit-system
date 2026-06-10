'use strict';
/* ─────────────────────────────────────────────────────────────────
   requireFunc(...codigos) — autorización paramétrica por funcionalidad

   Valida contra la matriz de Perfiles y Permisos en BD (la misma que
   se edita en /usuarios/ → Perfiles y Permisos). Reglas:
     1. Perfil "Administrador" pasa siempre.
     2. Override individual (permisos_usuario) prevalece sobre el perfil.
     3. Basta con tener UNO de los códigos pedidos.
   El perfil se lee de BD (no del token) para que los cambios apliquen
   sin re-login. Caché de 60s por usuario para no castigar la BD.

   Uso en rutas:
     const { requireFunc } = require('../../../../shared/middleware/permisos');
     router.put('/variables', verifyToken, requireFunc('comisiones_variables'), ctrl.putVariables);
   ───────────────────────────────────────────────────────────────── */
const pool = require('../config/database');

const CACHE_MS = 60 * 1000;
const cache = new Map();   // id_usuario → { exp, esAdmin, funcs:Set }

async function permisosDe(id_usuario) {
  const hit = cache.get(id_usuario);
  if (hit && hit.exp > Date.now()) return hit;

  const [[u]] = await pool.query(
    `SELECT u.id_perfil, p.nombre AS perfil
     FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
     WHERE u.id_usuario = ? AND u.estado = 'activo'`, [id_usuario]
  );
  const entry = { exp: Date.now() + CACHE_MS, esAdmin: false, funcs: new Set() };
  if (u) {
    entry.esAdmin = u.perfil === 'Administrador';
    if (!entry.esAdmin) {
      const [base] = await pool.query(
        `SELECT f.codigo, pp.habilitado FROM permisos_perfil pp
         JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
         WHERE pp.id_perfil = ?`, [u.id_perfil]
      );
      base.forEach(r => { if (r.habilitado === 1) entry.funcs.add(r.codigo); });
      try {
        const [ov] = await pool.query(
          `SELECT f.codigo, pu.habilitado FROM permisos_usuario pu
           JOIN funcionalidades f ON f.id_funcionalidad = pu.id_funcionalidad
           WHERE pu.id_usuario = ?`, [id_usuario]
        );
        ov.forEach(r => { r.habilitado === 1 ? entry.funcs.add(r.codigo) : entry.funcs.delete(r.codigo); });
      } catch (_) { /* tabla puede no existir */ }
    }
  }
  cache.set(id_usuario, entry);
  return entry;
}

const requireFunc = (...codigos) => async (req, res, next) => {
  try {
    const p = await permisosDe(req.usuario.id_usuario);
    if (p.esAdmin || codigos.some(c => p.funcs.has(c))) return next();
    return res.status(403).json({
      success: false, data: null,
      error: 'Sin permisos suficientes (' + codigos.join(' o ') + ')'
    });
  } catch (e) {
    console.error('[requireFunc]', e.message);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

// Invalida el caché (llamar al guardar permisos para efecto inmediato)
const limpiarCachePermisos = () => cache.clear();

module.exports = { requireFunc, limpiarCachePermisos };
