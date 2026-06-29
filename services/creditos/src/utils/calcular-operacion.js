/**
 * calcular-operacion.js
 * Calcula ingresos y comisiones automáticamente al guardar una operación.
 * Usa los parámetros configurables de `parametros_credito`.
 */
'use strict';

const pool = require('../../../../shared/config/database');
const { cargarPenTramos, calcularPenetracionMes, comisionesSeguro } = require('./penetracion');
const { comisionDealer } = require('./comision-dealer');

/* ── Cargar todos los parámetros del mantenedor ─────────────────────── */
async function cargarParams() {
  const [rows] = await pool.query(
    'SELECT clave, valor FROM parametros_credito'
  );
  const p = {};
  rows.forEach(r => { p[r.clave] = parseFloat(r.valor); });
  return p;
}

/* ── Obtener UF de una fecha ────────────────────────────────────────── */
async function getUF(fecha) {
  if (!fecha) return null;
  const f = fecha.toString().slice(0, 10);
  const [rows] = await pool.query(
    'SELECT valor FROM uf WHERE fecha = ? LIMIT 1', [f]
  );
  return rows.length ? parseFloat(rows[0].valor) : null;
}

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
  const p      = await cargarParams();
  const tramos = await cargarPenTramos();
  const uf     = await getUF(op.fecha_otorgado);

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

  // ── 1. Ingreso por tasa ────────────────────────────────────────────
  if (plazo > 0 && monto_fin > 0) {
    if (financiera.includes('AUTOFIN') || financiera.includes('AUTOF')) {
      // AutoFin: PV spread — usa monto_capitalizado como base
      const tmc_menor = (p.autofin_tmc_menor_200 / 100) / 12; // mensual
      const tmc_mayor = (p.autofin_tmc_mayor_200 / 100) / 12;
      const spread    = (p.autofin_spread_fondo  / 100);       // mensual
      const costo_fondo = tmc_mayor - spread;                  // 1.78% fijo
      const limite_200  = uf ? (p.umbral_uf_tramo || 200) * uf : null;
      const tasa_cli    = (limite_200 && monto_cap > limite_200) ? tmc_mayor : tmc_menor;

      if (tasa_cli > 0 && costo_fondo > 0) {
        const cuota = monto_cap * tasa_cli * Math.pow(1 + tasa_cli, plazo)
                    / (Math.pow(1 + tasa_cli, plazo) - 1);
        const pv = cuota * (1 - Math.pow(1 + costo_fondo, -plazo)) / costo_fondo;
        monto_comision_fin = Math.round(pv - monto_cap);
      }
    } else if (financiera.includes('UNIDAD') || financiera.includes('UAC')) {
      // UAC: % del saldo precio según volumen del mes
      const ops = await contarOpsUAC(op.mes);
      let pct = p.uac_pct_tier1 / 100;
      if (ops >= p.uac_ops_tier2_max) pct = p.uac_pct_tier3 / 100;
      else if (ops >= p.uac_ops_tier1_max) pct = p.uac_pct_tier2 / 100;
      monto_comision_fin = Math.round(saldo_precio * pct);
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

  // ── 4. Comisión ejecutivo ──────────────────────────────────────────
  if (monto_fin > 0) {
    comej = Math.round(monto_fin * (p.pct_ejecutivo_fin / 100));
  }

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
