/**
 * calcular-operacion.js
 * Calcula ingresos y comisiones automáticamente al guardar una operación.
 * Usa los parámetros configurables de `parametros_credito`.
 */
'use strict';

const pool = require('../../../../shared/config/database');
const { cargarPenTramos, calcularPenetracionMes, comisionesSeguro } = require('./penetracion');
const { comisionDealer } = require('./comision-dealer');
const core = require('../../../../api-gateway/public/js/rentabilidad-core');
const { cargarTasas, getTasaByFecha } = require('./recalcular-mes');
const { getUF } = require('../../../../shared/uf');

/* ── Cargar todos los parámetros del mantenedor ─────────────────────── */
async function cargarParams() {
  const [rows] = await pool.query(
    'SELECT clave, valor FROM parametros_credito'
  );
  const p = {};
  rows.forEach(r => { p[r.clave] = parseFloat(r.valor); });
  return p;
}

/* getUF (UF vigente a una fecha) vive en ../../../../shared/uf.js (motor único). */

/* La pizarra de comisión dealer (parque/calle) vive en ./comision-dealer.js (motor único). */

/* ── Tabla de comisión por dealer (su pactada; manda sobre la pizarra) ─── */
const normRutD = r => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();
// dealerTablePct vive en ./comision-dealer.js (motor único).

/* cargarPenTramos, getPenComision y la penetración mensual viven en ./penetracion.js (motor único). */

/* ── Contar operaciones UAC otorgadas/aprobadas en el mes ───────────── */
async function contarOpsUAC(mes) {
  if (!mes) return 0;
  const mesStr = typeof mes === 'string' ? mes.slice(0, 7) : mes.toISOString().slice(0, 7);
  const [rows] = await pool.query(`
    SELECT COUNT(*) AS cnt FROM creditos
    WHERE DATE_FORMAT(mes,'%Y-%m') = ?
      AND (financiera LIKE '%UNIDAD%' OR financiera LIKE '%UAC%')
      AND estado_credito IN ('OTORGADO','APROBADO')
  `, [mesStr]);
  return parseInt(rows[0]?.cnt) || 0;
}

/* ── CÁLCULO PRINCIPAL ──────────────────────────────────────────────── */
async function calcularOperacion(op) {
  const p          = await cargarParams();
  const tramos     = await cargarPenTramos();
  const uf         = await getUF(op.fecha_otorgado);
  const todasTasas = await cargarTasas();

  // Tabla de comisión del dealer (su pactada): manda sobre la pizarra cuando existe.
  let dealerCom = null;
  if (op.rut_dealer) {
    try {
      let drows;
      try {
        drows = (await pool.query(
          "SELECT com_6_12, com_13_24, com_25_36, com_37, com_parque_6_12, com_parque_13_24, com_parque_25_36, com_parque_37 FROM dealers WHERE UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','')) = ? LIMIT 1",
          [normRutD(op.rut_dealer)]))[0];
      } catch (e) {
        drows = (await pool.query(
          "SELECT com_6_12, com_13_24, com_25_36, com_37 FROM dealers WHERE UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','')) = ? LIMIT 1",
          [normRutD(op.rut_dealer)]))[0];
      }
      dealerCom = drows[0] || null;
    } catch (e) { dealerCom = null; }   // columnas aún no creadas → cae a la pizarra
  }

  const saldo_precio  = parseFloat(op.saldo_precio)    || 0;
  const monto_fin     = parseFloat(op.monto_financiado)   || 0;
  const monto_cap     = parseFloat(op.monto_capitalizado) || monto_fin; // AutoFin usa capitalizado
  const plazo         = parseInt(op.plazo)              || 0;
  const financiera    = (op.financiera || '').toUpperCase();
  const parqueVal     = (op.parque || '').toUpperCase().trim();
  const esParque      = parqueVal.includes('PARQUE');

  // Primas de seguros
  const primaRDH      = parseFloat(op.seguro_rdh)       || 0;
  const primaCesantia = parseFloat(op.seguro_cesantia)  || 0;

  let monto_comision_fin = 0;
  let com_rdh            = 0;
  let com_cesantia       = 0;
  let com_reparaciones   = 0;
  let pen_rdh = null, pen_cesantia = null, pen_reparaciones = null;
  let comdea_real        = 0;
  let com_parque_calc    = 0;
  let arriendo_parque_calc = 0;
  let comej              = 0;

  // ── 1. Ingreso por tasa — MOTOR ÚNICO rentabilidad-core ─────────────
  if (plazo > 0 && monto_fin > 0) {
    if (financiera.includes('AUTOFIN') || financiera.includes('AUTOF')) {
      // AutoFin: VP del spread. Tasa del MANTENEDOR a la fecha de otorgamiento (tramo
      // >/≤200 UF) define el costo de fondo; la tasa CLIENTE (tascli_real) MANDA para la
      // cuota, con default al mantenedor. Mismo criterio que el recálculo mensual.
      const tasa = getTasaByFecha(op.fecha_otorgado, todasTasas);
      if (tasa) {
        const mayor      = core.esMayor200({ montoCap: monto_cap, uf, umbralUf: p.umbral_uf_tramo });
        const mantTasa   = mayor ? parseFloat(tasa.tasa_mensual_mayor) : parseFloat(tasa.tasa_mensual_menor);
        const mantSpread = mayor ? parseFloat(tasa.spread_mayor)       : parseFloat(tasa.spread_menor);
        const costoFondo = (mantTasa - mantSpread) / 100;
        const real    = parseFloat(op.tascli_real) || 0;
        const tasaCli = (real > 0 ? real : mantTasa) / 100;
        monto_comision_fin = core.ingresoColocacionAutoFin({ montoCap: monto_cap, plazo, tasaCli, costoFondo });
      }
    } else if (financiera.includes('UNIDAD') || financiera.includes('UAC')) {
      // UAC: % del saldo precio según volumen del mes
      const ops = await contarOpsUAC(op.mes);
      let pct = p.uac_pct_tier1 / 100;
      if (ops >= p.uac_ops_tier2_max) pct = p.uac_pct_tier3 / 100;
      else if (ops >= p.uac_ops_tier1_max) pct = p.uac_pct_tier2 / 100;
      monto_comision_fin = core.ingresoColocacionUAC({ saldo: saldo_precio, pctUAC: pct });
    }
  }

  // ── 2. Ingreso por seguros — comisión según la PENETRACIÓN del mes ────
  // Penetración mensual real (motor penetracion.js), no el campo pen_* del op
  // (que venía vacío y dejaba la comisión en 0). com_x = prima × pct_comision(tramo).
  if (plazo > 0 && financiera.includes('AUTOFIN')) {
    const penMes = await calcularPenetracionMes(op.mes);
    const cs = comisionesSeguro(op, penMes, tramos);
    com_rdh          = cs.com_rdh;
    com_cesantia     = cs.com_cesantia;
    com_reparaciones = cs.com_reparaciones;
    pen_rdh = penMes.pen_rdh; pen_cesantia = penMes.pen_cesantia; pen_reparaciones = penMes.pen_reparaciones;
  }

  // ── 3. Comisión dealer y parque — motor único comision-dealer.js ────
  // La tabla pactada del dealer manda; si no, pizarra. El parque (arriendo + %) sale
  // del mantenedor parques_comisiones (mismo origen que el recálculo), no de patio_pct.
  if (saldo_precio > 0 && plazo > 0) {
    let parqData = null;
    if (esParque) {
      try {
        const [pr] = await pool.query(
          'SELECT arriendo, comision_pct FROM parques_comisiones WHERE activo=1 AND UPPER(TRIM(nombre)) = ? LIMIT 1',
          [parqueVal]);
        parqData = pr[0] || null;
      } catch (e) { /* sin tabla → el motor cae a patio_pct */ }
    }
    const cd = comisionDealer({ saldo: saldo_precio, plazo, esParque }, { dealerTabla: dealerCom, parqData, pizarra: p });
    comdea_real          = cd.comdea_real;
    com_parque_calc      = cd.com_parque;
    arriendo_parque_calc = cd.arriendo;
  }

  // ── 4. Comisión ejecutivo — motor único ────────────────────────────
  comej = core.comisionEjecutivo({ montoFin: monto_fin, pctEj: (p.pct_ejecutivo_fin || 0) / 100 });

  // ── 5. Ingreso neto total ──────────────────────────────────────────
  const com_seguros_total  = com_rdh + com_cesantia + com_reparaciones;
  const ingreso_neto_total = monto_comision_fin + com_seguros_total
                           - comdea_real - com_parque_calc - arriendo_parque_calc;

  return {
    monto_comision_fin,
    com_rdh,
    com_cesantia,
    com_reparaciones,
    pen_rdh,
    pen_cesantia,
    pen_reparaciones,
    comdea_real,
    com_parque:        com_parque_calc,
    arriendo_parque:   arriendo_parque_calc,
    comej,
    ingreso_neto_total,
    com_seguros_total,
  };
}

module.exports = { calcularOperacion };
