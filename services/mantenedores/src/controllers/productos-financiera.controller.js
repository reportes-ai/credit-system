const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ── Migración ───────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('productos-financiera', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS productos_financiera (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        financiera VARCHAR(60)  NOT NULL,
        producto   VARCHAR(200) NOT NULL,
        activo     TINYINT(1)   NOT NULL DEFAULT 1,
        orden      INT          NOT NULL DEFAULT 0,
        UNIQUE KEY uk_fin_prod (financiera, producto)
      )
    `);

    const defaults = [
      /* AUTOFIN */
      ['AUTOFIN', 'CREDITO CC NUEVO AUTOFIN APROB 10',           1, 1],
      ['AUTOFIN', 'CREDITO CC AUTOMALL AUTOFIN',                 1, 2],
      ['AUTOFIN', 'CREDITO CC AUTOFIN PARQUE CARMOONS',          1, 3],
      ['AUTOFIN', 'CREDITO CC AUTOFIN PARQUE PANAMERICANA',      1, 4],
      ['AUTOFIN', 'CREDITO CC AUTOFIN PARQUE AUTOMOTRIZ OESTE',  1, 5],
      ['AUTOFIN', 'CREDITO CC AUTOFIN PARQUE AUTOCENTER QUILICURA', 1, 6],
      ['AUTOFIN', 'CREDITO AUTOFIN PARQUE MAIPU',                1, 7],
      ['AUTOFIN', 'CREDITO AUTOFIN AUTOPARQUE LONQUEN',          1, 8],
      ['AUTOFIN', 'AUTOFIN - CREDITO CONVENCIONAL',              1, 9],
      ['AUTOFIN', 'AUTOFIN - CREDITO CORFO',                     1, 10],
      ['AUTOFIN', 'AUTOFIN - PARQUE - CREDITO CONVENCIONAL',     1, 11],
      ['AUTOFIN', 'PRODUCTO CORFO AUTOFIN MAYOR - MENOR 200 UF', 1, 12],
      /* UNIDAD DE CREDITO */
      ['UNIDAD DE CREDITO', 'CREDITO CC UNIDAD APROB 11',        1, 1],
      ['UNIDAD DE CREDITO', 'UNIDAD - CREDITO CONVENCIONAL',     1, 2],
      ['UNIDAD DE CREDITO', 'UNIDAD - PARQUE - CREDITO CONVENCIONAL', 1, 3],
    ];

    for (const [financiera, producto, activo, orden] of defaults) {
      await pool.query(
        `INSERT IGNORE INTO productos_financiera (financiera, producto, activo, orden) VALUES (?,?,?,?)`,
        [financiera, producto, activo, orden]
      );
    }
  } catch (e) {
    console.error('[productos-financiera migration]', e.message);
  }
});

/* ── GET /api/productos-financiera?financiera=XXX&activo=1 ───────────────── */
const getAll = async (req, res) => {
  try {
    const { financiera, activo } = req.query;
    const conds = [], params = [];
    if (financiera) { conds.push('financiera = ?'); params.push(financiera); }
    if (activo !== undefined) { conds.push('activo = ?'); params.push(parseInt(activo)); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const [rows] = await pool.query(
      `SELECT * FROM productos_financiera ${where} ORDER BY financiera, orden, producto`,
      params
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── POST /api/productos-financiera ─────────────────────────────────────── */
const create = async (req, res) => {
  try {
    const { financiera, producto, activo = 1, orden = 0 } = req.body;
    if (!financiera || !producto) return res.status(400).json({ success: false, data: null, error: 'financiera y producto son requeridos' });
    const [r] = await pool.query(
      'INSERT INTO productos_financiera (financiera, producto, activo, orden) VALUES (?,?,?,?)',
      [financiera.trim(), producto.trim(), activo ? 1 : 0, parseInt(orden) || 0]
    );
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'producto_financiera', entidad_id: r.insertId, detalle: `Creó producto "${producto.trim()}" (${financiera.trim()})`, meta: req.body });
    res.json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ success: false, data: null, error: 'Ya existe ese producto para esa financiera' });
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── PUT /api/productos-financiera/:id ───────────────────────────────────── */
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const { financiera, producto, activo, orden } = req.body;
    const sets = [], params = [];
    if (financiera !== undefined) { sets.push('financiera=?'); params.push(financiera.trim()); }
    if (producto  !== undefined) { sets.push('producto=?');   params.push(producto.trim()); }
    if (activo    !== undefined) { sets.push('activo=?');     params.push(activo ? 1 : 0); }
    if (orden     !== undefined) { sets.push('orden=?');      params.push(parseInt(orden) || 0); }
    if (!sets.length) return res.status(400).json({ success: false, data: null, error: 'Nada que actualizar' });
    params.push(id);
    await pool.query(`UPDATE productos_financiera SET ${sets.join(',')} WHERE id=?`, params);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'producto_financiera', entidad_id: id, detalle: `Editó producto de financiera #${id}`, meta: req.body });
    res.json({ success: true, data: null, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── DELETE /api/productos-financiera/:id ────────────────────────────────── */
const remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM productos_financiera WHERE id=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'producto_financiera', entidad_id: req.params.id, detalle: `Eliminó producto de financiera #${req.params.id}` });
    res.json({ success: true, data: null, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getAll, create, update, remove };
