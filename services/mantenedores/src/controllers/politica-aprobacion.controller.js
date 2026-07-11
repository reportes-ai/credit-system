'use strict';
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ─────────────────────────────────────────────────────────────────────────
   Política de Aprobación Crédito AutoFácil (PC-02 v2.0)
   - Matriz de aprobación (24 combinaciones condición/origen/ocupación)
   - Parámetros globales (edades, cargas máximas, instituciones, restricciones)
   Fuente: Manual de Política de Crédito PC-02 v2.0, pág. 15 (tabla resumen).
   ───────────────────────────────────────────────────────────────────────── */

const MATRIZ_DEFAULT = [
  // condicion, origen, ocupacion, edad_min, edad_max, renta_min, antig_lab_meses, pie_min_pct, antig_veh_max, plazo_max, monto_max
  ['NUEVO','CHINA','Empleado',            21,70, 750000,12,20,0,48,15000000],
  ['NUEVO','CHINA','Independiente',        25,70, 750000,24,20,0,48,15000000],
  ['NUEVO','CHINA','Jubilado',            21,70, 750000, 3,20,0,48,15000000],
  ['NUEVO','CHINA','Taxista',             25,70, 750000,24,20,0,48,15000000],
  ['NUEVO','CHINA','Transporte Escolar',  25,70,1000000,24,20,0,48,15000000],
  ['NUEVO','CHINA','Transporte Personal', 25,70,1000000,24,20,0,48,15000000],
  ['NUEVO','OTRA','Empleado',             21,70, 750000,12,20,0,60,15000000],
  ['NUEVO','OTRA','Independiente',         21,70, 750000,24,20,0,60,15000000],
  ['NUEVO','OTRA','Jubilado',             21,70, 750000, 3,20,0,60,15000000],
  ['NUEVO','OTRA','Taxista',              21,70, 750000,24,20,0,60,15000000],
  ['NUEVO','OTRA','Transporte Escolar',   21,70,1000000,24,20,0,60,15000000],
  ['NUEVO','OTRA','Transporte Personal',  21,70,1000000,24,20,0,60,15000000],
  ['USADO','CHINA','Empleado',            21,70, 750000,12,40,4,48,12000000],
  ['USADO','CHINA','Independiente',        25,70, 750000,24,40,4,48,12000000],
  ['USADO','CHINA','Jubilado',            21,70, 750000, 3,40,4,48,12000000],
  ['USADO','CHINA','Taxista',             25,70, 750000,24,40,4,48,12000000],
  ['USADO','CHINA','Transporte Escolar',  25,70,1000000,24,40,4,48,12000000],
  ['USADO','CHINA','Transporte Personal', 25,70,1000000,24,40,4,48,12000000],
  ['USADO','OTRA','Empleado',             21,70, 750000,12,25,7,60,15000000],
  ['USADO','OTRA','Independiente',         21,70, 750000,24,25,7,60,15000000],
  ['USADO','OTRA','Jubilado',             21,70, 750000, 3,25,7,60,15000000],
  ['USADO','OTRA','Taxista',              21,70, 750000,24,25,7,60,15000000],
  ['USADO','OTRA','Transporte Escolar',   21,70,1000000,24,25,7,60,15000000],
  ['USADO','OTRA','Transporte Personal',  21,70,1000000,24,25,7,60,15000000],
];

// Parámetros globales (clave, valor, descripción)
const PARAMS_DEFAULT = [
  ['pol_edad_min_otorgamiento',  18, 'Edad mínima al otorgamiento (años)'],
  ['pol_edad_max_otorgamiento',  74, 'Edad máxima a la fecha de otorgamiento (años)'],
  ['pol_edad_max_termino',       79, 'Edad máxima al término del crédito (años)'],
  ['pol_carga_operacion_max',    30, 'Carga mensual de la operación máx. (% de la renta)'],
  ['pol_carga_total_max',        60, 'Carga mensual total máx. (% de los ingresos)'],
  ['pol_instituciones_max',       6, 'N° instituciones con línea: desde este valor → excepción'],
  ['pol_meses_sin_morosidad',     3, 'Meses sin morosidad/protestos exigidos'],
  ['pol_juicio_cobranza_meses',  24, 'Juicio de cobranza: rechazo si dentro de N meses'],
  ['pol_complemento_conyuge',    50, 'Complemento de renta cónyuge/conviviente (%)'],
  ['pol_jubilar_renta_pct',      50, 'Renta considerada para próximos a jubilar 61-65 (%)'],
  ['pol_aval_padre_hijo_pie',    40, 'Pie mínimo cuando complementa con padre/hijo (%)'],
];

require('../../../../shared/migrate').enFila('politica-aprobacion', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS politica_aprobacion_matriz (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        condicion         VARCHAR(10)  NOT NULL,
        origen            VARCHAR(10)  NOT NULL,
        ocupacion         VARCHAR(40)  NOT NULL,
        edad_min          INT NOT NULL DEFAULT 18,
        edad_max          INT NOT NULL DEFAULT 70,
        renta_min         INT NOT NULL DEFAULT 0,
        antiguedad_laboral_meses INT NOT NULL DEFAULT 0,
        pie_min_pct       DECIMAL(5,2) NOT NULL DEFAULT 0,
        antiguedad_vehiculo_max  INT NOT NULL DEFAULT 0,
        plazo_max         INT NOT NULL DEFAULT 0,
        monto_max_financiar BIGINT NOT NULL DEFAULT 0,
        UNIQUE KEY uq_combo (condicion, origen, ocupacion)
      )
    `);
    // Seed inicial (solo si está vacía)
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM politica_aprobacion_matriz');
    if (n === 0) {
      await pool.query(
        `INSERT INTO politica_aprobacion_matriz
          (condicion, origen, ocupacion, edad_min, edad_max, renta_min, antiguedad_laboral_meses, pie_min_pct, antiguedad_vehiculo_max, plazo_max, monto_max_financiar)
         VALUES ?`,
        [MATRIZ_DEFAULT]
      );
      console.log('✓ politica_aprobacion_matriz seed (24 filas)');
    }
    // Parámetros globales en parametros_credito (no pisa valores existentes)
    for (const [clave, valor, desc] of PARAMS_DEFAULT) {
      await pool.query(
        'INSERT IGNORE INTO parametros_credito (clave, valor, descripcion) VALUES (?,?,?)',
        [clave, valor, desc]
      );
    }
  } catch (e) { console.error('[politica-aprobacion migration]', e.message); }
});

const getMatriz = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT * FROM politica_aprobacion_matriz
       ORDER BY condicion, origen, ocupacion`
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const updateMatriz = async (req, res) => {
  try {
    const filas = req.body?.filas;
    if (!Array.isArray(filas)) return res.status(400).json({ success:false, data:null, error:'filas requerido' });
    const num = v => { const n = Number(v); return isNaN(n) ? 0 : n; };
    for (const f of filas) {
      if (!f.id) continue;
      await pool.query(
        `UPDATE politica_aprobacion_matriz SET
           edad_min=?, edad_max=?, renta_min=?, antiguedad_laboral_meses=?,
           pie_min_pct=?, antiguedad_vehiculo_max=?, plazo_max=?, monto_max_financiar=?
         WHERE id=?`,
        [num(f.edad_min), num(f.edad_max), num(f.renta_min), num(f.antiguedad_laboral_meses),
         num(f.pie_min_pct), num(f.antiguedad_vehiculo_max), num(f.plazo_max), num(f.monto_max_financiar), f.id]
      );
    }
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'politica_matriz', entidad_id: 'matriz', detalle: `Actualizó la matriz de política de aprobación (${filas.length} fila/s)`, meta: { filas } });
    res.json({ success: true, data: { mensaje: 'Matriz actualizada' }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = { getMatriz, updateMatriz };
