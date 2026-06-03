'use strict';
const pool = require('../../../../shared/config/database');

/* Campos duplicados/vacíos excluidos de la vista */
const EXCLUIR = ['nombre', 'correo', 'telefono'];

/* Orden preferido de columnas */
const COL_ORDER = ['id_cliente','rut','nombres','apellido_paterno','apellido_materno','nombre_completo','email','telefono_movil'];

const DATE_FIELDS = ['fecha_creacion','fecha_nacimiento','fecha_visa',
  'fecha_inicio_actividad','fecha_actualizacion'];

/* ── GET /api/bd-clientes/columns ─── */
const getColumns = async (req, res) => {
  try {
    const [rows] = await pool.query('DESCRIBE clientes');
    const all = rows.filter(r => !EXCLUIR.includes(r.Field));
    // Ordenar: primeras las de COL_ORDER, luego el resto
    const priority = COL_ORDER.map(f => all.find(r => r.Field === f)).filter(Boolean);
    const rest     = all.filter(r => !COL_ORDER.includes(r.Field));
    const cols = [...priority, ...rest].map(r => ({ field: r.Field, type: r.Type, nullable: r.Null === 'YES', key: r.Key }));
    res.json({ success: true, data: cols, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── GET /api/bd-clientes?page=1&limit=50&filters=... ─── */
const getAll = async (req, res) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page)  || 1);
    const limit   = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
    const offset  = (page - 1) * limit;
    const sortCol = req.query.sort    || 'id_cliente';
    const sortDir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

    const [colRows] = await pool.query('DESCRIBE clientes');
    const validCols = colRows.map(r => r.Field);
    const safeSort  = validCols.includes(sortCol) ? sortCol : 'id_cliente';

    const filters = req.query.filters ? JSON.parse(req.query.filters) : {};
    const where = [], vals = [];
    for (const [col, val] of Object.entries(filters)) {
      if (!validCols.includes(col) || val === '' || val === null || val === undefined) continue;
      where.push(`LOWER(\`${col}\`) LIKE LOWER(?)`);
      vals.push(`%${val}%`);
    }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM clientes ${whereStr}`, vals
    );
    const [rows] = await pool.query(
      `SELECT * FROM clientes ${whereStr} ORDER BY \`${safeSort}\` ${sortDir} LIMIT ? OFFSET ?`,
      [...vals, limit, offset]
    );

    const data = rows.map(r => {
      DATE_FIELDS.forEach(f => {
        if (r[f] instanceof Date) r[f] = r[f].toISOString().slice(0, 10);
        else if (r[f] && typeof r[f] === 'string' && r[f].includes('T')) r[f] = r[f].slice(0, 10);
      });
      return r;
    });

    res.json({ success: true, data: { rows: data, total, page, limit, pages: Math.ceil(total / limit) }, error: null });
  } catch (e) {
    console.error('[bd-clientes getAll]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── GET /api/bd-clientes/:id/operaciones ─── */
const getOperaciones = async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query(
      `SELECT id, num_op, mes, financiera, monto, plazo, estado, monto_comision_fin, rut_cliente
       FROM operaciones_brokerage WHERE id_cliente = ? ORDER BY mes DESC, id DESC`,
      [id]
    );
    const data = rows.map(r => {
      if (r.mes instanceof Date) r.mes = r.mes.toISOString().slice(0, 10);
      else if (r.mes && typeof r.mes === 'string' && r.mes.includes('T')) r.mes = r.mes.slice(0, 10);
      return r;
    });
    res.json({ success: true, data, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── PUT /api/bd-clientes/:id ─── */
const update = async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body;
    if (!id || !Object.keys(body).length)
      return res.status(400).json({ success: false, data: null, error: 'Sin datos' });

    const [colRows] = await pool.query('DESCRIBE clientes');
    const validCols = colRows.map(r => r.Field).filter(f => f !== 'id_cliente');

    const sets = [], vals = [];
    for (const [col, val] of Object.entries(body)) {
      if (!validCols.includes(col)) continue;
      sets.push(`\`${col}\` = ?`);
      vals.push(val === '' ? null : val);
    }
    if (!sets.length) return res.status(400).json({ success: false, data: null, error: 'Sin campos válidos' });

    vals.push(id);
    await pool.query(
      `UPDATE clientes SET ${sets.join(', ')}, fecha_actualizacion = NOW() WHERE id_cliente = ?`,
      vals
    );

    const [[updated]] = await pool.query('SELECT * FROM clientes WHERE id_cliente = ?', [id]);
    DATE_FIELDS.forEach(f => {
      if (updated[f] instanceof Date) updated[f] = updated[f].toISOString().slice(0, 10);
    });
    res.json({ success: true, data: updated, error: null });
  } catch (e) {
    console.error('[bd-clientes update]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getColumns, getAll, getOperaciones, update };
