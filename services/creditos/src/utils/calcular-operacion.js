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

/* ── Factor de comisión de seguros por plazo ────────────────────────── */
function getSegCom(plazo, p) {
  if (plazo <= 6)  return { desg: p.seg_com_desg_6  / 100, cesa: p.seg_com_cesa_6  / 100 };
  if (plazo <= 12) return { desg: p.seg_com_desg_12 / 100, cesa: p.seg_com_cesa_12 / 100 };
  if (plazo <= 24) return { desg: p.seg_com_desg_24 / 100, cesa: p.seg_com_cesa_24 / 100 };
  return             { desg: p.seg_com_desg_36 / 100, cesa: p.seg_com_cesa_36 / 100 };
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
  const p   = await cargarParams();
  const uf  = await getUF(op.fecha_otorgado);

  const saldo_precio  = parseFloat(op.saldo_precio)    || 0;
  const monto_fin     = parseFloat(op.monto_financiado) || 0;
  const plazo         = parseInt(op.plazo)              || 0;
  const financiera    = (op.financiera || '').toUpperCase();
  const esParque      = !!(op.com_parque || (op.parque && op.parque !== 'NO APLICA'));

  // Seguros activos
  const primaDesg = parseFloat(op.seguro_rdh)     || 0; // campo seguro_rdh = desgravamen prima
  const primaRDH  = parseFloat(op.seguro_cesantia)|| 0; // campo seguro_cesantia = rdh prima
  const primaCesa = parseFloat(op.seguro_rep_menor)|| 0; // campo seguro_rep_menor = cesantia prima

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
      // AutoFin: PV spread
      const tmc_menor = (p.autofin_tmc_menor_200 / 100) / 12; // mensual
      const tmc_mayor = (p.autofin_tmc_mayor_200 / 100) / 12;
      const spread    = (p.autofin_spread_fondo  / 100);       // mensual
      const costo_fondo = tmc_mayor - spread;                  // 1.78% fijo
      const limite_200  = uf ? 200 * uf : null;
      const tasa_cli    = (limite_200 && monto_fin > limite_200) ? tmc_mayor : tmc_menor;

      if (tasa_cli > 0 && costo_fondo > 0) {
        const cuota = monto_fin * tasa_cli * Math.pow(1 + tasa_cli, plazo)
                    / (Math.pow(1 + tasa_cli, plazo) - 1);
        const pv = cuota * (1 - Math.pow(1 + costo_fondo, -plazo)) / costo_fondo;
        monto_comision_fin = Math.round(pv - monto_fin);
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

  // ── 2. Ingreso por seguros (UNIDAD/UAC no paga comisión de seguros) ──
  if (plazo > 0 && primaDesg > 0 && !financiera.includes('UNIDAD') && !financiera.includes('UAC')) {
    const { desg, cesa } = getSegCom(plazo, p);
    com_rdh      = Math.round(desg * primaDesg);  // comisión desgravamen
    com_cesantia = Math.round(cesa * primaDesg);  // comisión cesantía
    // RDH y reparaciones menores no generan comisión según el Excel
    com_reparaciones = 0;
  }

  // ── 3. Comisión dealer ─────────────────────────────────────────────
  if (saldo_precio > 0 && plazo > 0) {
    const dealer_pct = getDealerPct(plazo, p);
    const patio_pct  = p.patio_pct / 100;
    // Parque: dealer recibe dealer_pct, parque recibe patio_pct por separado
    // Calle:  dealer recibe dealer_pct solamente, sin descuento de parque
    comdea_real     = Math.round(saldo_precio * dealer_pct);
    com_parque_calc = esParque ? Math.round(saldo_precio * patio_pct) : 0;
  }

  // ── 4. Comisión ejecutivo ──────────────────────────────────────────
  if (monto_fin > 0) {
    comej = Math.round(monto_fin * (p.pct_ejecutivo_fin / 100));
  }

  // ── 5. Ingreso neto total ──────────────────────────────────────────
  const com_seguros_total = com_rdh + com_cesantia + com_reparaciones;
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
