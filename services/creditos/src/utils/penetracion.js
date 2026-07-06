'use strict';
/**
 * penetracion.js — MOTOR ÚNICO de penetración de seguros.
 *
 * Penetración de cada seguro = % de operaciones AUTOFIN del mes con prima > 0 en ese
 * seguro, sobre el universo que PODÍA tomarlo. Define el % de comisión que AutoFácil
 * recibe por colocar seguros (a mayor penetración, mayor pago de AutoFin).
 *
 * Universo (denominador) por seguro — solo AUTOFIN:
 *   - rdh (Desgravamen + RDH): excluye EMPRESA
 *   - cesantia:                excluye EMPRESA e INDEPENDIENTE
 *   - reparacion:              todas las AUTOFIN
 * Numerador = los del universo con prima > 0 en ese seguro.
 *
 * Lo usan tanto el guardado (calcular-operacion.js) como el recálculo (recalcular-mes.js),
 * para que la penetración nunca diverja entre ambos.
 */
const pool = require('../../../../shared/config/database');

// tipo_trabajador que cuentan como INDEPENDIENTE (excluidos de cesantía).
// HOY el campo casi no se captura en AUTOFIN → la exclusión queda dormida hasta
// que exista el dato; la regla ya está lista para activarse sola.
const INDEPENDIENTE = new Set(['independiente', 'honorarios', 'empresario']);

const num = v => parseFloat(v) || 0;

/* ── Tramos de comisión por penetración (mantenedor comisiones_seguro) ──
   Modelo AutoFin 2026-07 (lámina "Cumplimiento Seguros"): el % de traspaso del
   mes (20/30/40%) lo define el TRAMO ALCANZADO POR EL SEGURO MÁS DÉBIL de los
   tres (mín. entre RDH, cesantía y reparaciones), y se aplica PAREJO a las
   primas de todos. Verificado: mayo 98/76/64 → 40%; junio 100/55,8/48,1 → 30%
   (reparaciones en tramo 40-49 arrastró el mes a 30%). */
let _pctTraspaso = 0.30; // fallback si la tabla de tramos está vacía
async function cargarPenTramos() {
  try {
    const [[p]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='seg_pct_traspaso_autofin' LIMIT 1");
    if (p && parseFloat(p.valor) > 0) _pctTraspaso = parseFloat(p.valor) / 100;
  } catch (e) { /* mantiene default 30% */ }
  const [rows] = await pool.query(
    'SELECT tipo, pen_min, pct_comision FROM comisiones_seguro_penetracion WHERE estado="activo" ORDER BY tipo, pen_min'
  );
  return rows;
}

/* % de traspaso del MES = mínimo de los tramos alcanzados por los 3 seguros. */
function pctTraspasoMes(pen, tramos) {
  if (!tramos || !tramos.length) return _pctTraspaso;
  return Math.min(
    getPenComision('rdh',        pen.pen_rdh,          tramos),
    getPenComision('cesantia',   pen.pen_cesantia,     tramos),
    getPenComision('reparacion', pen.pen_reparaciones, tramos),
  );
}

/* Dado el % de penetración (0–100), retorna el pct_comision (fracción) del tramo más alto alcanzado */
function getPenComision(tipo, pen, tramos) {
  const filas = tramos.filter(r => r.tipo === tipo && num(pen) >= num(r.pen_min));
  if (!filas.length) return 0;
  const best = filas.reduce((a, b) => num(a.pen_min) > num(b.pen_min) ? a : b);
  return num(best.pct_comision) / 100;
}

/* ── Penetración mensual por seguro (AUTOFIN). Devuelve % 0–100 ─────────── */
async function calcularPenetracionMes(mes) {
  const mesStr = (mes instanceof Date ? mes.toISOString() : String(mes)).slice(0, 7);
  const [ops] = await pool.query(`
    SELECT c.seguro_rdh, c.seguro_cesantia, c.seguro_rep_menor,
           cl.tipo_cliente,
           (SELECT al.tipo_trabajador FROM antecedentes_laborales al
              WHERE al.rut_cliente = cl.rut LIMIT 1) AS tipo_trabajador
    FROM creditos c
    LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
    WHERE DATE_FORMAT(c.mes, '%Y-%m') = ?
      AND UPPER(c.financiera) LIKE '%AUTOFIN%'
      AND c.estado IN ('OTORGADO', 'APROBADO')  -- cursadas: mismo universo del cierre de AutoFin (antes: todas las no rechazadas, diluía la penetración)
  `, [mesStr]);

  const esEmpresa = o => String(o.tipo_cliente || '').toUpperCase() === 'EMPRESA';
  const esIndep   = o => INDEPENDIENTE.has(String(o.tipo_trabajador || '').toLowerCase().trim());
  const pct = (n, d) => d > 0 ? (n / d) * 100 : 0;

  // RDH/Desgravamen: excluye EMPRESA
  const uRdh = ops.filter(o => !esEmpresa(o));
  const nRdh = uRdh.filter(o => num(o.seguro_rdh) > 0).length;
  // Cesantía: excluye EMPRESA e INDEPENDIENTE
  const uCes = ops.filter(o => !esEmpresa(o) && !esIndep(o));
  const nCes = uCes.filter(o => num(o.seguro_cesantia) > 0).length;
  // Reparaciones: todas las AUTOFIN
  const uRep = ops;
  const nRep = uRep.filter(o => num(o.seguro_rep_menor) > 0).length;

  return {
    pen_rdh:          pct(nRdh, uRdh.length),
    pen_cesantia:     pct(nCes, uCes.length),
    pen_reparaciones: pct(nRep, uRep.length),
  };
}

/* ── Comisión de seguros de una op = prima × % traspaso del mes (parejo) ──
   El % del mes sale del tramo del seguro más débil (pctTraspasoMes). */
function comisionesSeguro(op, pen, tramos) {
  const pct = pctTraspasoMes(pen, tramos);
  return {
    com_rdh:          Math.round(num(op.seguro_rdh)       * pct),
    com_cesantia:     Math.round(num(op.seguro_cesantia)  * pct),
    com_reparaciones: Math.round(num(op.seguro_rep_menor) * pct),
  };
}

module.exports = { cargarPenTramos, getPenComision, calcularPenetracionMes, comisionesSeguro };
