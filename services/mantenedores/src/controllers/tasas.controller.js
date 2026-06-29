const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { recalcularMesesAbiertos } = require('../../../creditos/src/utils/recalcular-mes');
const tasaUtils = require('../../../../shared/tasa-utils');
// Cambiar un parámetro que afecta el cálculo (ingreso por crédito / dealer / parque)
// dispara el recálculo de los meses abiertos. Fire-and-forget: no bloquea la respuesta.
// Respeta los campos forzados (no los sobrescribe).
const dispararRecalc = () => recalcularMesesAbiertos()
  .then(r => { if (r.actualizados) console.log(`[recalc auto] ${r.actualizados} ops recalculadas`); })
  .catch(e => console.error('[recalc auto]', e.message));

// Migración: agrega columnas spread y rellena histórico correctamente
// - spread_mayor: spread que el usuario ingresa (aplicado a >200 UF), ej: 0.67%
// - CF = tasa_mensual_mayor - spread_mayor  (mismo para ambos tramos)
// - spread_menor: implícito = tasa_mensual_menor - CF (calculado y almacenado)
(async () => {
  for (const sql of [
    `ALTER TABLE tasas ADD COLUMN spread_menor DECIMAL(8,4) NULL DEFAULT NULL`,
    `ALTER TABLE tasas ADD COLUMN spread_mayor DECIMAL(8,4) NULL DEFAULT NULL`,
  ]) {
    try { await pool.query(sql); }
    catch(e) { if (e.errno !== 1060) console.error('[tasas migration]', e.message); }
  }
  // Asegura spread_mayor=0.67 donde sea NULL y recalcula spread_menor para TODOS
  // spread_menor implícito = mensual_menor - (mensual_mayor - spread_mayor)
  try {
    await pool.query(`UPDATE tasas SET spread_mayor = 0.6700 WHERE spread_mayor IS NULL`);
    await pool.query(
      `UPDATE tasas
       SET spread_menor = ROUND(tasa_mensual_menor - tasa_mensual_mayor + spread_mayor, 4)`
    );
  } catch(e) { console.error('[tasas migration spread]', e.message); }
})();

const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tasas ORDER BY fecha_desde DESC');
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const getVigente = async (req, res) => {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    const [rows] = await pool.query(
      'SELECT * FROM tasas WHERE fecha_desde <= ? ORDER BY fecha_desde DESC LIMIT 1',
      [hoy]
    );
    res.json({ success: true, data: rows[0] || null, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

// Tasa aplicable a una fecha (para TMC del día de otorgamiento)
const getEnFecha = async (req, res) => {
  try {
    const fecha = req.params.fecha;
    let [rows] = await pool.query(
      'SELECT * FROM tasas WHERE fecha_desde <= ? AND fecha_hasta >= ? ORDER BY fecha_desde DESC LIMIT 1',
      [fecha, fecha]
    );
    if (!rows.length) {
      [rows] = await pool.query(
        'SELECT * FROM tasas WHERE fecha_desde <= ? ORDER BY fecha_desde DESC LIMIT 1',
        [fecha]
      );
    }
    res.json({ success: true, data: rows[0] || null, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const getById = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tasas WHERE id_tasa = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, data: null, error: 'Tasa no encontrada' });
    res.json({ success: true, data: rows[0], error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const create = async (req, res) => {
  try {
    const { fecha_desde, fecha_hasta, tasa_anual_menor, tasa_anual_mayor, spread_mayor } = req.body;
    if (!fecha_desde || !fecha_hasta || tasa_anual_menor === undefined || tasa_anual_mayor === undefined)
      return res.status(400).json({ success: false, data: null, error: 'Todos los campos son requeridos' });
    if (fecha_hasta < fecha_desde)
      return res.status(400).json({ success: false, data: null, error: 'La fecha hasta no puede ser anterior a la fecha desde' });

    const mensual_menor = tasaUtils.anualAMensual(tasa_anual_menor);
    const mensual_mayor = tasaUtils.anualAMensual(tasa_anual_mayor);
    const sp_mayor = tasaUtils.parseSpreadMayor(spread_mayor);
    const sp_menor = tasaUtils.spreadMenor(mensual_menor, mensual_mayor, sp_mayor);

    const [r] = await pool.query(
      'INSERT INTO tasas (fecha_desde, fecha_hasta, tasa_anual_menor, tasa_mensual_menor, tasa_anual_mayor, tasa_mensual_mayor, spread_menor, spread_mayor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [fecha_desde, fecha_hasta, tasa_anual_menor, mensual_menor, tasa_anual_mayor, mensual_mayor, sp_menor, sp_mayor]
    );
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'tasa', entidad_id: r.insertId, detalle: `Creó una tasa (vigencia ${fecha_desde} a ${fecha_hasta})`, meta: req.body });
    dispararRecalc();
    res.status(201).json({ success: true, data: { id_tasa: r.insertId }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const update = async (req, res) => {
  try {
    const { fecha_desde, fecha_hasta, tasa_anual_menor, tasa_anual_mayor, spread_mayor } = req.body;
    if (!fecha_desde || !fecha_hasta || tasa_anual_menor === undefined || tasa_anual_mayor === undefined)
      return res.status(400).json({ success: false, data: null, error: 'Todos los campos son requeridos' });
    if (fecha_hasta < fecha_desde)
      return res.status(400).json({ success: false, data: null, error: 'La fecha hasta no puede ser anterior a la fecha desde' });

    const mensual_menor = tasaUtils.anualAMensual(tasa_anual_menor);
    const mensual_mayor = tasaUtils.anualAMensual(tasa_anual_mayor);
    const sp_mayor = tasaUtils.parseSpreadMayor(spread_mayor);
    const sp_menor = tasaUtils.spreadMenor(mensual_menor, mensual_mayor, sp_mayor);

    await pool.query(
      'UPDATE tasas SET fecha_desde=?, fecha_hasta=?, tasa_anual_menor=?, tasa_mensual_menor=?, tasa_anual_mayor=?, tasa_mensual_mayor=?, spread_menor=?, spread_mayor=? WHERE id_tasa=?',
      [fecha_desde, fecha_hasta, tasa_anual_menor, mensual_menor, tasa_anual_mayor, mensual_mayor, sp_menor, sp_mayor, req.params.id]
    );
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'tasa', entidad_id: req.params.id, detalle: `Editó la tasa #${req.params.id}`, meta: req.body });
    dispararRecalc();
    res.json({ success: true, data: { id_tasa: req.params.id }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM tasas WHERE id_tasa=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'tasa', entidad_id: req.params.id, detalle: `Eliminó la tasa #${req.params.id}` });
    dispararRecalc();
    res.json({ success: true, data: { mensaje: 'Tasa eliminada' }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = { getAll, getVigente, getEnFecha, getById, create, update, remove };
