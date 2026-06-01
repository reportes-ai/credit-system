const pool = require('../../../../shared/config/database');

// REGIONES
const getRegiones = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM regiones ORDER BY orden, nombre');
    res.json({ success: true, data: rows, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const createRegion = async (req, res) => {
  try {
    const { nombre } = req.body;
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'Nombre requerido' });
    const [[{maxOrden}]] = await pool.query('SELECT COALESCE(MAX(orden),0)+1 AS maxOrden FROM regiones');
    const [r] = await pool.query('INSERT INTO regiones (nombre, orden) VALUES (?,?)', [nombre.trim(), maxOrden]);
    res.status(201).json({ success: true, data: { id_region: r.insertId, nombre, orden: maxOrden }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const updateRegion = async (req, res) => {
  try {
    const { nombre } = req.body;
    await pool.query('UPDATE regiones SET nombre=? WHERE id_region=?', [nombre.trim(), req.params.id]);
    res.json({ success: true, data: { id_region: req.params.id, nombre }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const deleteRegion = async (req, res) => {
  try {
    const [[{total}]] = await pool.query('SELECT COUNT(*) AS total FROM provincias WHERE id_region=?', [req.params.id]);
    if (total > 0) return res.status(400).json({ success: false, data: null, error: 'No se puede eliminar: tiene provincias asociadas' });
    await pool.query('DELETE FROM regiones WHERE id_region=?', [req.params.id]);
    res.json({ success: true, data: { mensaje: 'Región eliminada' }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

// PROVINCIAS
const getProvincias = async (req, res) => {
  try {
    const where = req.query.id_region ? 'WHERE p.id_region=?' : '';
    const params = req.query.id_region ? [req.query.id_region] : [];
    const [rows] = await pool.query(
      `SELECT p.*, r.nombre AS region FROM provincias p JOIN regiones r ON r.id_region=p.id_region ${where} ORDER BY r.orden, p.nombre`,
      params
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const createProvincia = async (req, res) => {
  try {
    const { nombre, id_region } = req.body;
    if (!nombre || !id_region) return res.status(400).json({ success: false, data: null, error: 'Nombre e id_region requeridos' });
    const [r] = await pool.query('INSERT INTO provincias (id_region, nombre) VALUES (?,?)', [id_region, nombre.trim()]);
    res.status(201).json({ success: true, data: { id_provincia: r.insertId, nombre, id_region }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const updateProvincia = async (req, res) => {
  try {
    const { nombre, id_region } = req.body;
    await pool.query('UPDATE provincias SET nombre=?, id_region=? WHERE id_provincia=?', [nombre.trim(), id_region, req.params.id]);
    res.json({ success: true, data: { id_provincia: req.params.id, nombre, id_region }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const deleteProvincia = async (req, res) => {
  try {
    const [[{total}]] = await pool.query('SELECT COUNT(*) AS total FROM comunas WHERE id_provincia=?', [req.params.id]);
    if (total > 0) return res.status(400).json({ success: false, data: null, error: 'No se puede eliminar: tiene comunas asociadas' });
    await pool.query('DELETE FROM provincias WHERE id_provincia=?', [req.params.id]);
    res.json({ success: true, data: { mensaje: 'Provincia eliminada' }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

// COMUNAS
const getComunas = async (req, res) => {
  try {
    const where = req.query.id_provincia ? 'WHERE c.id_provincia=?' : '';
    const params = req.query.id_provincia ? [req.query.id_provincia] : [];
    const [rows] = await pool.query(
      `SELECT c.*, p.nombre AS provincia, r.nombre AS region FROM comunas c JOIN provincias p ON p.id_provincia=c.id_provincia JOIN regiones r ON r.id_region=p.id_region ${where} ORDER BY c.nombre`,
      params
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const createComuna = async (req, res) => {
  try {
    const { nombre, id_provincia } = req.body;
    if (!nombre || !id_provincia) return res.status(400).json({ success: false, data: null, error: 'Nombre e id_provincia requeridos' });
    const [r] = await pool.query('INSERT INTO comunas (id_provincia, nombre) VALUES (?,?)', [id_provincia, nombre.trim()]);
    res.status(201).json({ success: true, data: { id_comuna: r.insertId, nombre, id_provincia }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const updateComuna = async (req, res) => {
  try {
    const { nombre, id_provincia } = req.body;
    await pool.query('UPDATE comunas SET nombre=?, id_provincia=? WHERE id_comuna=?', [nombre.trim(), id_provincia, req.params.id]);
    res.json({ success: true, data: { id_comuna: req.params.id, nombre, id_provincia }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const deleteComuna = async (req, res) => {
  try {
    await pool.query('DELETE FROM comunas WHERE id_comuna=?', [req.params.id]);
    res.json({ success: true, data: { mensaje: 'Comuna eliminada' }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

module.exports = {
  getRegiones, createRegion, updateRegion, deleteRegion,
  getProvincias, createProvincia, updateProvincia, deleteProvincia,
  getComunas, createComuna, updateComuna, deleteComuna
};
