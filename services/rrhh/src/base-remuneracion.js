'use strict';
// Remuneración base para indemnizaciones y provisiones (Máxima 1 — motor único):
// promedio de las últimas 3 liquidaciones EMITIDAS (total imponible); si no hay,
// sueldo base ×1,25 (aprox. gratificación). La usan: finiquito (indemnizaciones y
// feriado proporcional) y cartola de Vacaciones / analytics (provisión).
// NOTA: el tope 15% del art. 58 CT usa OTRA base a propósito (remuneración TOTAL
// de la última liquidación) — es otra magnitud, no se fusiona.
const pool = require('../../../shared/config/database');

async function remuneracionBase(idUsuario) {
  const [liqs] = await pool.query(
    `SELECT total_imponible FROM rh_liquidaciones WHERE id_usuario=? AND estado='EMITIDA' ORDER BY mes DESC LIMIT 3`, [idUsuario]);
  if (liqs.length) return Math.round(liqs.reduce((a, l) => a + Number(l.total_imponible), 0) / liqs.length);
  const [[f]] = await pool.query(`SELECT sueldo_base FROM rh_fichas WHERE id_usuario=?`, [idUsuario]);
  return Math.round((Number(f?.sueldo_base) || 0) * 1.25);
}

// Versión batch para pantallas de equipo (una sola pasada a BD)
async function remuneracionBaseMapa() {
  const [fichas] = await pool.query(`SELECT id_usuario, sueldo_base FROM rh_fichas`);
  const sb = {}; fichas.forEach(f => sb[f.id_usuario] = Number(f.sueldo_base) || 0);
  const [liqs] = await pool.query(
    `SELECT id_usuario, total_imponible FROM rh_liquidaciones WHERE estado='EMITIDA' ORDER BY mes DESC`);
  const acc = {};
  for (const l of liqs) { (acc[l.id_usuario] = acc[l.id_usuario] || []); if (acc[l.id_usuario].length < 3) acc[l.id_usuario].push(Number(l.total_imponible)); }
  return idU => {
    const a = acc[idU];
    return a?.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : Math.round((sb[idU] || 0) * 1.25);
  };
}

module.exports = { remuneracionBase, remuneracionBaseMapa };
