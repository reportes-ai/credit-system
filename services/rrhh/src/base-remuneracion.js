'use strict';
// Remuneración base para indemnizaciones y provisiones (Máxima 1 — motor único):
// promedio de las últimas 3 liquidaciones EMITIDAS (total imponible); si el motor
// propio aún no ha emitido, promedio de los últimos 3 meses del Libro de
// Remuneraciones de AVSOFT (ctb_remun_aux, por RUT — la misma fuente del F29,
// la DJ 1887 y el LRE); si tampoco hay, sueldo base ×1,25 (aprox. gratificación).
// La usan: finiquito (indemnizaciones y feriado proporcional) y cartola de
// Vacaciones / analytics (provisión).
// Caso Fernando Contreras (14-09-2026): el finiquito salía con base = sueldo×1,25
// ($691.941) aunque AVSOFT tenía sus comisiones cargadas ($1.631.580 de promedio).
// NOTA: el tope 15% del art. 58 CT usa OTRA base a propósito (remuneración TOTAL
// de la última liquidación) — es otra magnitud, no se fusiona.
const pool = require('../../../shared/config/database');

const mesActual = () => new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 7);

/* { base, fuente: 'MOTOR'|'AVSOFT'|'ESTIMADA', meses: [...] }
   hastaMes (YYYY-MM, exclusivo): solo meses ANTERIORES — el mes en curso del
   auxiliar es una corrida provisoria de AVSOFT, no una liquidación pagada. */
async function remuneracionBaseDetalle(idUsuario, hastaMes) {
  const hasta = /^\d{4}-\d{2}$/.test(hastaMes || '') ? hastaMes : mesActual();
  const [liqs] = await pool.query(
    `SELECT mes, total_imponible FROM rh_liquidaciones WHERE id_usuario=? AND estado='EMITIDA' ORDER BY mes DESC LIMIT 3`, [idUsuario]);
  if (liqs.length)
    return { base: Math.round(liqs.reduce((a, l) => a + Number(l.total_imponible), 0) / liqs.length), fuente: 'MOTOR', meses: liqs.map(l => l.mes),
      detalle: liqs.map(l => ({ mes: l.mes, imponible: Number(l.total_imponible) })) };
  const [[u]] = await pool.query(`SELECT rut FROM usuarios WHERE id_usuario=?`, [idUsuario]);
  const rut = String(u?.rut || '').replace(/\./g, '').toUpperCase();
  if (rut) {
    const [aux] = await pool.query(
      // total_ganado = imponible REAL; la columna imponible del LIBREMUN viene topada (87,8 UF) — el tope lo aplica el finiquito
      `SELECT mes, COALESCE(NULLIF(total_ganado,0), imponible) imponible, sueldo_base, comisiones, semana_corrida, gratificacion, otros_imponibles
         FROM ctb_remun_aux WHERE UPPER(REPLACE(rut,'.',''))=? AND mes < ? AND imponible > 0 ORDER BY mes DESC LIMIT 3`, [rut, hasta]);
    if (aux.length)
      return { base: Math.round(aux.reduce((a, l) => a + Number(l.imponible), 0) / aux.length), fuente: 'AVSOFT', meses: aux.map(l => l.mes),
        // apertura (solo si el auxiliar la trae: importaciones desde v241.1)
        detalle: aux.map(l => ({ mes: l.mes, imponible: Number(l.imponible), sueldo: Number(l.sueldo_base) || 0, comisiones: Number(l.comisiones) || 0,
          semana_corrida: Number(l.semana_corrida) || 0, gratificacion: Number(l.gratificacion) || 0, otros: Number(l.otros_imponibles) || 0,
          con_apertura: (Number(l.comisiones) || 0) + (Number(l.gratificacion) || 0) + (Number(l.semana_corrida) || 0) > 0 })) };
  }
  const [[f]] = await pool.query(`SELECT sueldo_base FROM rh_fichas WHERE id_usuario=?`, [idUsuario]);
  return { base: Math.round((Number(f?.sueldo_base) || 0) * 1.25), fuente: 'ESTIMADA', meses: [], detalle: [], sueldo_base: Number(f?.sueldo_base) || 0 };
}

async function remuneracionBase(idUsuario, hastaMes) {
  return (await remuneracionBaseDetalle(idUsuario, hastaMes)).base;
}

// Versión batch para pantallas de equipo (una sola pasada a BD) — misma cascada
async function remuneracionBaseMapa() {
  const hasta = mesActual();
  const [fichas] = await pool.query(`SELECT f.id_usuario, f.sueldo_base, UPPER(REPLACE(u.rut,'.','')) rut FROM rh_fichas f JOIN usuarios u ON u.id_usuario=f.id_usuario`);
  const sb = {}, rutDe = {}; fichas.forEach(f => { sb[f.id_usuario] = Number(f.sueldo_base) || 0; rutDe[f.id_usuario] = f.rut || ''; });
  const [liqs] = await pool.query(
    `SELECT id_usuario, total_imponible FROM rh_liquidaciones WHERE estado='EMITIDA' ORDER BY mes DESC`);
  const acc = {};
  for (const l of liqs) { (acc[l.id_usuario] = acc[l.id_usuario] || []); if (acc[l.id_usuario].length < 3) acc[l.id_usuario].push(Number(l.total_imponible)); }
  const [aux] = await pool.query(
    `SELECT UPPER(REPLACE(rut,'.','')) rut, COALESCE(NULLIF(total_ganado,0), imponible) imponible FROM ctb_remun_aux WHERE mes < ? AND imponible > 0 ORDER BY mes DESC`, [hasta]);
  const accAux = {};
  for (const l of aux) { (accAux[l.rut] = accAux[l.rut] || []); if (accAux[l.rut].length < 3) accAux[l.rut].push(Number(l.imponible)); }
  const prom = a => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  return idU => {
    const a = acc[idU];
    if (a?.length) return prom(a);
    const b = accAux[rutDe[idU]];
    if (b?.length) return prom(b);
    return Math.round((sb[idU] || 0) * 1.25);
  };
}

module.exports = { remuneracionBase, remuneracionBaseDetalle, remuneracionBaseMapa };
