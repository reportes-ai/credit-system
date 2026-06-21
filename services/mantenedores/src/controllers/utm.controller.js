const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

// La UTM es mensual. Mismo patrón que UF (fecha + valor), un registro por mes.
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS utm (
      id_utm     INT AUTO_INCREMENT PRIMARY KEY,
      fecha      DATE NOT NULL UNIQUE,
      valor      DECIMAL(12,2) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP )`);
  } catch (e) { if (e.errno !== 1050) console.error('[utm migration]', e.message); }
})();

const errSrv = (res, e) => { console.error('[utm]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); };

const getAll = async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM utm ORDER BY fecha DESC LIMIT 400'); res.json({ success: true, data: rows, error: null }); }
  catch (e) { errSrv(res, e); }
};
const getVigente = async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM utm WHERE fecha <= CURDATE() ORDER BY fecha DESC LIMIT 1'); res.json({ success: true, data: rows[0] || null, error: null }); }
  catch (e) { errSrv(res, e); }
};
const getEnFecha = async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM utm WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1', [req.params.fecha]); res.json({ success: true, data: rows[0] || null, error: null }); }
  catch (e) { errSrv(res, e); }
};
const create = async (req, res) => {
  try {
    const { fecha, valor } = req.body;
    if (!fecha || valor === undefined) return res.status(400).json({ success: false, data: null, error: 'Fecha y valor son requeridos' });
    const [r] = await pool.query('INSERT INTO utm (fecha, valor) VALUES (?, ?) ON DUPLICATE KEY UPDATE valor = VALUES(valor)', [fecha, valor]);
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'utm', entidad_id: r.insertId, detalle: `Registró UTM ${fecha} = ${valor}`, meta: { fecha, valor } });
    res.status(201).json({ success: true, data: { id_utm: r.insertId, fecha, valor }, error: null });
  } catch (e) { errSrv(res, e); }
};
const update = async (req, res) => {
  try {
    const { fecha, valor } = req.body;
    await pool.query('UPDATE utm SET fecha=?, valor=? WHERE id_utm=?', [fecha, valor, req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'utm', entidad_id: req.params.id, detalle: `Editó UTM #${req.params.id} → ${fecha} = ${valor}`, meta: { fecha, valor } });
    res.json({ success: true, data: { id_utm: req.params.id, fecha, valor }, error: null });
  } catch (e) { errSrv(res, e); }
};
const remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM utm WHERE id_utm=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'utm', entidad_id: req.params.id, detalle: `Eliminó registro UTM #${req.params.id}` });
    res.json({ success: true, data: { mensaje: 'Registro UTM eliminado' }, error: null });
  } catch (e) { errSrv(res, e); }
};

module.exports = { getAll, getVigente, getEnFecha, create, update, remove };
