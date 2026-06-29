'use strict';
/**
 * uf.js — MOTOR ÚNICO de lookup de UF (backend).
 *
 * getUF(fecha): UF vigente a una fecha = la última con `fecha <= dada` (estrategia
 * histórica). Devuelve null si no hay ninguna ≤ (la fecha es anterior al rango cargado):
 * NO inventa una UF de otra época. Una sola estrategia para que la misma fecha dé el mismo
 * valor en todos los módulos (antes guardar/recalcular usaban `fecha = ?` exacta y otros
 * `fecha <= ?` histórica → divergían).
 *
 * Si un contexto necesita un fallback a la UF más reciente (p.ej. cálculos del día en
 * cobranza), que lo agregue encima de getUF, no acá.
 */
const pool = require('./config/database');

async function getUF(fecha) {
  if (!fecha) return null;
  const f = (fecha instanceof Date ? fecha.toISOString() : String(fecha)).slice(0, 10);
  const [[u]] = await pool.query(
    'SELECT valor FROM uf WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1', [f]
  );
  return u ? parseFloat(u.valor) : null;
}

module.exports = { getUF };
