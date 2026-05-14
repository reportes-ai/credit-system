const pool = require('../../../../shared/config/database');

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
    const [rows] = await pool.query(
      'SELECT * FROM tasas WHERE fecha_desde <= ? AND fecha_hasta >= ? ORDER BY fecha_desde DESC LIMIT 1',
      [hoy, hoy]
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
    const { fecha_desde, fecha_hasta, tasa_anual_menor, tasa_anual_mayor } = req.body;
    if (!fecha_desde || !fecha_hasta || tasa_anual_menor === undefined || tasa_anual_mayor === undefined)
      return res.status(400).json({ success: false, data: null, error: 'Todos los campos son requeridos' });

    const mensual_menor = Math.round((parseFloat(tasa_anual_menor) / 12) * 100) / 100;
    const mensual_mayor = Math.round((parseFloat(tasa_anual_mayor) / 12) * 100) / 100;

    const [r] = await pool.query(
      'INSERT INTO tasas (fecha_desde, fecha_hasta, tasa_anual_menor, tasa_mensual_menor, tasa_anual_mayor, tasa_mensual_mayor) VALUES (?, ?, ?, ?, ?, ?)',
      [fecha_desde, fecha_hasta, tasa_anual_menor, mensual_menor, tasa_anual_mayor, mensual_mayor]
    );
    res.status(201).json({ success: true, data: { id_tasa: r.insertId }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const update = async (req, res) => {
  try {
    const { fecha_desde, fecha_hasta, tasa_anual_menor, tasa_anual_mayor } = req.body;
    if (!fecha_desde || !fecha_hasta || tasa_anual_menor === undefined || tasa_anual_mayor === undefined)
      return res.status(400).json({ success: false, data: null, error: 'Todos los campos son requeridos' });

    const mensual_menor = Math.round((parseFloat(tasa_anual_menor) / 12) * 100) / 100;
    const mensual_mayor = Math.round((parseFloat(tasa_anual_mayor) / 12) * 100) / 100;

    await pool.query(
      'UPDATE tasas SET fecha_desde=?, fecha_hasta=?, tasa_anual_menor=?, tasa_mensual_menor=?, tasa_anual_mayor=?, tasa_mensual_mayor=? WHERE id_tasa=?',
      [fecha_desde, fecha_hasta, tasa_anual_menor, mensual_menor, tasa_anual_mayor, mensual_mayor, req.params.id]
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
