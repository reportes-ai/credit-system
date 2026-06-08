'use strict';
/**
 * recalcular-mes.js
 * Recalcula TODOS los campos financieros de las operaciones de uno o varios meses:
 *   - monto_comision_fin  (Ing x Colocaciones)
 *   - comdea_real         (Comisión Dealer)
 *   - com_parque          (Comisión Parque)
 *   - arriendo_parque     (Arriendo Parque)
 *   - com_rdh / com_cesantia / com_reparaciones  (Ing x Seguros)
 *   - ingreso_neto_total
 *
 * Para UNIDAD/UAC aplica la lógica de tiers por mes y recalcula TODAS las ops
 * del mes si el tier cambia al agregar nuevas operaciones.
 *
 * Uso:
 *   const { recalcularMeses } = require('../utils/recalcular-mes');
 *   await recalcularMeses(['2026-06']);   // array de strings YYYY-MM
 */

const pool = require('../../../../shared/config/database');

/* ── Parámetros configurables ───────────────────────────────────────── */
async function cargarParams() {
  const [rows] = await pool.query('SELECT clave, valor FROM parametros_credito');
  const p = {};
  rows.forEach(r => { p[r.clave] = parseFloat(r.valor); });
  return p;
}

/* ── UF de una fecha ────────────────────────────────────────────────── */
async function getUF(fecha) {
  if (!fecha) return null;
  const f = fecha.toString().slice(0, 10);
  const [rows] = await pool.query('SELECT valor FROM uf WHERE fecha = ? LIMIT 1', [f]);
  return rows.length ? parseFloat(rows[0].valor) : null;
}

/* ── Comisión dealer por plazo ──────────────────────────────────────── */
function getDealerPct(plazo, p) {
  if (plazo <= 6)  return (p.dealer_pct_6  || 0) / 100;
  if (plazo <= 12) return (p.dealer_pct_12 || 0) / 100;
  if (plazo <= 24) return (p.dealer_pct_24 || 0) / 100;
  if (plazo <= 36) return (p.dealer_pct_36 || 0) / 100;
  return (p.dealer_pct_99 || 0) / 100;
}
function getDealerCallePct(plazo, p) {
  if (plazo <= 6)  return (p.dealer_calle_pct_6  != null ? p.dealer_calle_pct_6  : (p.dealer_pct_6  || 0) + (p.patio_pct || 0)) / 100;
  if (plazo <= 12) return (p.dealer_calle_pct_12 != null ? p.dealer_calle_pct_12 : (p.dealer_pct_12 || 0) + (p.patio_pct || 0)) / 100;
  if (plazo <= 24) return (p.dealer_calle_pct_24 != null ? p.dealer_calle_pct_24 : (p.dealer_pct_24 || 0) + (p.patio_pct || 0)) / 100;
  if (plazo <= 36) return (p.dealer_calle_pct_36 != null ? p.dealer_calle_pct_36 : (p.dealer_pct_36 || 0) + (p.patio_pct || 0)) / 100;
  return (p.dealer_calle_pct_99 != null ? p.dealer_calle_pct_99 : (p.dealer_pct_99 || 0) + (p.patio_pct || 0)) / 100;
}

/* ── Comisión seguro por penetración ────────────────────────────────── */
function getPenComision(tipo, pen, tramos) {
  const filas = tramos.filter(r => r.tipo === tipo && parseFloat(pen) >= parseFloat(r.pen_min));
  if (!filas.length) return 0;
  const best = filas.reduce((a, b) => parseFloat(a.pen_min) > parseFloat(b.pen_min) ? a : b);
  return parseFloat(best.pct_comision) / 100;
}

/* ── Tramos de penetración activos ──────────────────────────────────── */
async function cargarPenTramos() {
  const [rows] = await pool.query(
    'SELECT tipo, pen_min, pct_comision FROM comisiones_seguro_penetracion WHERE estado="activo" ORDER BY tipo, pen_min'
  );
  return rows;
}

/* ── Comisión parque desde tabla parques_comisiones ─────────────────── */
async function cargarParques() {
  const [rows] = await pool.query(
    'SELECT nombre, arriendo, comision_pct FROM parques_comisiones WHERE activo = 1'
  );
  const map = {};
  rows.forEach(r => { map[r.nombre.toUpperCase().trim()] = r; });
  return map;
}

/* ── Tier UNIDAD ────────────────────────────────────────────────────── */
function getTierUAC(cnt, p) {
  if (cnt >= (p.uac_ops_tier3_max || 15)) return (p.uac_pct_tier4 || p.uac_pct_tier3) / 100;
  if (cnt >= (p.uac_ops_tier2_max || 10)) return (p.uac_pct_tier3 || 18) / 100;
  if (cnt >= (p.uac_ops_tier1_max ||  5)) return (p.uac_pct_tier2 || 16) / 100;
  return (p.uac_pct_tier1 || 14) / 100;
}


/* ═══════════════════════════════════════════════════════════════════════
   recalcularMeses(meses, opciones)
   meses   : array de strings 'YYYY-MM'
   opciones: { soloFinancieras: ['AUTOFIN','UNIDAD DE CREDITO'] }
   ═══════════════════════════════════════════════════════════════════════ */
async function recalcularMeses(meses, opciones = {}) {
  if (!meses || !meses.length) return { actualizados: 0, log: [] };

  const [p, parqMap] = await Promise.all([
    cargarParams(),
    cargarParques(),
  ]);

  let actualizados = 0;
  const log = [];

  for (const mesStr of meses) {
    // ── Traer todas las ops del mes (estados activos) ────────────────
    const [ops] = await pool.query(`
      SELECT id, num_op, financiera, parque,
             saldo_precio, monto_financiado, monto_capitalizado,
             plazo, fecha_otorgado, mes,
             seguro_rdh, seguro_cesantia, seguro_rep_menor,
             com_rdh, com_cesantia, com_reparaciones,
             tascli_real
      FROM creditos
      WHERE DATE_FORMAT(mes, '%Y-%m') = ?
        AND estado_eval NOT IN ('RECHAZADO','ANULADO')
    `, [mesStr]);

    if (!ops.length) continue;

    // ── Conteo UAC (penetración de seguros no se recalcula aquí) ────
    // Las comisiones de seguros (com_rdh/cesantia/rep) vienen del Excel
    // y se leen desde BD sin modificarse.

    // ── Conteo UAC del mes ──────────────────────────────────────────
    const cntUAC = ops.filter(r =>
      (r.financiera || '').toUpperCase().includes('UNIDAD') ||
      (r.financiera || '').toUpperCase().includes('UAC')
    ).length;
    const pctUAC = getTierUAC(cntUAC, p);

    log.push(`Mes ${mesStr}: ${ops.length} ops | UAC=${cntUAC} (${(pctUAC*100).toFixed(0)}%)`);

    // ── Paso 3: recalcular cada op ───────────────────────────────────
    for (const op of ops) {
      const fin       = (op.financiera || '').toUpperCase();
      const parqKey   = (op.parque || '').toUpperCase().trim();
      const esParque  = parqKey.includes('PARQUE');
      const esUAC     = fin.includes('UNIDAD') || fin.includes('UAC');
      const esAF      = fin.includes('AUTOFIN') || fin.includes('AUTOF');

      const saldo    = parseFloat(op.saldo_precio)       || 0;
      const montoFin = parseFloat(op.monto_financiado)   || 0;
      const montoCap = parseFloat(op.monto_capitalizado) || montoFin;
      const plazo    = parseInt(op.plazo)                || 0;

      let monto_comision_fin = 0;

      // 1. Ing x Colocaciones ─────────────────────────────────────────
      if (plazo > 0) {
        if (esUAC && saldo > 0) {
          monto_comision_fin = Math.round(saldo * pctUAC);

        } else if (esAF && montoCap > 0) {
          const uf          = await getUF(op.fecha_otorgado);
          const tmc_menor   = (p.autofin_tmc_menor_200 / 100) / 12;
          const tmc_mayor   = (p.autofin_tmc_mayor_200 / 100) / 12;
          const spread      = (p.autofin_spread_fondo  / 100);
          const costo_fondo = tmc_mayor - spread;
          const limite_200  = uf ? 200 * uf : null;
          const tasa_cli    = (limite_200 && montoCap > limite_200) ? tmc_mayor : tmc_menor;
          if (tasa_cli > 0 && costo_fondo > 0) {
            const cuota = montoCap * tasa_cli * Math.pow(1 + tasa_cli, plazo)
                        / (Math.pow(1 + tasa_cli, plazo) - 1);
            const pv = cuota * (1 - Math.pow(1 + costo_fondo, -plazo)) / costo_fondo;
            monto_comision_fin = Math.round(pv - montoCap);
          }
        }
      }

      // 2. Comisiones de seguros — vienen del Excel (leídas desde BD) ──
      // No se recalculan aquí. Se usan para ingreso_neto_total.
      const com_rdh          = parseFloat(op.com_rdh)          || 0;
      const com_cesantia     = parseFloat(op.com_cesantia)     || 0;
      const com_reparaciones = parseFloat(op.com_reparaciones) || 0;

      // 3. Comisión Dealer ────────────────────────────────────────────
      let comdea_real    = 0;
      let com_parque_val = 0;
      let arriendo_val   = 0;

      if (saldo > 0 && plazo > 0) {
        if (esParque) {
          const parqData = parqMap[parqKey];
          const patioPct = parqData ? parseFloat(parqData.comision_pct) : (p.patio_pct / 100);
          arriendo_val   = parqData ? parseFloat(parqData.arriendo) || 0 : 0;
          comdea_real    = Math.round(saldo * getDealerPct(plazo, p));
          com_parque_val = Math.round(saldo * patioPct);
        } else {
          comdea_real    = Math.round(saldo * getDealerCallePct(plazo, p));
          com_parque_val = 0;
          arriendo_val   = 0;
        }
      }

      // 4. Ingreso neto total ─────────────────────────────────────────
      const com_seguros_total  = com_rdh + com_cesantia + com_reparaciones;
      const ingreso_neto_total = monto_comision_fin + com_seguros_total
                               - comdea_real - com_parque_val - arriendo_val;

      // 5. UPDATE ─────────────────────────────────────────────────────
      await pool.query(`
        UPDATE creditos SET
          monto_comision_fin  = ?,
          comdea_real         = ?,
          com_parque          = ?,
          arriendo_parque     = ?,
          ingreso_neto_total  = ?,
          updated_at          = NOW()
        WHERE id = ?
      `, [
        monto_comision_fin,
        comdea_real,
        com_parque_val,
        arriendo_val,
        ingreso_neto_total,
        op.id,
      ]);

      actualizados++;
    }
  }

  return { actualizados, log };
}

/* ── Extraer meses únicos de una lista de ops ───────────────────────── */
function extraerMeses(ops) {
  const set = new Set();
  for (const op of ops) {
    const mes = op.mes || op.fecha_otorgado;
    if (mes) set.add(String(mes).slice(0, 7));
  }
  return [...set];
}

module.exports = { recalcularMeses, extraerMeses };
