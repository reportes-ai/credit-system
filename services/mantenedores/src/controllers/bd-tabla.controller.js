'use strict';
/* Editor BD genérico Nivel Dios — un solo motor para las tablas whitelisteadas
   (mismo contrato que bd-operaciones/bd-clientes: columns / getAll / update). */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const TABLAS = {
  dealers:      { pk: 'id_dealer', label: 'Dealers',                       icono: 'bi-shop',                grupo: 'dealers' },
  cv_campanas:  { pk: 'id', label: 'Campañas de Venta (cv_campanas)',      icono: 'bi-telephone-outbound',  grupo: 'campanas_ventas' },
  cv_terminos:  { pk: 'id', label: 'Términos de Gestión (cv_terminos)',    icono: 'bi-sliders',             grupo: 'campanas_ventas' },
  cv_registros: { pk: 'id', label: 'Registros de Campaña (cv_registros)',  icono: 'bi-list-ul',             grupo: 'campanas_ventas' },
  cv_gestiones: { pk: 'id', label: 'Gestiones de Campaña (cv_gestiones)',  icono: 'bi-headset',             grupo: 'campanas_ventas' },
};

const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const tablaDe = req => {
  const t = TABLAS[req.params.tabla];
  return t ? { nombre: req.params.tabla, ...t } : null;
};
const fmtDates = r => { for (const k of Object.keys(r)) {
  if (r[k] instanceof Date) r[k] = r[k].toISOString().slice(0, 19).replace('T', ' ');
} return r; };

exports.catalogo = (req, res) =>
  res.json({ success: true, data: Object.entries(TABLAS).map(([nombre, t]) => ({ nombre, ...t })), error: null });

exports.getColumns = async (req, res) => {
  try {
    const t = tablaDe(req);
    if (!t) return fail(res, 'Tabla no permitida', 400);
    const [rows] = await pool.query(`DESCRIBE ${t.nombre}`);
    res.json({ success: true, data: rows.map(r => ({ field: r.Field, type: r.Type, nullable: r.Null === 'YES', key: r.Key })), error: null });
  } catch (e) { fail(res, e.message); }
};

exports.getAll = async (req, res) => {
  try {
    const t = tablaDe(req);
    if (!t) return fail(res, 'Tabla no permitida', 400);
    const page   = Math.max(1, parseInt(req.query.page) || 1);
    const limit  = Math.min(200, Math.max(10, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const [colRows] = await pool.query(`DESCRIBE ${t.nombre}`);
    const validCols = colRows.map(r => r.Field);
    const safeSort  = validCols.includes(req.query.sort) ? req.query.sort : t.pk;
    const sortDir   = req.query.dir === 'asc' ? 'ASC' : 'DESC';

    const filters = req.query.filters ? JSON.parse(req.query.filters) : {};
    const where = [], vals = [];
    for (const [col, val] of Object.entries(filters)) {
      if (!validCols.includes(col) || val === '' || val == null) continue;
      where.push(`LOWER(\`${col}\`) LIKE LOWER(?)`);
      vals.push(`%${val}%`);
    }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${t.nombre} ${whereStr}`, vals);
    const [rows] = await pool.query(
      `SELECT * FROM ${t.nombre} ${whereStr} ORDER BY \`${safeSort}\` ${sortDir} LIMIT ? OFFSET ?`,
      [...vals, limit, offset]);
    res.json({ success: true, data: { rows: rows.map(fmtDates), total, page, limit, pages: Math.ceil(total / limit) }, error: null });
  } catch (e) { fail(res, e.message); }
};

exports.update = async (req, res) => {
  try {
    const t = tablaDe(req);
    if (!t) return fail(res, 'Tabla no permitida', 400);
    const { id } = req.params;
    const body = req.body || {};
    if (!id || !Object.keys(body).length) return fail(res, 'Sin datos', 400);

    const [colRows] = await pool.query(`DESCRIBE ${t.nombre}`);
    const validCols = colRows.map(r => r.Field).filter(f => f !== t.pk);

    const sets = [], vals = [];
    for (const [col, val] of Object.entries(body)) {
      if (!validCols.includes(col)) continue;
      sets.push(`\`${col}\` = ?`);
      vals.push(val === '' ? null : val);
    }
    if (!sets.length) return fail(res, 'Sin campos válidos', 400);
    if (validCols.includes('updated_at')) sets.push('updated_at = NOW()');

    vals.push(id);
    await pool.query(`UPDATE ${t.nombre} SET ${sets.join(', ')} WHERE ${t.pk} = ?`, vals);
    const [[updated]] = await pool.query(`SELECT * FROM ${t.nombre} WHERE ${t.pk} = ?`, [id]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: t.nombre, entidad_id: id,
      detalle: `Editó ${t.nombre} (registro #${id}) desde BD Nivel Dios`, meta: { campos: Object.keys(body) } });
    res.json({ success: true, data: fmtDates(updated), error: null });
  } catch (e) { fail(res, e.message); }
};
