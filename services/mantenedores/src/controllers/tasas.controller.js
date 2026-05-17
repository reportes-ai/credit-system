const pool = require('../../../../shared/config/database');

// Migración: agrega columnas spread y rellena histórico con 0,67% donde sea NULL
(async () => {
  for (const sql of [
    `ALTER TABLE tasas ADD COLUMN spread_menor DECIMAL(8,4) NULL DEFAULT NULL`,
    `ALTER TABLE tasas ADD COLUMN spread_mayor DECIMAL(8,4) NULL DEFAULT NULL`,
  ]) {
    try { await pool.query(sql); }
    catch(e) { if (e.errno !== 1060) console.error('[tasas migration]', e.message); }
  }
  // Rellenar spread histórico con 0.67 donde aún sea NULL
  try {
    await pool.query(
      `UPDATE tasas SET spread_menor = 0.6700, spread_mayor = 0.6700
       WHERE spread_menor IS NULL OR spread_mayor IS NULL`
    );
  } catch(e) { console.error('[tasas migration spread]', e.message); }
})();

const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tasas ORDER BY fecha_desde DESC');
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const getVigente = async (req, res) => {
  try {
    const hoy = new Date().toISOString().split('T')[0];
    // Tasa vigente = la de fecha_desde más reciente que ya comenzó
    const [rows] = await pool.query(
      'SELECT * FROM tasas WHERE fecha_desde <= ? ORDER BY fecha_desde DESC LIMIT 1',
      [hoy]
    );
    res.json({ success: true, data: rows[0] || null, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const getById = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tasas WHERE id_tasa = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, data: null, error: 'Tasa no encontrada' });
    res.json({ success: true, data: rows[0], error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const create = async (req, res) => {
  try {
    const { fecha_desde, fecha_hasta, tasa_anual_menor, tasa_anual_mayor, spread_menor, spread_mayor } = req.body;
    if (!fecha_desde || !fecha_hasta || tasa_anual_menor === undefined || tasa_anual_mayor === undefined)
      return res.status(400).json({ success: false, data: null, error: 'Todos los campos son requeridos' });
    if (fecha_hasta < fecha_desde)
      return res.status(400).json({ success: false, data: null, error: 'La fecha hasta no puede ser anterior a la fecha desde' });

    const mensual_menor = Math.round((parseFloat(tasa_anual_menor) / 12) * 10000) / 10000;
    const mensual_mayor = Math.round((parseFloat(tasa_anual_mayor) / 12) * 10000) / 10000;
    const sp_menor = spread_menor !== undefined && spread_menor !== '' ? parseFloat(spread_menor) : null;
    const sp_mayor = spread_mayor !== undefined && spread_mayor !== '' ? parseFloat(spread_mayor) : null;

    const [r] = await pool.query(
      'INSERT INTO tasas (fecha_desde, fecha_hasta, tasa_anual_menor, tasa_mensual_menor, tasa_anual_mayor, tasa_mensual_mayor, spread_menor, spread_mayor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [fecha_desde, fecha_hasta, tasa_anual_menor, mensual_menor, tasa_anual_mayor, mensual_mayor, sp_menor, sp_mayor]
    );
    res.status(201).json({ success: true, data: { id_tasa: r.insertId }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const update = async (req, res) => {
  try {
    const { fecha_desde, fecha_hasta, tasa_anual_menor, tasa_anual_mayor, spread_menor, spread_mayor } = req.body;
    if (!fecha_desde || !fecha_hasta || tasa_anual_menor === undefined || tasa_anual_mayor === undefined)
      return res.status(400).json({ success: false, data: null, error: 'Todos los campos son requeridos' });
    if (fecha_hasta < fecha_desde)
      return res.status(400).json({ success: false, data: null, error: 'La fecha hasta no puede ser anterior a la fecha desde' });

    const mensual_menor = Math.round((parseFloat(tasa_anual_menor) / 12) * 10000) / 10000;
    const mensual_mayor = Math.round((parseFloat(tasa_anual_mayor) / 12) * 10000) / 10000;
    const sp_menor = spread_menor !== undefined && spread_menor !== '' ? parseFloat(spread_menor) : null;
    const sp_mayor = spread_mayor !== undefined && spread_mayor !== '' ? parseFloat(spread_mayor) : null;

    await pool.query(
      'UPDATE tasas SET fecha_desde=?, fecha_hasta=?, tasa_anual_menor=?, tasa_mensual_menor=?, tasa_anual_mayor=?, tasa_mensual_mayor=?, spread_menor=?, spread_mayor=? WHERE id_tasa=?',
      [fecha_desde, fecha_hasta, tasa_anual_menor, mensual_menor, tasa_anual_mayor, mensual_mayor, sp_menor, sp_mayor, req.params.id]
    );
    res.json({ success: true, data: { id_tasa: req.params.id }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM tasas WHERE id_tasa=?', [req.params.id]);
    res.json({ success: true, data: { mensaje: 'Tasa eliminada' }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getAll, getVigente, getById, create, update, remove };
