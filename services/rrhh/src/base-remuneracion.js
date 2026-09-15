'use strict';
// Remuneración base para indemnizaciones y provisiones (Máxima 1 — motor único).
// DOCTRINA DT verificada el 15-09-2026 (caso F. Contreras vs planilla de Constanza):
//   · Art. 71 CT: renta mixta = sueldo + "promedio de lo ganado en los últimos tres
//     meses trabajados". La DT lo aplica sobre lo PERCIBIDO en esos meses; las
//     comisiones pagadas desfasadas que no entraron al promedio se pagan aparte
//     (ORD. 5424/250 de 1995, ORD. N°495 de 2016, ORD. N°77 de 2025). NO es devengo.
//   · Meses TRABAJADOS completos: no cuentan los meses con licencia (ORD. 2994/171),
//     el mes de ingreso si no empezó el día 1, ni el mes del término.
//   · FERIADO proporcional (art. 73): la gratificación legal pagada mensualmente NO
//     integra la base (dictamen 836/046 de 2004, ORD. 5457/316) → `base_feriado`.
//     Colación y movilización tampoco (no son remuneración).
//   · INDEMNIZACIONES (art. 172): última remuneración mensual con la gratificación
//     mensual garantizada incluida → `base`.
// Cascada de fuente: liquidaciones EMITIDAS del motor → Libro de Remuneraciones de
// AVSOFT (ctb_remun_aux, por RUT) → sueldo base × 1,25 (estimada).
// La usan: finiquito (indemnizaciones y feriado proporcional) y cartola de
// Vacaciones / analytics (provisión).
// NOTA: el tope 15% del art. 58 CT usa OTRA base a propósito (remuneración TOTAL
// de la última liquidación) — es otra magnitud, no se fusiona.
const pool = require('../../../shared/config/database');

const mesActual = () => new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 7);
const mesSig = ym => { let [y, m] = String(ym).split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}`; };
const N = v => Number(v) || 0;
const prom = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : 0;

/* { base, base_feriado, fuente: 'MOTOR'|'AVSOFT'|'ESTIMADA', meses: [...], detalle: [...] }
   hastaMes (YYYY-MM, exclusivo): el mes del término no es completo. */
async function remuneracionBaseDetalle(idUsuario, hastaMes) {
  const hasta = /^\d{4}-\d{2}$/.test(hastaMes || '') ? hastaMes : mesActual();
  const [[u]] = await pool.query(
    `SELECT rut, DATE_FORMAT(fecha_ingreso,'%Y-%m') mes_ing, DAY(fecha_ingreso) dia_ing FROM usuarios WHERE id_usuario=?`, [idUsuario]);
  // Primer mes COMPLETO: el de ingreso solo si entró el día 1
  const desde = u && u.mes_ing ? (Number(u.dia_ing) === 1 ? u.mes_ing : mesSig(u.mes_ing)) : '0000-00';

  // 1) Liquidaciones EMITIDAS por el motor (detalle JSON con la apertura)
  const [liqs] = await pool.query(
    `SELECT mes, total_imponible, detalle FROM rh_liquidaciones WHERE id_usuario=? AND estado='EMITIDA' AND mes < ? AND mes >= ? ORDER BY mes DESC LIMIT 3`,
    [idUsuario, hasta, desde]);
  if (liqs.length) {
    const det = l => { try { return typeof l.detalle === 'string' ? JSON.parse(l.detalle) : (l.detalle || {}); } catch (_) { return {}; } };
    const detalle = liqs.map(l => { const d = det(l); return { mes: l.mes, imponible: N(l.total_imponible), sueldo: N(d.sueldo_base), comisiones: N(d.comisiones),
      semana_corrida: 0, gratificacion: N(d.gratificacion), otros: N(d.otros_imponibles), con_apertura: true }; });
    return { base: prom(detalle.map(x => x.imponible)), base_feriado: prom(detalle.map(x => x.imponible - x.gratificacion)),
      fuente: 'MOTOR', meses: detalle.map(x => x.mes), detalle };
  }

  // 2) Libro de Remuneraciones de AVSOFT (por RUT)
  const rut = String(u?.rut || '').replace(/\./g, '').toUpperCase();
  if (rut) {
    const [aux] = await pool.query(
      // total_ganado = imponible REAL; la columna imponible del LIBREMUN viene topada (87,8 UF) — el tope lo aplica el finiquito
      `SELECT mes, COALESCE(NULLIF(total_ganado,0), imponible) imponible, sueldo_base, comisiones, semana_corrida, gratificacion, otros_imponibles
         FROM ctb_remun_aux WHERE UPPER(REPLACE(rut,'.',''))=? AND mes < ? AND mes >= ? AND imponible > 0 ORDER BY mes DESC LIMIT 3`, [rut, hasta, desde]);
    if (aux.length) {
      const detalle = aux.map(l => ({ mes: l.mes, imponible: N(l.imponible), sueldo: N(l.sueldo_base), comisiones: N(l.comisiones),
        semana_corrida: N(l.semana_corrida), gratificacion: N(l.gratificacion), otros: N(l.otros_imponibles),
        // apertura (solo si el auxiliar la trae: importaciones desde v241.1)
        con_apertura: N(l.comisiones) + N(l.gratificacion) + N(l.semana_corrida) > 0 }));
      return { base: prom(detalle.map(x => x.imponible)), base_feriado: prom(detalle.map(x => x.imponible - x.gratificacion)),
        fuente: 'AVSOFT', meses: detalle.map(x => x.mes), detalle };
    }
  }
  const [[f]] = await pool.query(`SELECT sueldo_base FROM rh_fichas WHERE id_usuario=?`, [idUsuario]);
  const sb = Number(f?.sueldo_base) || 0;
  return { base: Math.round(sb * 1.25), base_feriado: sb, fuente: 'ESTIMADA', meses: [], detalle: [], sueldo_base: sb };
}

async function remuneracionBase(idUsuario, hastaMes) {
  return (await remuneracionBaseDetalle(idUsuario, hastaMes)).base;
}

// Versión batch para pantallas de equipo (una sola pasada a BD) — misma cascada.
// Provisión de vacaciones: base sin gratificación (es lo que paga el feriado).
async function remuneracionBaseMapa() {
  const hasta = mesActual();
  const [fichas] = await pool.query(`SELECT f.id_usuario, f.sueldo_base, UPPER(REPLACE(u.rut,'.','')) rut FROM rh_fichas f JOIN usuarios u ON u.id_usuario=f.id_usuario`);
  const sb = {}, rutDe = {}; fichas.forEach(f => { sb[f.id_usuario] = Number(f.sueldo_base) || 0; rutDe[f.id_usuario] = f.rut || ''; });
  const [liqs] = await pool.query(
    `SELECT id_usuario, total_imponible, detalle FROM rh_liquidaciones WHERE estado='EMITIDA' AND mes < ? ORDER BY mes DESC`, [hasta]);
  const det = l => { try { return typeof l.detalle === 'string' ? JSON.parse(l.detalle) : (l.detalle || {}); } catch (_) { return {}; } };
  const acc = {};
  for (const l of liqs) { (acc[l.id_usuario] = acc[l.id_usuario] || []); if (acc[l.id_usuario].length < 3) acc[l.id_usuario].push(N(l.total_imponible) - N(det(l).gratificacion)); }
  const [aux] = await pool.query(
    `SELECT UPPER(REPLACE(rut,'.','')) rut, COALESCE(NULLIF(total_ganado,0), imponible) imponible, gratificacion FROM ctb_remun_aux WHERE mes < ? AND imponible > 0 ORDER BY mes DESC`, [hasta]);
  const accAux = {};
  for (const l of aux) { (accAux[l.rut] = accAux[l.rut] || []); if (accAux[l.rut].length < 3) accAux[l.rut].push(N(l.imponible) - N(l.gratificacion)); }
  return idU => {
    const a = acc[idU];
    if (a?.length) return prom(a);
    const b = accAux[rutDe[idU]];
    if (b?.length) return prom(b);
    return sb[idU] || 0;
  };
}

module.exports = { remuneracionBase, remuneracionBaseDetalle, remuneracionBaseMapa };
