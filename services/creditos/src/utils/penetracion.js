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
  try {
    const [ov] = await pool.query('SELECT mes, pct FROM comisiones_seguro_pct_mes');
    _overrides = {};
    ov.forEach(r => { _overrides[String(r.mes).slice(0, 7)] = parseFloat(r.pct) / 100; });
  } catch (e) { /* tabla puede no existir aún */ }
  const [rows] = await pool.query(
    'SELECT tipo, pen_min, pct_comision FROM comisiones_seguro_penetracion WHERE estado="activo" ORDER BY tipo, pen_min'
  );
  return rows;
}

/* % de traspaso del MES = mínimo de los tramos alcanzados por los 3 seguros.
   Si existe un % INFORMADO por AutoFin para el mes (comisiones_seguro_pct_mes,
   cargado en _overrides), ese manda: el cierre oficial de AutoFin puede diferir
   de nuestra BD (ops/primas re-informadas) y ellos son los que pagan. */
let _overrides = {}; // 'YYYY-MM' → fracción (0.30)
function pctTraspasoMes(pen, tramos, mesKey) {
  if (mesKey && _overrides[mesKey] != null) return _overrides[mesKey];
  if (!tramos || !tramos.length) return _pctTraspaso;
  return Math.min(
    getPenComision('rdh',        pen.pen_rdh,          tramos),
    getPenComision('cesantia',   pen.pen_cesantia,     tramos),
    getPenComision('reparacion', pen.pen_reparaciones, tramos),
  );
}
const mesKeyDe = v => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 7);
  return String(v).slice(0, 7);
};

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
      -- Universo NCNU: AUTOFIN sin productos CORFO (mismo criterio que el motor
      -- de comisiones de ejecutivos — CORFO no mide seguros).
      AND UPPER(COALESCE(c.producto,'')) NOT LIKE '%CORFO%'
      -- cursadas: mismo universo del cierre de AutoFin. Algunos créditos traen el estado en
      -- estado_credito y NO en estado (queda NULL) → COALESCE para no vaciar el universo
      -- (si no, la penetración da 0% y la comisión de seguros queda en 0). Igual criterio que el dashboard.
      -- Solo OTORGADO: desde la sincronización con Trinidad (2026-07) las APROBADO son
      -- solicitudes aprobadas NO cursadas (sin seguros) y hundirían la penetración.
      AND COALESCE(NULLIF(c.estado, ''), c.estado_credito) = 'OTORGADO'
      -- Ops con los 3 seguros en 0 = SIN INFORMACIÓN de primas (la sincronización con
      -- Trinidad crea otorgados sin seguros hasta que se digitan). Se excluyen del
      -- universo: son dato faltante, no cliente que rechazó todo (desgravamen ~100%
      -- histórico; contarlas hundía RDH bajo el tramo mínimo y dejaba el mes en 0%).
      AND (COALESCE(c.seguro_rdh,0) + COALESCE(c.seguro_cesantia,0) + COALESCE(c.seguro_rep_menor,0)) > 0
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
   El % del mes sale del tramo del seguro más débil (pctTraspasoMes), salvo
   que exista un % informado por AutoFin para ese mes (override). */
function comisionesSeguro(op, pen, tramos) {
  const pct = pctTraspasoMes(pen, tramos, mesKeyDe(op.mes || op.fecha_otorgado));
  return {
    com_rdh:          Math.round(num(op.seguro_rdh)       * pct),
    com_cesantia:     Math.round(num(op.seguro_cesantia)  * pct),
    com_reparaciones: Math.round(num(op.seguro_rep_menor) * pct),
  };
}

module.exports = { cargarPenTramos, getPenComision, pctTraspasoMes, calcularPenetracionMes, comisionesSeguro };
