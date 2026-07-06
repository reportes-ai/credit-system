const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { recalcularMesesAbiertos } = require('../../../creditos/src/utils/recalcular-mes');
// Cambiar un parámetro que afecta el cálculo dispara el recálculo de los meses
// abiertos (fire-and-forget, respeta los campos forzados).
const dispararRecalc = () => recalcularMesesAbiertos()
  .then(r => { if (r.actualizados) console.log(`[recalc auto] ${r.actualizados} ops recalculadas`); })
  .catch(e => console.error('[recalc auto]', e.message));

const ensureTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS parametros_credito (
      clave VARCHAR(50) PRIMARY KEY,
      valor DECIMAL(15,6) NOT NULL DEFAULT 0,
      descripcion VARCHAR(200),
      fecha_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  // Ampliar precisión si la columna tiene menos de 6 decimales
  try {
    await pool.query(`ALTER TABLE parametros_credito MODIFY COLUMN valor DECIMAL(15,6) NOT NULL DEFAULT 0`);
  } catch(e) { /* ignore */ }

  const defaults = [
    // Parámetros operacionales
    ['costo_fondo',            1.780000, 'Costo de fondo mensual (%)'],
    ['prenda',                 103610,   'Gasto de prenda ($)'],
    ['retiro_gestion',         0,        'Retiro gestión auto ($)'],
    ['limitacion_dominio',     5630,     'Limitación de dominio ($)'],
    ['gastos_admin',           0,        'Gastos de administración ($)'],
    ['inscripcion',            36030,    'Inscripción / transferencia ($)'],
    ['gps_24meses',            262255,   'GPS 24 meses ($)'],
    ['reparaciones_menores',   464796,   'Reparaciones menores ($)'],
    ['pct_ejecutivo',          2.720000, 'Comisión ejecutivo (% del saldo precio)'],
    // Tasas individuales de seguro por bracket de plazo (factor decimal sobre sub-total)
    // Factores de carga mensual sobre deuda (% aplicado al monto de la deuda)
    ['pct_arriendo',              20.000000, 'Porcentaje de renta destinado a arriendo (%)'],
    ['carga_deuda_vigente_total', 0.000000,  'Carga mensual — Deuda Vigente Total (%)'],
    ['carga_deuda_hipotecaria',   0.050000, 'Carga mensual — Deuda Hipotecaria (%)'],
    ['carga_deuda_comercial',     5.000000, 'Carga mensual — Deuda Comercial (%)'],
    ['carga_deuda_consumo',       3.500000, 'Carga mensual — Deuda Consumo (%)'],
    ['carga_deuda_morosa',        0.000000, 'Carga mensual — Deuda Morosa (%)'],
    ['carga_deuda_vencida',       0.050000, 'Carga mensual — Deuda Vencida (%)'],
    ['carga_deuda_castigada',     5.000000, 'Carga mensual — Deuda Castigada (%)'],
    ['carga_linea_disponible',    3.500000, 'Carga mensual — Línea Disponible (%)'],
    // Seguros — tasas de prima NOMINALES por tramo de plazo (modelo AutoFin 2026-07:
    // el desgravamen ya NO existe solo, va incluido en el RDH → seg_d_* = 0)
    ['seg_d_6',   0.000000, 'Seguro Desgravamen — EN DESUSO (incluido en RDH desde 2026-07)'],
    ['seg_r_6',   0.015200, 'Seguro RDH (incl. desgravamen) — plazo ≤6m'],
    ['seg_c_6',   0.034900, 'Seguro Cesantía — plazo ≤6m'],
    ['seg_d_12',  0.000000, 'Seguro Desgravamen — EN DESUSO (incluido en RDH desde 2026-07)'],
    ['seg_r_12',  0.015200, 'Seguro RDH (incl. desgravamen) — plazo ≤12m'],
    ['seg_c_12',  0.036500, 'Seguro Cesantía — plazo ≤12m'],
    ['seg_d_24',  0.000000, 'Seguro Desgravamen — EN DESUSO (incluido en RDH desde 2026-07)'],
    ['seg_r_24',  0.029600, 'Seguro RDH (incl. desgravamen) — plazo 13-24m'],
    ['seg_c_24',  0.040400, 'Seguro Cesantía — plazo 13-24m'],
    ['seg_d_36',  0.000000, 'Seguro Desgravamen — EN DESUSO (incluido en RDH desde 2026-07)'],
    ['seg_r_36',  0.038700, 'Seguro RDH (incl. desgravamen) — plazo 25-36m'],
    ['seg_c_36',  0.045000, 'Seguro Cesantía — plazo 25-36m'],
    ['seg_d_48',  0.000000, 'Seguro Desgravamen — EN DESUSO (incluido en RDH desde 2026-07)'],
    ['seg_r_48',  0.046300, 'Seguro RDH (incl. desgravamen) — plazo 37-48m'],
    ['seg_c_48',  0.050200, 'Seguro Cesantía — plazo 37-48m'],
    ['seg_d_72',  0.000000, 'Seguro Desgravamen — EN DESUSO (incluido en RDH desde 2026-07)'],
    ['seg_r_72',  0.080100, 'Seguro RDH (incl. desgravamen) — plazo 61-72m (49-60: 6,95%)'],
    ['seg_c_72',  0.055700, 'Seguro Cesantía — plazo 49-72m'],
    // % que AutoFin nos traspasa de la comisión (= prima) de CADA seguro
    ['seg_pct_traspaso_autofin', 30.00, 'AutoFin — % traspaso de la comisión de seguros (sobre la prima de RDH, cesantía y reparaciones)'],
    // ── AutoFin — fórmulas de ingreso ────────────────────────────────────
    ['autofin_tmc_menor_200', 33.60, 'AutoFin — TMC anual ≤200 UF (%)'],
    ['autofin_tmc_mayor_200', 29.40, 'AutoFin — TMC anual >200 UF (%)'],
    ['autofin_spread_fondo',   0.67, 'AutoFin — Spread costo de fondo mensual (%)'],
    // AutoFin — montos fijos que paga AutoFin por operación (orden de pago saldo precio)
    ['autofin_inscripcion',   39240, 'AutoFin — Inscripción / Transferencia ($) por operación'],
    ['autofin_limitacion',     6140, 'AutoFin — Limitación al Dominio ($) por operación'],
    // ── UAC (Unidad de Crédito) — ingreso por tramo de operaciones ───────
    ['uac_pct_tier1',  14.00, 'UAC — % sobre saldo precio con 1-5 ops/mes'],
    ['uac_pct_tier2',  16.00, 'UAC — % sobre saldo precio con 6-10 ops/mes'],
    ['uac_pct_tier3',  18.00, 'UAC — % sobre saldo precio con 11+ ops/mes'],
    ['uac_ops_tier1_max',  5, 'UAC — N° máximo de ops para tier 1 (14%)'],
    ['uac_ops_tier2_max', 10, 'UAC — N° máximo de ops para tier 2 (16%)'],
    // ── Comisión Dealer por plazo (% sobre saldo precio) ─────────────────
    ['dealer_pct_6',   0.00, 'Dealer PARQUE — % saldo precio plazo ≤6m'],
    ['dealer_pct_12',  0.00, 'Dealer PARQUE — % saldo precio plazo ≤12m'],
    ['dealer_pct_24',  2.50, 'Dealer PARQUE — % saldo precio plazo ≤24m'],
    ['dealer_pct_36',  5.00, 'Dealer PARQUE — % saldo precio plazo ≤36m'],
    ['dealer_pct_99',  7.50, 'Dealer PARQUE — % saldo precio plazo >36m'],
    ['patio_pct',      2.50, 'Patio/Parque — % saldo precio (todos los plazos)'],
    // ── Comisión Dealer CALLE (independiente de parque+patio) ─────────────
    ['dealer_calle_pct_6',   2.50, 'Dealer CALLE — % saldo precio plazo ≤6m'],
    ['dealer_calle_pct_12',  2.50, 'Dealer CALLE — % saldo precio plazo ≤12m'],
    ['dealer_calle_pct_24',  5.00, 'Dealer CALLE — % saldo precio plazo ≤24m'],
    ['dealer_calle_pct_36',  7.50, 'Dealer CALLE — % saldo precio plazo ≤36m'],
    ['dealer_calle_pct_99', 10.00, 'Dealer CALLE — % saldo precio plazo >36m'],
    // ── UAC Tier 4 y Tier 3 max ───────────────────────────────────────────
    ['uac_pct_tier4',       20.00, 'UAC — % sobre saldo precio tramo élite'],
    ['uac_ops_tier3_max',   15,    'UAC — N° máximo de ops para tier 3'],
    // ── Factores de comisión AutoFácil por seguros (% de prima desg) ─────
    ['seg_com_desg_6',  62.525, 'Factor comisión desgravamen plazo ≤6m'],
    ['seg_com_cesa_6',  52.636, 'Factor comisión cesantía plazo ≤6m'],
    ['seg_com_desg_12', 62.827, 'Factor comisión desgravamen plazo ≤12m'],
    ['seg_com_cesa_12', 52.663, 'Factor comisión cesantía plazo ≤12m'],
    ['seg_com_desg_24', 63.171, 'Factor comisión desgravamen plazo ≤24m'],
    ['seg_com_cesa_24', 53.509, 'Factor comisión cesantía plazo ≤24m'],
    ['seg_com_desg_36', 63.539, 'Factor comisión desgravamen plazo ≥25m'],
    ['seg_com_cesa_36', 53.815, 'Factor comisión cesantía plazo ≥25m'],
    // ── Comisión ejecutivo ────────────────────────────────────────────────
    ['pct_ejecutivo_fin', 2.12, 'Comisión ejecutivo sobre monto financiado (%)'],
    // ── Umbral del tramo UF (MAYOR/MENOR) — editable desde Tasas → Modificar Umbrales ──
    ['umbral_uf_tramo', 200, 'Umbral en UF que separa el tramo MENOR/MAYOR (default 200 UF)'],
    // ── Vigencia de la Carta de Aprobación (días corridos desde la fecha de la carta) ──
    ['vigencia_carta_dias', 5, 'Vigencia de la Carta de Aprobación (días corridos desde la fecha de la carta; al vencer pasa a DESISTIDA)'],
  ];
  for (const [clave, valor, descripcion] of defaults) {
    await pool.query(
      'INSERT IGNORE INTO parametros_credito (clave, valor, descripcion) VALUES (?, ?, ?)',
      [clave, valor, descripcion]
    );
  }
};
ensureTable().catch(console.error);

const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT clave, valor, descripcion, fecha_actualizacion FROM parametros_credito ORDER BY clave'
    );
    const obj = {};
    rows.forEach(r => { obj[r.clave] = parseFloat(r.valor); });
    // Fecha de última actualización de tasas de seguro
    const segRows = rows.filter(r => r.clave.startsWith('seg_'));
    const fechaSeg = segRows.length
      ? segRows.reduce((max, r) => (!max || r.fecha_actualizacion > max ? r.fecha_actualizacion : max), null)
      : null;
    res.json({ success: true, data: { lista: rows, obj, fecha_seg: fechaSeg }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const updateAll = async (req, res) => {
  try {
    const params = req.body;
    for (const [clave, valor] of Object.entries(params)) {
      await pool.query(
        `INSERT INTO parametros_credito (clave, valor) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE valor = VALUES(valor)`,
        [clave, parseFloat(valor)]
      );
    }
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'parametros_credito', entidad_id: 'parametros', detalle: `Actualizó parámetros de crédito (${Object.keys(params).length} parámetro/s)`, meta: params });
    dispararRecalc();
    res.json({ success: true, data: { mensaje: 'Parámetros actualizados' }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = { getAll, updateAll };
