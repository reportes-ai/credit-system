'use strict';
const pool = require('../../../../shared/config/database');
const { isMesCerrado, getMesDeOp } = require('../../../../shared/utils/mes-cerrado');
const { auditar } = require('../../../../shared/audit');
const { tieneFunc } = require('../../../../shared/middleware/permisos');

/* Columnas a excluir de la vista (internas/sensibles) */
const EXCLUIR = ['datos_json'];

/* ── GET /api/bd-operaciones/columns ─── */
const getColumns = async (req, res) => {
  try {
    const [rows] = await pool.query('DESCRIBE creditos');
    const cols = rows
      .filter(r => !EXCLUIR.includes(r.Field))
      .map(r => ({ field: r.Field, type: r.Type, nullable: r.Null === 'YES', key: r.Key }));
    // Columna derivada: RUT del cliente (viene de clientes.rut vía id_cliente). Solo lectura.
    const rutCol = { field: 'rut_cliente', type: 'varchar (cliente)', nullable: true, key: '', readonly: true };
    const idx = cols.findIndex(c => c.field === 'id_cliente');
    if (idx >= 0) cols.splice(idx + 1, 0, rutCol); else cols.push(rutCol);
    // Mostrar id_financiera (número de la institución) justo después de num_op (columna C)
    const idxFin = cols.findIndex(c => c.field === 'id_financiera');
    if (idxFin >= 0) {
      const [finCol] = cols.splice(idxFin, 1);
      const idxNumOp = cols.findIndex(c => c.field === 'num_op');
      if (idxNumOp >= 0) cols.splice(idxNumOp + 1, 0, finCol); else cols.push(finCol);
    }
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
    const [colRows] = await pool.query('DESCRIBE creditos');
    const validCols = colRows.map(r => r.Field);
    // Orden: columnas de creditos con alias cr.; rut_cliente es derivada (cl.rut)
    const sortExpr = sortCol === 'rut_cliente'
      ? 'cl.rut'
      : 'cr.`' + (validCols.includes(sortCol) ? sortCol : 'id') + '`';

    // Construir WHERE desde filters JSON
    const filters = req.query.filters ? JSON.parse(req.query.filters) : {};
    const where = [], vals = [];
    for (const [col, val] of Object.entries(filters)) {
      if (val === '' || val === null || val === undefined) continue;
      if (col === 'rut_cliente') { where.push('LOWER(cl.rut) LIKE LOWER(?)'); vals.push(`%${val}%`); continue; }
      if (!validCols.includes(col)) continue;
      where.push(`LOWER(cr.\`${col}\`) LIKE LOWER(?)`);
      vals.push(`%${val}%`);
    }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const FROM = 'FROM creditos cr LEFT JOIN clientes cl ON cl.id_cliente = cr.id_cliente';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total ${FROM} ${whereStr}`, vals
    );
    const [rows] = await pool.query(
      `SELECT cr.*, cl.rut AS rut_cliente ${FROM} ${whereStr} ORDER BY ${sortExpr} ${sortDir} LIMIT ? OFFSET ?`,
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

    // Mes cerrado: el analista NO puede tocar meses cerrados; nivel Dios (Solo Dios) sí.
    const god = await tieneFunc(req.usuario.id_usuario, 'mantenedores_solo_dios');
    if (!god) {
      const mes = await getMesDeOp(id);
      if (mes && await isMesCerrado(mes)) {
        return res.status(403).json({ success: false, data: null, error: `🔒 Mes ${mes} cerrado — no se permiten modificaciones` });
      }
    }

    // Validar columnas
    const [colRows] = await pool.query('DESCRIBE creditos');
    const validCols = colRows.map(r => r.Field).filter(f => f !== 'id' && !EXCLUIR.includes(f));

    const sets = [], vals = [];
    for (const [col, val] of Object.entries(body)) {
      if (!validCols.includes(col)) continue;
      sets.push(`\`${col}\` = ?`);
      vals.push(val === '' ? null : val);
    }
    if (!sets.length) return res.status(400).json({ success: false, data: null, error: 'Sin campos válidos' });

    vals.push(id);
    await pool.query(`UPDATE creditos SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, vals);

    const [[updated]] = await pool.query('SELECT * FROM creditos WHERE id = ?', [id]);
    EXCLUIR.forEach(f => delete updated[f]);
    auditar({ req, accion: 'EDITAR', modulo: 'creditos', entidad: 'credito', entidad_id: id,
      detalle: `Editó el crédito #${id} desde BD Operaciones (${sets.length} campo/s)`, meta: { campos: Object.keys(body) } });
    res.json({ success: true, data: updated, error: null });
  } catch (e) {
    console.error('[bd-operaciones update]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ── DELETE /api/bd-operaciones ─── */
const deleteMany = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ success: false, data: null, error: 'ids requerido' });

    const safeIds = ids.map(Number).filter(n => Number.isInteger(n) && n > 0);
    if (!safeIds.length)
      return res.status(400).json({ success: false, data: null, error: 'IDs inválidos' });

    const placeholders = safeIds.map(() => '?').join(',');
    const [result] = await pool.query(
      `DELETE FROM creditos WHERE id IN (${placeholders})`, safeIds
    );
    auditar({ req, accion: 'ELIMINAR', modulo: 'creditos', entidad: 'credito', entidad_id: safeIds.length === 1 ? safeIds[0] : `${safeIds.length} ops`,
      detalle: `Eliminó ${result.affectedRows} crédito(s) desde BD Operaciones`, meta: { ids: safeIds, deleted: result.affectedRows } });
    res.json({ success: true, data: { deleted: result.affectedRows }, error: null });
  } catch (e) {
    console.error('[bd-operaciones delete]', e.message);
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

module.exports = { getColumns, getAll, update, deleteMany };
