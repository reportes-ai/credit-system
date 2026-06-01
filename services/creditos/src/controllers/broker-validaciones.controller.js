const pool  = require('../../../../shared/config/database');
const audit = require('../../../../shared/auditoria');

// ── Migración ──────────────────────────────────────────────────────────────
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS broker_validation_items (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        financiera VARCHAR(30)  NOT NULL,
        texto      VARCHAR(200) NOT NULL,
        orden      INT          DEFAULT 0,
        activo     TINYINT(1)   DEFAULT 1,
        created_at DATETIME     DEFAULT NOW(),
        updated_at DATETIME     DEFAULT NOW() ON UPDATE NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS broker_validaciones (
        id                   INT AUTO_INCREMENT PRIMARY KEY,
        id_credito           INT          NOT NULL,
        id_item              INT          NOT NULL,
        valor                ENUM('SI','NO','NA') NULL,
        validado_por         VARCHAR(150) NULL,
        id_usuario_validador INT          NULL,
        created_at           DATETIME     DEFAULT NOW(),
        updated_at           DATETIME     DEFAULT NOW() ON UPDATE NOW(),
        UNIQUE KEY uk_credito_item (id_credito, id_item)
      )
    `);
    // Seed items por defecto si tabla vacía
    const [[cnt]] = await pool.query('SELECT COUNT(*) AS n FROM broker_validation_items');
    if (!cnt.n) {
      const defaults = [
        ['AUTOFIN', 'Cédula de Identidad',   1],
        ['AUTOFIN', 'Comprobante Domicilio',  2],
        ['AUTOFIN', 'Certificado AFP',        3],
        ['AUTOFIN', 'Acreditación Renta',     4],
        ['AUTOFIN', 'Referencias',            5],
        ['UNIDAD',  'Cédula de Identidad',    1],
        ['UNIDAD',  'Comprobante Domicilio',   2],
        ['UNIDAD',  'Certificado AFP',         3],
        ['UNIDAD',  'Acreditación Renta',      4],
        ['UNIDAD',  'Referencias',             5],
      ];
      for (const [fin, texto, orden] of defaults) {
        await pool.query(
          'INSERT INTO broker_validation_items (financiera, texto, orden) VALUES (?,?,?)',
          [fin, texto, orden]
        );
      }
      console.log('✓ broker_validation_items: seed por defecto insertado');
    }
    console.log('✓ broker_validation: tablas listas');
  } catch(e) { console.error('[broker-validaciones migration]', e.message); }
})();

// ── Items (catálogo) ───────────────────────────────────────────────────────
const getItems = async (req, res) => {
  try {
    const { financiera, todos } = req.query;
    let sql = `SELECT * FROM broker_validation_items WHERE 1=1`;
    const p = [];
    if (!todos) { sql += ' AND activo=1'; }
    if (financiera) { sql += ' AND financiera=?'; p.push(financiera.toUpperCase()); }
    sql += ' ORDER BY financiera, orden, id';
    const [rows] = await pool.query(sql, p);
    res.json({ success: true, data: rows, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const createItem = async (req, res) => {
  try {
    const { financiera, texto, orden = 0 } = req.body;
    if (!financiera || !texto)
      return res.status(400).json({ success: false, data: null, error: 'financiera y texto requeridos' });
    const [r] = await pool.query(
      'INSERT INTO broker_validation_items (financiera, texto, orden) VALUES (?,?,?)',
      [financiera.toUpperCase(), texto.trim(), parseInt(orden) || 0]
    );
    const [[row]] = await pool.query('SELECT * FROM broker_validation_items WHERE id=?', [r.insertId]);
    res.status(201).json({ success: true, data: row, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const updateItem = async (req, res) => {
  try {
    const { id } = req.params;
    const { texto, orden, activo, financiera } = req.body;
    const [[ex]] = await pool.query('SELECT id FROM broker_validation_items WHERE id=?', [id]);
    if (!ex) return res.status(404).json({ success: false, data: null, error: 'Item no encontrado' });
    await pool.query(
      'UPDATE broker_validation_items SET texto=?, orden=?, activo=?, financiera=?, updated_at=NOW() WHERE id=?',
      [texto, parseInt(orden) ?? 0, activo != null ? (activo ? 1 : 0) : 1,
       (financiera || '').toUpperCase(), id]
    );
    const [[row]] = await pool.query('SELECT * FROM broker_validation_items WHERE id=?', [id]);
    res.json({ success: true, data: row, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const deleteItem = async (req, res) => {
  try {
    await pool.query(
      'UPDATE broker_validation_items SET activo=0, updated_at=NOW() WHERE id=?',
      [req.params.id]
    );
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

// ── Validaciones por crédito ───────────────────────────────────────────────
const getValidaciones = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM broker_validaciones WHERE id_credito=?',
      [req.params.creditId]
    );
    res.json({ success: true, data: rows, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const saveValidaciones = async (req, res) => {
  try {
    const { creditId } = req.params;
    const { validaciones, validado_por } = req.body;
    if (!Array.isArray(validaciones))
      return res.status(400).json({ success: false, data: null, error: 'validaciones debe ser array' });
    const id_usuario = req.usuario?.id_usuario || null;
    const nombreFinal = validado_por || req.usuario?.nombre || null;

    for (const v of validaciones) {
      await pool.query(`
        INSERT INTO broker_validaciones (id_credito, id_item, valor, validado_por, id_usuario_validador)
        VALUES (?,?,?,?,?)
        ON DUPLICATE KEY UPDATE
          valor                = VALUES(valor),
          validado_por         = VALUES(validado_por),
          id_usuario_validador = VALUES(id_usuario_validador),
          updated_at           = NOW()
      `, [creditId, v.id_item, v.valor || null, nombreFinal, id_usuario]);
    }

    // Auditoría: si todos son SI, registrar validación completa
    const allSI = validaciones.length > 0 && validaciones.every(v => v.valor === 'SI');
    if (allSI) {
      audit.registrar({
        id_credito: parseInt(creditId), req,
        accion:  'DOCUMENTOS_VALIDADOS',
        detalle: `Documentos validados por ${nombreFinal || 'usuario'}`,
        meta:    { validaciones, validado_por: nombreFinal },
      });
    }

    const [rows] = await pool.query('SELECT * FROM broker_validaciones WHERE id_credito=?', [creditId]);
    res.json({ success: true, data: rows, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

module.exports = { getItems, createItem, updateItem, deleteItem, getValidaciones, saveValidaciones };
