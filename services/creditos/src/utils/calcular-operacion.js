/**
 * calcular-operacion.js
 * Calcula ingresos y comisiones automáticamente al guardar una operación.
 * Usa los parámetros configurables de `parametros_credito`.
 */
'use strict';

const pool = require('../../../../shared/config/database');

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

/* ── Tabla de comisión dealer por plazo ─────────────────────────────── */
function getDealerPct(plazo, p) {
  if (plazo <= 6)  return p.dealer_pct_6  / 100;
  if (plazo <= 12) return p.dealer_pct_12 / 100;
  if (plazo <= 24) return p.dealer_pct_24 / 100;
  if (plazo <= 36) return p.dealer_pct_36 / 100;
  return p.dealer_pct_99 / 100;
}
function getDealerCallePct(plazo, p) {
  // Usa parámetro independiente dealer_calle_pct_X; fallback a parque+patio
  const patio = (p.patio_pct || 0) / 100;
  const fb = getDealerPct(plazo, p) + patio;
  if (plazo <= 6)  return p.dealer_calle_pct_6  != null ? p.dealer_calle_pct_6  / 100 : fb;
  if (plazo <= 12) return p.dealer_calle_pct_12 != null ? p.dealer_calle_pct_12 / 100 : fb;
  if (plazo <= 24) return p.dealer_calle_pct_24 != null ? p.dealer_calle_pct_24 / 100 : fb;
  if (plazo <= 36) return p.dealer_calle_pct_36 != null ? p.dealer_calle_pct_36 / 100 : fb;
  return p.dealer_calle_pct_99 != null ? p.dealer_calle_pct_99 / 100 : fb;
}

/* ── Tabla de comisión por dealer (su pactada; manda sobre la pizarra) ─── */
const normRutD = r => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();
// Tramo de la tabla del dealer (pct/100) o null si no tiene ese tramo (→ fallback pizarra).
function dealerTablePct(d, plazo) {
  if (!d) return null;
  const v = plazo <= 12 ? d.com_6_12 : plazo <= 24 ? d.com_13_24 : plazo <= 36 ? d.com_25_36 : d.com_37;
  return (v == null || v === '') ? null : Number(v) / 100;
}

/* ── Cargar tramos de comisión por penetración ──────────────────────── */
async function cargarPenTramos() {
  const [rows] = await pool.query(
    'SELECT tipo, pen_min, pct_comision FROM comisiones_seguro_penetracion WHERE estado="activo" ORDER BY tipo, pen_min'
  );
  return rows;
}

/* Dado el % de penetración, retorna el pct_comision del tramo más alto alcanzado */
function getPenComision(tipo, pen, tramos) {
  const filas = tramos.filter(r => r.tipo === tipo && parseFloat(pen) >= parseFloat(r.pen_min));
  if (!filas.length) return 0;
  const best = filas.reduce((a, b) => parseFloat(a.pen_min) > parseFloat(b.pen_min) ? a : b);
  return parseFloat(best.pct_comision) / 100;
}

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
      const [drows] = await pool.query(
        "SELECT com_6_12, com_13_24, com_25_36, com_37 FROM dealers WHERE UPPER(REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','')) = ? LIMIT 1",
        [normRutD(op.rut_dealer)]);
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
  let comdea_real        = 0;
  let com_parque_calc    = 0;
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

  // ── 2. Ingreso por seguros — comisión según tramo de penetración ──────
  // pen_rdh/cesantia/reparacion deben venir en op (calculados previamente por mes)
  // com_rdh          = seguro_rdh       × pct_comision(pen_rdh)
  // com_cesantia     = seguro_cesantia  × pct_comision(pen_cesantia)
  // com_reparaciones = seguro_rep_menor × pct_comision(pen_reparacion)
  if (plazo > 0) {
    const pctRdh  = getPenComision('rdh',        op.pen_rdh          ?? 0, tramos);
    const pctCes  = getPenComision('cesantia',   op.pen_cesantia     ?? 0, tramos);
    const pctRep  = getPenComision('reparacion', op.pen_reparaciones ?? 0, tramos);
    com_rdh          = Math.round(pctRdh  * primaRDH);
    com_cesantia     = Math.round(pctCes  * primaCesantia);
    com_reparaciones = Math.round(pctRep  * (parseFloat(op.seguro_rep_menor) || 0));
  }

  // ── 3. Comisión dealer ─────────────────────────────────────────────
  // La tabla pactada del dealer manda; si no tiene ese tramo, cae a la pizarra.
  // El patio del parque sigue siendo global (patio_pct).
  if (saldo_precio > 0 && plazo > 0) {
    const patio_pct = p.patio_pct / 100;
    const dPct      = dealerTablePct(dealerCom, plazo);
    const baseParque = dPct != null ? dPct : getDealerPct(plazo, p);
    const baseCalle  = dPct != null ? dPct : getDealerCallePct(plazo, p);
    comdea_real     = esParque
      ? Math.round(saldo_precio * baseParque)
      : Math.round(saldo_precio * baseCalle);
    com_parque_calc = esParque ? Math.round(saldo_precio * patio_pct) : 0;
  }

  // ── 4. Comisión ejecutivo ──────────────────────────────────────────
  if (monto_fin > 0) {
    comej = Math.round(monto_fin * (p.pct_ejecutivo_fin / 100));
  }

  // ── 5. Ingreso neto total ──────────────────────────────────────────
  const com_seguros_total  = com_rdh + com_cesantia + com_reparaciones;
  const ingreso_neto_total = monto_comision_fin + com_seguros_total
                           - comdea_real - com_parque_calc;

  return {
    monto_comision_fin,
    com_rdh,
    com_cesantia,
    com_reparaciones,
    comdea_real,
    com_parque:        com_parque_calc,
    comej,
    ingreso_neto_total,
    com_seguros_total,
  };
}

module.exports = { calcularOperacion };
