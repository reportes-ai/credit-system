const pool = require('../../../../shared/config/database');

const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tasas ORDER BY vigente_desde DESC');
    res.json({ success: true, data: rows, error: null });
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
    const { nombre, tipo, valor, vigente_desde } = req.body;
    if (!nombre || !tipo || valor === undefined || !vigente_desde)
      return res.status(400).json({ success: false, data: null, error: 'Nombre, tipo, valor y vigente_desde son requeridos' });

    const [r] = await pool.query(
      'INSERT INTO tasas (nombre, tipo, valor, vigente_desde, estado) VALUES (?, ?, ?, ?, ?)',
      [nombre, tipo, valor, vigente_desde, 'activo']
    );
    res.status(201).json({ success: true, data: { id_tasa: r.insertId, nombre, tipo, valor, vigente_desde, estado: 'activo' }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const update = async (req, res) => {
  try {
    const { nombre, tipo, valor, vigente_desde, estado } = req.body;
    await pool.query(
      'UPDATE tasas SET nombre=?, tipo=?, valor=?, vigente_desde=?, estado=? WHERE id_tasa=?',
      [nombre, tipo, valor, vigente_desde, estado, req.params.id]
    );
    res.json({ success: true, data: { id_tasa: req.params.id, nombre, tipo, valor, vigente_desde, estado }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const remove = async (req, res) => {
  try {
    await pool.query('UPDATE tasas SET estado=? WHERE id_tasa=?', ['inactivo', req.params.id]);
    res.json({ success: true, data: { mensaje: 'Tasa desactivada' }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getAll, getById, create, update, remove };
