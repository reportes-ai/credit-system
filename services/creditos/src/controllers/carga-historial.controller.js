'use strict';
const pool = require('../../../../shared/config/database');
const XLSX = require('xlsx');

/* ── Migración ──────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('carga-historial', async () => {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS carga_sesiones (
       id          INT AUTO_INCREMENT PRIMARY KEY,
       fuente      VARCHAR(30) NOT NULL COMMENT 'autofacil | trinidad',
       usuario     VARCHAR(200),
       archivo     VARCHAR(300),
       insertados  INT DEFAULT 0,
       actualizados INT DEFAULT 0,
       errores     INT DEFAULT 0,
       total       INT DEFAULT 0,
       created_at  DATETIME DEFAULT NOW(),
       KEY idx_fuente (fuente)
     )`,
    `CREATE TABLE IF NOT EXISTS carga_detalle (
       id          INT AUTO_INCREMENT PRIMARY KEY,
       sesion_id   INT NOT NULL,
       num_op      INT,
       accion      VARCHAR(20) COMMENT 'insert | update',
       datos       JSON,
       created_at  DATETIME DEFAULT NOW(),
       KEY idx_sesion (sesion_id),
       KEY idx_numop (num_op)
     )`,
    `CREATE TABLE IF NOT EXISTS carga_cambios (
       id             INT AUTO_INCREMENT PRIMARY KEY,
       sesion_id      INT NOT NULL,
       num_op         INT,
       campo          VARCHAR(100),
       valor_anterior TEXT,
       valor_nuevo    TEXT,
       created_at     DATETIME DEFAULT NOW(),
       KEY idx_sesion (sesion_id),
       KEY idx_numop (num_op)
     )`,
  ];
  for (const sql of sqls) {
    try { await pool.query(sql); } catch (e) { console.error('[carga-historial migration]', e.message); }
  }
});

/* ═══════════════════ HELPERS (usados desde otros controllers) ═══════════════ */

exports.crearSesion = async ({ fuente, usuario, archivo, insertados = 0, actualizados = 0, errores = 0, total = 0 }) => {
  const [r] = await pool.query(
    `INSERT INTO carga_sesiones (fuente, usuario, archivo, insertados, actualizados, errores, total)
     VALUES (?,?,?,?,?,?,?)`,
    [fuente, usuario || null, archivo || null, insertados, actualizados, errores, total]
  );
  return r.insertId;
};

exports.logDetalle = async (sesionId, numOp, accion, datos) => {
  await pool.query(
    `INSERT INTO carga_detalle (sesion_id, num_op, accion, datos) VALUES (?,?,?,?)`,
    [sesionId, numOp, accion, JSON.stringify(datos)]
  );
};

exports.logCambio = async (sesionId, numOp, campo, valorAnterior, valorNuevo) => {
  await pool.query(
    `INSERT INTO carga_cambios (sesion_id, num_op, campo, valor_anterior, valor_nuevo)
     VALUES (?,?,?,?,?)`,
    [sesionId, numOp, campo, valorAnterior != null ? String(valorAnterior) : null, valorNuevo != null ? String(valorNuevo) : null]
  );
};

/* ═══════════════════ GET SESIONES ═══════════════════════════════ */

exports.getSesiones = async (req, res) => {
  try {
    const { fuente, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;
    const where  = fuente ? 'WHERE fuente = ?' : '';
    const params = fuente ? [fuente, parseInt(limit), parseInt(offset)]
                          : [parseInt(limit), parseInt(offset)];
    const [rows] = await pool.query(
      `SELECT * FROM carga_sesiones ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      params
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM carga_sesiones ${where}`,
      fuente ? [fuente] : []
    );
    return res.json({ success: true, data: { rows, total, page: +page, limit: +limit } });
  } catch (e) { return res.json({ success: false, error: e.message }); }
};

/* ═══════════════════ GET DETALLE SESIÓN ════════════════════════ */

exports.getDetalleSesion = async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 100 } = req.query;
    const offset = (page - 1) * limit;

    const [[sesion]] = await pool.query('SELECT * FROM carga_sesiones WHERE id = ?', [id]);
    if (!sesion) return res.json({ success: false, error: 'Sesión no encontrada' });

    const [rows] = await pool.query(
      `SELECT * FROM carga_detalle WHERE sesion_id = ? ORDER BY id LIMIT ? OFFSET ?`,
      [id, parseInt(limit), parseInt(offset)]
    );
    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM carga_detalle WHERE sesion_id = ?', [id]
    );
    return res.json({ success: true, data: { sesion, rows, total, page: +page, limit: +limit } });
  } catch (e) { return res.json({ success: false, error: e.message }); }
};

/* ═══════════════════ GET CAMBIOS ════════════════════════════════ */

exports.getCambios = async (req, res) => {
  try {
    const { sesion_id, page = 1, limit = 100 } = req.query;
    const offset = (page - 1) * limit;
    const where  = sesion_id ? 'WHERE sesion_id = ?' : '';
    const params = sesion_id
      ? [parseInt(sesion_id), parseInt(limit), parseInt(offset)]
      : [parseInt(limit), parseInt(offset)];

    const [rows] = await pool.query(
      `SELECT cc.*, cs.fuente, cs.usuario, cs.archivo, cs.created_at AS sesion_fecha
       FROM carga_cambios cc
       JOIN carga_sesiones cs ON cs.id = cc.sesion_id
       ${where} ORDER BY cc.id DESC LIMIT ? OFFSET ?`,
      params
    );
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM carga_cambios ${where}`,
      sesion_id ? [parseInt(sesion_id)] : []
    );
    return res.json({ success: true, data: { rows, total, page: +page, limit: +limit } });
  } catch (e) { return res.json({ success: false, error: e.message }); }
};

/* ═══════════════════ DOWNLOAD DETALLE EXCEL ════════════════════ */

exports.downloadDetalle = async (req, res) => {
  try {
    const { id } = req.params;
    const [[sesion]] = await pool.query('SELECT * FROM carga_sesiones WHERE id = ?', [id]);
    if (!sesion) return res.status(404).json({ success: false, error: 'Sesión no encontrada' });

    const [rows] = await pool.query(
      'SELECT * FROM carga_detalle WHERE sesion_id = ? ORDER BY id',
      [id]
    );

    // Aplanar el JSON de datos para las columnas
    const flat = rows.map(r => {
      const d = typeof r.datos === 'string' ? JSON.parse(r.datos) : (r.datos || {});
      return {
        'N° Registro': r.id,
        'N° Op':       r.num_op,
        'Acción':      r.accion === 'insert' ? 'Nuevo' : 'Actualización',
        'Fecha carga': r.created_at,
        ...Object.fromEntries(
          Object.entries(d).map(([k, v]) => [k, v != null ? String(v) : ''])
        ),
      };
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(flat);
    XLSX.utils.book_append_sheet(wb, ws, 'Detalle carga');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fecha = String(sesion.created_at).slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="carga_${sesion.fuente}_${fecha}_sesion${id}.xlsx"`);
    return res.send(buf);
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
};

/* ═══════════════════ DOWNLOAD CAMBIOS EXCEL ════════════════════ */

exports.downloadCambios = async (req, res) => {
  try {
    const { sesion_id } = req.query;
    const where  = sesion_id ? 'WHERE cc.sesion_id = ?' : '';
    const params = sesion_id ? [parseInt(sesion_id)] : [];

    const [rows] = await pool.query(
      `SELECT cc.id, cc.sesion_id, cs.fuente, cs.usuario, cs.archivo,
              cc.num_op, cc.campo, cc.valor_anterior, cc.valor_nuevo,
              cc.created_at
       FROM carga_cambios cc
       JOIN carga_sesiones cs ON cs.id = cc.sesion_id
       ${where} ORDER BY cc.id DESC`,
      params
    );

    const flat = rows.map(r => ({
      'ID cambio':    r.id,
      'Sesión':       r.sesion_id,
      'Fuente':       r.fuente,
      'Usuario':      r.usuario || '',
      'Archivo':      r.archivo || '',
      'N° Op':        r.num_op,
      'Campo':        r.campo,
      'Valor anterior': r.valor_anterior ?? '',
      'Valor nuevo':    r.valor_nuevo ?? '',
      'Fecha':          r.created_at,
    }));

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(flat);
    XLSX.utils.book_append_sheet(wb, ws, 'Historial cambios');

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const tag = sesion_id ? `_sesion${sesion_id}` : '_todos';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="cambios${tag}.xlsx"`);
    return res.send(buf);
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
};
