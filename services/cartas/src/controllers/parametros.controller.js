'use strict';
const pool = require('../../../../shared/config/database');

const getParam = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT `value` FROM cartas_parametros WHERE `key` = ?',
      [req.params.key]
    );
    if (!rows.length) return res.json({ success: true, data: null, error: null });
    res.json({ success: true, data: rows[0].value, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const setParam = async (req, res) => {
  try {
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ success: false, data: null, error: 'value requerido' });
    const updatedBy = req.user ? (req.user.email || String(req.user.id_usuario)) : 'system';
    await pool.query(
      'INSERT INTO cartas_parametros (`key`, `value`, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `value`=VALUES(`value`), updated_by=VALUES(updated_by), updated_at=NOW()',
      [req.params.key, String(value), updatedBy]
    );
    res.json({ success: true, data: { key: req.params.key }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getParam, setParam };
