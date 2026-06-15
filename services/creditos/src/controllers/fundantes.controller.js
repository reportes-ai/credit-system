const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ─── Migración ─────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fundantes_brokerage (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        id_credito       INT NOT NULL,
        nombre_documento VARCHAR(200) NOT NULL,
        tipo             VARCHAR(50)  DEFAULT 'DOCUMENTO',
        url_archivo      TEXT,
        mime_type        VARCHAR(100),
        archivo_data     LONGBLOB,
        archivo_nombre   VARCHAR(300),
        estado           VARCHAR(30)  DEFAULT 'PENDIENTE',
        comentario_rechazo TEXT,
        subido_por       VARCHAR(150),
        id_subido_por    INT,
        validado_por     VARCHAR(150),
        id_validado_por  INT,
        fecha_validacion DATETIME,
        created_at       DATETIME     DEFAULT NOW(),
        updated_at       DATETIME     DEFAULT NOW() ON UPDATE NOW(),
        INDEX idx_op (id_credito),
        INDEX idx_estado (estado)
      )
    `);
    // Homologación: operacion_id → id_credito
    const [[fc]] = await pool.query(`SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='fundantes_brokerage' AND column_name='operacion_id'`);
    if (fc.c > 0) await pool.query(`ALTER TABLE fundantes_brokerage CHANGE COLUMN operacion_id id_credito INT NOT NULL`);
    console.log('✓ fundantes_brokerage: tabla lista');
  } catch (e) {
    console.error('[fundantes migration]', e.message);
  }
})();

/* ─── helpers ─────────────────────────────────────────────────────────── */
const ANALISTAS = ['Administrador', 'Gerente', 'Analista de Crédito', 'Supervisor'];

/* ─── GET /api/fundantes?operacion_id=X ──────────────────────────────── */
const getByOperacion = async (req, res) => {
  try {
    const { operacion_id } = req.query;
    if (!operacion_id) return res.status(400).json({ success: false, data: null, error: 'operacion_id requerido' });
    const [rows] = await pool.query(
      `SELECT id, id_credito AS operacion_id, nombre_documento, tipo, archivo_nombre, mime_type,
              estado, comentario_rechazo, subido_por, validado_por, fecha_validacion, created_at
       FROM fundantes_brokerage WHERE id_credito = ? ORDER BY created_at DESC`,
      [operacion_id]
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── GET /api/fundantes/:id/download ──────────────────────────────── */
const download = async (req, res) => {
  try {
    const [[row]] = await pool.query(
      'SELECT archivo_nombre, mime_type, archivo_data FROM fundantes_brokerage WHERE id = ?',
      [req.params.id]
    );
    if (!row || !row.archivo_data) return res.status(404).json({ success: false, data: null, error: 'Archivo no encontrado' });
    res.set('Content-Type', row.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="${String(row.archivo_nombre || 'fundante').replace(/"/g, '').replace(/[^\x20-\x7E]/g, '_')}"`);
    res.send(row.archivo_data);
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── POST /api/fundantes (upload base64) ───────────────────────────── */
const upload = async (req, res) => {
  try {
    const { operacion_id, nombre_documento, tipo, archivo_nombre, mime_type, archivo_data } = req.body;
    if (!operacion_id || !nombre_documento) {
      return res.status(400).json({ success: false, data: null, error: 'operacion_id y nombre_documento requeridos' });
    }
    // Verificar operación existe
    const [[op]] = await pool.query('SELECT id FROM creditos WHERE id = ?', [operacion_id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });

    const buffer = archivo_data ? Buffer.from(archivo_data, 'base64') : null;
    const [r] = await pool.query(
      `INSERT INTO fundantes_brokerage
        (id_credito, nombre_documento, tipo, archivo_nombre, mime_type, archivo_data,
         subido_por, id_subido_por, estado)
       VALUES (?,?,?,?,?,?,?,?,'PENDIENTE')`,
      [
        operacion_id, nombre_documento, tipo || 'DOCUMENTO',
        archivo_nombre || null, mime_type || null, buffer || null,
        req.usuario?.nombre ? `${req.usuario.nombre} ${req.usuario.apellido || ''}`.trim() : null,
        req.usuario?.id_usuario || null
      ]
    );
    const [[row]] = await pool.query(
      `SELECT id, id_credito AS operacion_id, nombre_documento, tipo, archivo_nombre, mime_type,
              estado, subido_por, created_at FROM fundantes_brokerage WHERE id = ?`,
      [r.insertId]
    );

    // Actualizar estado_fundantes de la operación a CARGADOS (si estaba PENDIENTE)
    await pool.query(
      `UPDATE creditos
       SET estado_fundantes = CASE WHEN estado_fundantes = 'PENDIENTE' THEN 'CARGADOS' ELSE estado_fundantes END
       WHERE id = ?`,
      [operacion_id]
    );

    res.status(201).json({ success: true, data: row, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─── PUT /api/fundantes/:id/validar ───────────────────────────────── */
// Solo analistas pueden validar
const validar = async (req, res) => {
  try {
    const perfil = req.usuario?.perfil_nombre || '';
    if (!ANALISTAS.includes(perfil)) {
      return res.status(403).json({ success: false, data: null, error: 'Sin permisos para validar fundantes' });
    }
    const { estado, comentario_rechazo } = req.body; // APROBADO | RECHAZADO
    if (!['APROBADO', 'RECHAZADO'].includes(estado)) {
      return res.status(400).json({ success: false, data: null, error: 'estado debe ser APROBADO o RECHAZADO' });
    }
    const [[exists]] = await pool.query('SELECT id, id_credito AS operacion_id FROM fundantes_brokerage WHERE id = ?', [req.params.id]);
    if (!exists) return res.status(404).json({ success: false, data: null, error: 'Fundante no encontrado' });

    const validadoPor = `${req.usuario.nombre} ${req.usuario.apellido || ''}`.trim();
    await pool.query(
      `UPDATE fundantes_brokerage SET estado=?, comentario_rechazo=?,
       validado_por=?, id_validado_por=?, fecha_validacion=NOW() WHERE id=?`,
      [estado, comentario_rechazo || null, validadoPor, req.usuario.id_usuario || null, req.params.id]
    );

    // Recalcular estado_fundantes de la operación
    await _recalcEstadoFundantes(exists.operacion_id);

    const [[row]] = await pool.query('SELECT * FROM fundantes_brokerage WHERE id = ?', [req.params.id]);
    auditar({ req, accion: estado === 'APROBADO' ? 'VALIDAR_DOC' : 'RECHAZAR_DOC', modulo: 'documentos', entidad: 'fundante', entidad_id: req.params.id,
      detalle: `${estado === 'APROBADO' ? 'Validó' : 'Rechazó'} fundante #${req.params.id} (operación ${exists.operacion_id})${comentario_rechazo ? ` — ${comentario_rechazo}` : ''}`,
      meta: { estado, operacion_id: exists.operacion_id, comentario_rechazo: comentario_rechazo || null } });
    res.json({ success: true, data: row, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

async function _recalcEstadoFundantes(operacion_id) {
  const [rows] = await pool.query(
    'SELECT estado FROM fundantes_brokerage WHERE id_credito = ?',
    [operacion_id]
  );
  if (!rows.length) return;
  const hay_rechazado = rows.some(r => r.estado === 'RECHAZADO');
  const todos_aprobados = rows.every(r => r.estado === 'APROBADO');
  const hay_pendiente = rows.some(r => r.estado === 'PENDIENTE');
  let nuevo;
  if (hay_rechazado) nuevo = 'RECHAZADOS';
  else if (todos_aprobados) nuevo = 'APROBADOS';
  else if (hay_pendiente) nuevo = 'CARGADOS';
  else nuevo = 'CARGADOS';
  await pool.query('UPDATE creditos SET estado_fundantes=? WHERE id=?', [nuevo, operacion_id]);
}

/* ─── DELETE /api/fundantes/:id ─────────────────────────────────────── */
const remove = async (req, res) => {
  try {
    const [[exists]] = await pool.query('SELECT id_credito AS operacion_id FROM fundantes_brokerage WHERE id = ?', [req.params.id]);
    if (!exists) return res.status(404).json({ success: false, data: null, error: 'No encontrado' });
    await pool.query('DELETE FROM fundantes_brokerage WHERE id = ?', [req.params.id]);
    await _recalcEstadoFundantes(exists.operacion_id);
    res.json({ success: true, data: { eliminado: req.params.id }, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = { getByOperacion, upload, validar, remove, download };
