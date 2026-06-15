const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const ensureTable = () => pool.query(`CREATE TABLE IF NOT EXISTS dealers (
  id_dealer        INT AUTO_INCREMENT PRIMARY KEY,
  numero           INT,
  numero_ind       VARCHAR(20),
  rut              VARCHAR(12),
  nombre_indexa    VARCHAR(200),
  nombre_razon     VARCHAR(200),
  ccs_parque       VARCHAR(100),
  direccion        VARCHAR(300),
  fecha_incorporacion DATE,
  contacto         VARCHAR(150),
  telefono         VARCHAR(30),
  correo           VARCHAR(150),
  num_cuenta       VARCHAR(30),
  banco            VARCHAR(80),
  rut_pago         VARCHAR(12),
  activo           TINYINT(1) DEFAULT 1,
  tiene_factura    TINYINT(1) DEFAULT 0,
  observaciones    TEXT,
  UNIQUE KEY uk_rut (rut)
)`);

ensureTable().catch(e => console.error('dealers table init:', e.message));

function excelDate(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.substring(0, 10);
  const d = new Date(Math.round((v - 25569) * 86400000));
  return d.toISOString().slice(0, 10);
}

const getDealers = async (req, res) => {
  try {
    const { q, ccs, activo, page = 1, limit = 100 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conds = [], params = [];
    if (q) {
      const ql = `%${q.toLowerCase()}%`;
      conds.push('(LOWER(nombre_indexa) LIKE ? OR LOWER(nombre_razon) LIKE ? OR LOWER(rut) LIKE ?)');
      params.push(ql, ql, ql);
    }
    if (ccs)    { conds.push('ccs_parque = ?'); params.push(ccs); }
    if (activo !== undefined && activo !== '') { conds.push('activo = ?'); params.push(parseInt(activo)); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM dealers ${where}`, params);
    const [rows] = await pool.query(
      `SELECT * FROM dealers ${where} ORDER BY numero ASC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );
    res.json({ success: true, data: { rows, total, page: parseInt(page) }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const getDealer = async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM dealers WHERE id_dealer=?', [req.params.id]);
    res.json({ success: true, data: row || null, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const getCcsList = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT DISTINCT ccs_parque FROM dealers WHERE ccs_parque IS NOT NULL ORDER BY ccs_parque');
    res.json({ success: true, data: rows.map(r => r.ccs_parque), error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const importar = async (req, res) => {
  try {
    await ensureTable();
    const { registros } = req.body;
    if (!Array.isArray(registros) || !registros.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin registros' });

    const vals = registros.map(r => [
      r.numero, r.numero_ind, r.rut, r.nombre_indexa, r.nombre_razon,
      r.ccs_parque, r.direccion, r.fecha_incorporacion,
      r.contacto, r.telefono, r.correo,
      r.num_cuenta, r.banco, r.rut_pago,
      r.activo ? 1 : 0, r.tiene_factura ? 1 : 0, r.observaciones || null
    ]);

    const sql = `INSERT IGNORE INTO dealers
      (numero,numero_ind,rut,nombre_indexa,nombre_razon,ccs_parque,direccion,
       fecha_incorporacion,contacto,telefono,correo,num_cuenta,banco,rut_pago,
       activo,tiene_factura,observaciones)
      VALUES ?`;
    const [result] = await pool.query(sql, [vals]);
    auditar({ req, accion: 'CARGA_MASIVA', modulo: 'mantenedores', entidad: 'dealer', detalle: `Importó dealers: ${result.affectedRows} insertado(s)`, meta: { insertados: result.affectedRows } });
    res.json({ success: true, data: { insertados: result.affectedRows }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const createDealer = async (req, res) => {
  try {
    const r = req.body;
    const [[{ maxN }]] = await pool.query('SELECT COALESCE(MAX(numero),0)+1 AS maxN FROM dealers');
    const [result] = await pool.query(
      `INSERT INTO dealers (numero,numero_ind,rut,nombre_indexa,nombre_razon,ccs_parque,
       direccion,fecha_incorporacion,contacto,telefono,correo,num_cuenta,banco,rut_pago,
       activo,tiene_factura,observaciones)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [maxN, r.numero_ind, r.rut, r.nombre_indexa, r.nombre_razon, r.ccs_parque,
       r.direccion, r.fecha_incorporacion || null, r.contacto, r.telefono, r.correo,
       r.num_cuenta, r.banco, r.rut_pago,
       r.activo ? 1 : 0, r.tiene_factura ? 1 : 0, r.observaciones || null]
    );
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'dealer', entidad_id: result.insertId, detalle: `Creó el dealer N°${maxN} — ${r.nombre_razon || r.nombre_indexa || ''}`, rut: r.rut, meta: req.body });
    res.status(201).json({ success: true, data: { id_dealer: result.insertId, numero: maxN }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const updateDealer = async (req, res) => {
  try {
    const r = req.body;
    await pool.query(
      `UPDATE dealers SET numero_ind=?,rut=?,nombre_indexa=?,nombre_razon=?,ccs_parque=?,
       direccion=?,fecha_incorporacion=?,contacto=?,telefono=?,correo=?,
       num_cuenta=?,banco=?,rut_pago=?,activo=?,tiene_factura=?,observaciones=?
       WHERE id_dealer=?`,
      [r.numero_ind, r.rut, r.nombre_indexa, r.nombre_razon, r.ccs_parque,
       r.direccion, r.fecha_incorporacion || null, r.contacto, r.telefono, r.correo,
       r.num_cuenta, r.banco, r.rut_pago,
       r.activo ? 1 : 0, r.tiene_factura ? 1 : 0, r.observaciones || null,
       req.params.id]
    );
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'dealer', entidad_id: req.params.id, detalle: `Editó el dealer #${req.params.id} — ${r.nombre_razon || r.nombre_indexa || ''}`, rut: r.rut, meta: req.body });
    res.json({ success: true, data: { id_dealer: req.params.id }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const deleteDealer = async (req, res) => {
  try {
    await pool.query('DELETE FROM dealers WHERE id_dealer=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'dealer', entidad_id: req.params.id, detalle: `Eliminó el dealer #${req.params.id}` });
    res.json({ success: true, data: { mensaje: 'Dealer eliminado' }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

module.exports = { getDealers, getDealer, getCcsList, importar, createDealer, updateDealer, deleteDealer };
