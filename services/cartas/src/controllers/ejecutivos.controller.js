'use strict';
const pool = require('../../../../shared/config/database');

const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, nombre, mail, tel FROM cartas_ejecutivos WHERE activo = 1 ORDER BY nombre'
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const create = async (req, res) => {
  try {
    const { nombre, mail, tel } = req.body;
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'nombre requerido' });
    const [r] = await pool.query(
      'INSERT INTO cartas_ejecutivos (nombre, mail, tel) VALUES (?, ?, ?)',
      [nombre, mail || null, tel || null]
    );
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const update = async (req, res) => {
  try {
    const { nombre, mail, tel } = req.body;
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'nombre requerido' });
    await pool.query(
      'UPDATE cartas_ejecutivos SET nombre=?, mail=?, tel=? WHERE id=?',
      [nombre, mail || null, tel || null, req.params.id]
    );
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const remove = async (req, res) => {
  try {
    await pool.query('UPDATE cartas_ejecutivos SET activo=0 WHERE id=?', [req.params.id]);
    res.json({ success: true, data: { mensaje: 'Ejecutivo eliminado' }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = { getAll, create, update, remove };
