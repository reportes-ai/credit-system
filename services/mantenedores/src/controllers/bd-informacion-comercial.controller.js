'use strict';
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const TABLE = 'informacion_comercial';
const PK    = 'id';
const DATE_FIELDS = ['created_at', 'updated_at'];
const COL_ORDER   = ['id', 'rut_cliente', 'monto_protestos', 'protestos_vigentes_q',
  'deuda_vigente_total', 'deuda_morosa', 'deuda_castigada'];

const fmtDates = r => { DATE_FIELDS.forEach(f => {
  if (r[f] instanceof Date) r[f] = r[f].toISOString().slice(0, 19).replace('T', ' ');
  else if (r[f] && typeof r[f] === 'string' && r[f].includes('T')) r[f] = r[f].slice(0, 19).replace('T', ' ');
}); return r; };

const getColumns = async (req, res) => {
  try {
    const [rows] = await pool.query(`DESCRIBE ${TABLE}`);
    const priority = COL_ORDER.map(f => rows.find(r => r.Field === f)).filter(Boolean);
    const rest     = rows.filter(r => !COL_ORDER.includes(r.Field));
    const cols = [...priority, ...rest].map(r => ({ field: r.Field, type: r.Type, nullable: r.Null === 'YES', key: r.Key }));
    res.json({ success: true, data: cols, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const getAll = async (req, res) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page)  || 1);
    const limit   = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
    const offset  = (page - 1) * limit;
    const sortCol = req.query.sort || PK;
    const sortDir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

    const [colRows] = await pool.query(`DESCRIBE ${TABLE}`);
    const validCols = colRows.map(r => r.Field);
    const safeSort  = validCols.includes(sortCol) ? sortCol : PK;

    const filters = req.query.filters ? JSON.parse(req.query.filters) : {};
    const where = [], vals = [];
    for (const [col, val] of Object.entries(filters)) {
      if (!validCols.includes(col) || val === '' || val == null) continue;
      where.push(`LOWER(\`${col}\`) LIKE LOWER(?)`);
      vals.push(`%${val}%`);
    }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${TABLE} ${whereStr}`, vals);
    const [rows] = await pool.query(
      `SELECT * FROM ${TABLE} ${whereStr} ORDER BY \`${safeSort}\` ${sortDir} LIMIT ? OFFSET ?`,
      [...vals, limit, offset]
    );
    res.json({ success: true, data: { rows: rows.map(fmtDates), total, page, limit, pages: Math.ceil(total / limit) }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const update = async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body;
    if (!id || !Object.keys(body).length)
      return res.status(400).json({ success: false, data: null, error: 'Sin datos' });

    const [colRows] = await pool.query(`DESCRIBE ${TABLE}`);
    const validCols = colRows.map(r => r.Field).filter(f => f !== PK);

    const sets = [], vals = [];
    for (const [col, val] of Object.entries(body)) {
      if (!validCols.includes(col)) continue;
      sets.push(`\`${col}\` = ?`);
      vals.push(val === '' ? null : val);
    }
    if (!sets.length) return res.status(400).json({ success: false, data: null, error: 'Sin campos válidos' });

    vals.push(id);
    await pool.query(`UPDATE ${TABLE} SET ${sets.join(', ')}, updated_at = NOW() WHERE ${PK} = ?`, vals);
    const [[updated]] = await pool.query(`SELECT * FROM ${TABLE} WHERE ${PK} = ?`, [id]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'informacion_comercial', entidad_id: id, detalle: `Editó información comercial (registro #${id}) desde BD`, meta: { campos: Object.keys(body) } });
    res.json({ success: true, data: fmtDates(updated), error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

module.exports = { getColumns, getAll, update };
