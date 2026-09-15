'use strict';
// Remuneración base para indemnizaciones y provisiones (Máxima 1 — motor único):
// promedio de los últimos 3 MESES COMPLETOS trabajados, por DEVENGO (art. 71 CT,
// "lo ganado en los últimos tres meses trabajados"; criterio DT: la comisión se gana
// con la venta aunque se pague al mes siguiente — Pato, 15-09-2026, caso F. Contreras
// vs planilla de Constanza).
//   · Fijo del mes M (sueldo, gratificación): la liquidación de M.
//   · Variable del mes M (comisiones, semana corrida, bonos): lo que se PAGÓ en la
//     liquidación de M+1 (mes vencido). Si M+1 aún no se pagó (o el auxiliar no trae
//     comisiones), la comisión devengada de M la da el motor de Comisiones
//     (Nómina de Comisiones vigente, o el cálculo en vivo).
//   · Mes completo: se excluye el mes de ingreso si no empezó el día 1, y el mes del
//     término (hastaMes, exclusivo).
// Cascada de fuente: liquidaciones EMITIDAS del motor → Libro de Remuneraciones de
// AVSOFT (ctb_remun_aux, por RUT) → sueldo base × 1,25 (estimada).
// La usan: finiquito (indemnizaciones y feriado proporcional) y cartola de
// Vacaciones / analytics (provisión, versión batch sin fallback al motor).
// NOTA: el tope 15% del art. 58 CT usa OTRA base a propósito (remuneración TOTAL
// de la última liquidación) — es otra magnitud, no se fusiona.
const pool = require('../../../shared/config/database');

const mesActual = () => new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 7);
const mesSig = ym => { let [y, m] = String(ym).split('-').map(Number); m++; if (m > 12) { m = 1; y++; } return `${y}-${String(m).padStart(2, '0')}`; };
const N = v => Number(v) || 0;

/* Comisión devengada del mes M según el motor de Comisiones (con semana corrida). */
async function comisionMotor(nombreCorto, mes) {
  try {
    const nom = require('../../comisiones/src/controllers/nomina.controller');
    const n = await nom.montosNomina(mes);
    if (n && n.montos && n.montos[nombreCorto] != null) return { monto: N(n.montos[nombreCorto]), fuente: `MOTOR (nómina ${mes} v${n.version})` };
    const { calcularMes } = require('../../comisiones/src/controllers/comisiones.controller');
    const f = (await calcularMes(mes)).find(x => String(x.ejecutivo).toUpperCase().trim() === nombreCorto);
    if (f) return { monto: f.cumple_minimo ? Math.round(N(f.con_semana_corrida)) : 0, fuente: `MOTOR (cálculo ${mes})` };
  } catch (_) {}
  return { monto: 0, fuente: 'MOTOR (sin datos)' };
}

/* { base, fuente: 'MOTOR'|'AVSOFT'|'ESTIMADA', meses: [...], detalle: [...] }
   hastaMes (YYYY-MM, exclusivo): el mes del término no es completo. */
async function remuneracionBaseDetalle(idUsuario, hastaMes) {
  const hasta = /^\d{4}-\d{2}$/.test(hastaMes || '') ? hastaMes : mesActual();
  const [[u]] = await pool.query(
    `SELECT rut, DATE_FORMAT(fecha_ingreso,'%Y-%m') mes_ing, DAY(fecha_ingreso) dia_ing,
            CONCAT(UPPER(COALESCE(nombre,'')),' ',UPPER(COALESCE(apellido,''))) nombre_corto FROM usuarios WHERE id_usuario=?`, [idUsuario]);
  // Primer mes COMPLETO: el de ingreso solo si entró el día 1
  const desde = u && u.mes_ing ? (Number(u.dia_ing) === 1 ? u.mes_ing : mesSig(u.mes_ing)) : '0000-00';
  const nombreCorto = String(u?.nombre_corto || '').trim();

  // 1) Liquidaciones EMITIDAS por el motor (detalle JSON trae comisiones y comisiones_mes)
  const [liqs] = await pool.query(
    `SELECT mes, total_imponible, detalle FROM rh_liquidaciones WHERE id_usuario=? AND estado='EMITIDA' AND mes < ? AND mes >= ? ORDER BY mes DESC LIMIT 4`,
    [idUsuario, hasta, desde]);
  if (liqs.length) {
    const porMes = {}; liqs.forEach(l => { porMes[l.mes] = l; });
    const det = l => { try { return typeof l.detalle === 'string' ? JSON.parse(l.detalle) : (l.detalle || {}); } catch (_) { return {}; } };
    const meses = liqs.slice(0, 3);
    const detalle = [];
    for (const l of meses) {
      const d = det(l), sig = porMes[mesSig(l.mes)];
      const comisPagadas = N(d.comisiones);          // comisión del mes anterior, pagada en esta liquidación
      let comisDev, fuenteC;
      if (sig) { comisDev = N(det(sig).comisiones); fuenteC = `pagada en ${sig.mes}`; }
      else { const m = await comisionMotor(nombreCorto, l.mes); comisDev = m.monto; fuenteC = m.fuente; }
      const imponible = Math.round(N(l.total_imponible) - comisPagadas + comisDev);
      detalle.push({ mes: l.mes, imponible, sueldo: N(d.sueldo_base), comisiones: comisDev, semana_corrida: 0, gratificacion: N(d.gratificacion),
        otros: N(d.otros_imponibles), con_apertura: true, comisiones_fuente: fuenteC });
    }
    return { base: Math.round(detalle.reduce((a, x) => a + x.imponible, 0) / detalle.length), fuente: 'MOTOR', meses: detalle.map(x => x.mes), detalle, devengo: true };
  }

  // 2) Libro de Remuneraciones de AVSOFT (por RUT)
  const rut = String(u?.rut || '').replace(/\./g, '').toUpperCase();
  if (rut) {
    const [aux] = await pool.query(
      // total_ganado = imponible REAL; la columna imponible del LIBREMUN viene topada (87,8 UF) — el tope lo aplica el finiquito.
      // Se trae también el mes `hasta` (corrida provisoria) solo para leer la variable pagada del último mes completo.
      `SELECT mes, COALESCE(NULLIF(total_ganado,0), imponible) imponible, sueldo_base, comisiones, semana_corrida, gratificacion, otros_imponibles
         FROM ctb_remun_aux WHERE UPPER(REPLACE(rut,'.',''))=? AND mes <= ? AND mes >= ? ORDER BY mes DESC LIMIT 5`, [rut, hasta, desde]);
    const porMes = {}; aux.forEach(r => { porMes[r.mes] = r; });
    const meses = aux.filter(r => r.mes < hasta && N(r.imponible) > 0).slice(0, 3);
    if (meses.length) {
      const detalle = [];
      for (const r of meses) {
        const sig = porMes[mesSig(r.mes)];
        const conApertura = N(r.comisiones) + N(r.gratificacion) + N(r.semana_corrida) > 0 || N(sig?.comisiones) + N(sig?.semana_corrida) > 0;
        let comis, sc, otros, fuenteC;
        if (sig && N(sig.comisiones) + N(sig.semana_corrida) > 0) { comis = N(sig.comisiones); sc = N(sig.semana_corrida); otros = N(sig.otros_imponibles); fuenteC = `pagada en ${sig.mes}`; }
        else { const m = await comisionMotor(nombreCorto, r.mes); comis = m.monto; sc = 0; otros = 0; fuenteC = m.fuente; }
        const sueldo = N(r.sueldo_base), grat = N(r.gratificacion);
        // Sin apertura (importaciones antiguas): se queda con el imponible del mes tal cual
        const imponible = conApertura ? Math.round(sueldo + grat + comis + sc + otros) : N(r.imponible);
        detalle.push({ mes: r.mes, imponible, sueldo, comisiones: comis, semana_corrida: sc, gratificacion: grat, otros, con_apertura: conApertura, comisiones_fuente: fuenteC });
      }
      return { base: Math.round(detalle.reduce((a, x) => a + x.imponible, 0) / detalle.length), fuente: 'AVSOFT', meses: detalle.map(x => x.mes), detalle, devengo: true };
    }
  }
  const [[f]] = await pool.query(`SELECT sueldo_base FROM rh_fichas WHERE id_usuario=?`, [idUsuario]);
  return { base: Math.round((Number(f?.sueldo_base) || 0) * 1.25), fuente: 'ESTIMADA', meses: [], detalle: [], sueldo_base: Number(f?.sueldo_base) || 0 };
}

async function remuneracionBase(idUsuario, hastaMes) {
  return (await remuneracionBaseDetalle(idUsuario, hastaMes)).base;
}

// Versión batch para pantallas de equipo (una sola pasada a BD) — misma cascada y mismo
// devengo (variable del mes = la pagada al mes siguiente), sin fallback al motor de
// comisiones: es una provisión, no un finiquito.
async function remuneracionBaseMapa() {
  const hasta = mesActual();
  const [fichas] = await pool.query(`SELECT f.id_usuario, f.sueldo_base, UPPER(REPLACE(u.rut,'.','')) rut FROM rh_fichas f JOIN usuarios u ON u.id_usuario=f.id_usuario`);
  const sb = {}, rutDe = {}; fichas.forEach(f => { sb[f.id_usuario] = Number(f.sueldo_base) || 0; rutDe[f.id_usuario] = f.rut || ''; });
  const [liqs] = await pool.query(
    `SELECT id_usuario, mes, total_imponible, detalle FROM rh_liquidaciones WHERE estado='EMITIDA' AND mes < ? ORDER BY mes DESC`, [hasta]);
  const det = l => { try { return typeof l.detalle === 'string' ? JSON.parse(l.detalle) : (l.detalle || {}); } catch (_) { return {}; } };
  const liqDe = {};
  for (const l of liqs) (liqDe[l.id_usuario] = liqDe[l.id_usuario] || {})[l.mes] = l;
  const acc = {};
  for (const [id, m] of Object.entries(liqDe)) {
    acc[id] = Object.keys(m).sort().reverse().slice(0, 3).map(mes => {
      const l = m[mes], sig = m[mesSig(mes)];
      return N(l.total_imponible) - N(det(l).comisiones) + (sig ? N(det(sig).comisiones) : N(det(l).comisiones));
    });
  }
  const [aux] = await pool.query(
    `SELECT UPPER(REPLACE(rut,'.','')) rut, mes, COALESCE(NULLIF(total_ganado,0), imponible) imponible, comisiones, semana_corrida, otros_imponibles
       FROM ctb_remun_aux WHERE mes <= ? AND imponible > 0 ORDER BY mes DESC`, [hasta]);
  const auxDe = {};
  for (const r of aux) (auxDe[r.rut] = auxDe[r.rut] || {})[r.mes] = r;
  const accAux = {};
  for (const [rut, m] of Object.entries(auxDe)) {
    accAux[rut] = Object.keys(m).filter(x => x < hasta).sort().reverse().slice(0, 3).map(mes => {
      const r = m[mes], sig = m[mesSig(mes)];
      const varProp = N(r.comisiones) + N(r.semana_corrida) + N(r.otros_imponibles);
      const varSig = sig ? N(sig.comisiones) + N(sig.semana_corrida) + N(sig.otros_imponibles) : null;
      return varSig ? N(r.imponible) - varProp + varSig : N(r.imponible);
    });
  }
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
