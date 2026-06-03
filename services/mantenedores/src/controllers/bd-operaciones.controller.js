'use strict';
const pool = require('../../../../shared/config/database');

/* Columnas a excluir de la vista (internas/sensibles) */
const EXCLUIR = ['datos_json'];

/* ── GET /api/bd-operaciones/columns ─── */
const getColumns = async (req, res) => {
  try {
    const [rows] = await pool.query('DESCRIBE operaciones_brokerage');
    const cols = rows
      .filter(r => !EXCLUIR.includes(r.Field))
      .map(r => ({ field: r.Field, type: r.Type, nullable: r.Null === 'YES', key: r.Key }));
    res.json({ success: true, data: cols, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── GET /api/bd-operaciones?page=1&limit=50&filters=... ─── */
const getAll = async (req, res) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page)  || 1);
    const limit   = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
    const offset  = (page - 1) * limit;
    const sortCol = req.query.sort    || 'id';
    const sortDir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

    // Validar nombre de columna para evitar SQL injection
    const [colRows] = await pool.query('DESCRIBE operaciones_brokerage');
    const validCols = colRows.map(r => r.Field);
    const safeSort  = validCols.includes(sortCol) ? sortCol : 'id';

    // Construir WHERE desde filters JSON
    const filters = req.query.filters ? JSON.parse(req.query.filters) : {};
    const where = [], vals = [];
    for (const [col, val] of Object.entries(filters)) {
      if (!validCols.includes(col) || val === '' || val === null || val === undefined) continue;
      where.push(`LOWER(\`${col}\`) LIKE LOWER(?)`);
      vals.push(`%${val}%`);
    }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM operaciones_brokerage ${whereStr}`, vals
    );
    const [rows] = await pool.query(
      `SELECT * FROM operaciones_brokerage ${whereStr} ORDER BY \`${safeSort}\` ${sortDir} LIMIT ? OFFSET ?`,
      [...vals, limit, offset]
    );

    // Limpiar campos excluidos y formatear fechas/dates
    const DATE_FIELDS = ['mes','fecha_otorgado','fecha_primera_cuota','fecha_estado','fecha_recep_fei',
      'fecha_pago_sp','fecha_estim_pago_comaf','fecha_pago_com_dealer','fecha_recep_doc',
      'fecha_liberado_pago','fecha_pago','created_at','updated_at'];
    const data = rows.map(r => {
      EXCLUIR.forEach(f => delete r[f]);
      DATE_FIELDS.forEach(f => {
        if (r[f] instanceof Date) r[f] = r[f].toISOString().slice(0, 10);
        else if (r[f] && typeof r[f] === 'string' && r[f].includes('T')) r[f] = r[f].slice(0, 10);
      });
      return r;
    });

    res.json({ success: true, data: { rows: data, total, page, limit, pages: Math.ceil(total / limit) }, error: null });
  } catch (e) {
    console.error('[bd-operaciones getAll]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── PUT /api/bd-operaciones/:id ─── */
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body;
    if (!id || !Object.keys(body).length)
      return res.status(400).json({ success: false, data: null, error: 'Sin datos' });

    // Validar columnas
    const [colRows] = await pool.query('DESCRIBE operaciones_brokerage');
    const validCols = colRows.map(r => r.Field).filter(f => f !== 'id' && !EXCLUIR.includes(f));

    const sets = [], vals = [];
    for (const [col, val] of Object.entries(body)) {
      if (!validCols.includes(col)) continue;
      sets.push(`\`${col}\` = ?`);
      vals.push(val === '' ? null : val);
    }
    if (!sets.length) return res.status(400).json({ success: false, data: null, error: 'Sin campos válidos' });

    vals.push(id);
    await pool.query(`UPDATE operaciones_brokerage SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, vals);

    const [[updated]] = await pool.query('SELECT * FROM operaciones_brokerage WHERE id = ?', [id]);
    EXCLUIR.forEach(f => delete updated[f]);
    res.json({ success: true, data: updated, error: null });
  } catch (e) {
    console.error('[bd-operaciones update]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getColumns, getAll, update };
