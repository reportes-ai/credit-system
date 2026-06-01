const pool = require('../../../../shared/config/database');

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
    // Seguros
    ['seg_d_6',   0.008980, 'Seguro Desgravamen — plazo ≤6m'],
    ['seg_r_6',   0.006745, 'Seguro RDH — plazo ≤6m'],
    ['seg_c_6',   0.036162, 'Seguro Cesantía — plazo ≤6m'],
    ['seg_d_12',  0.018641, 'Seguro Desgravamen — plazo ≤12m'],
    ['seg_r_12',  0.011634, 'Seguro RDH — plazo ≤12m'],
    ['seg_c_12',  0.037883, 'Seguro Cesantía — plazo ≤12m'],
    ['seg_d_24',  0.027538, 'Seguro Desgravamen — plazo ≤24m'],
    ['seg_r_24',  0.012248, 'Seguro RDH — plazo ≤24m'],
    ['seg_c_24',  0.042101, 'Seguro Cesantía — plazo ≤24m'],
    ['seg_d_36',  0.035518, 'Seguro Desgravamen — plazo ≤36m'],
    ['seg_r_36',  0.012761, 'Seguro RDH — plazo ≤36m'],
    ['seg_c_36',  0.047120, 'Seguro Cesantía — plazo ≤36m'],
    ['seg_d_48',  0.043623, 'Seguro Desgravamen — plazo ≤48m'],
    ['seg_r_48',  0.029018, 'Seguro RDH — plazo ≤48m'],
    ['seg_c_48',  0.052853, 'Seguro Cesantía — plazo ≤48m'],
    ['seg_d_72',  0.054964, 'Seguro Desgravamen — plazo ≤72m'],
    ['seg_r_72',  0.034875, 'Seguro RDH — plazo ≤72m'],
    ['seg_c_72',  0.058985, 'Seguro Cesantía — plazo ≤72m'],
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
    res.json({ success: true, data: { mensaje: 'Parámetros actualizados' }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = { getAll, updateAll };
