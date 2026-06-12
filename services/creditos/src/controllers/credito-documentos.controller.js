const pool  = require('../../../../shared/config/database');
const audit = require('../../../../shared/auditoria');

(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credito_documentos (
        id_doc         INT AUTO_INCREMENT PRIMARY KEY,
        id_credito     INT         NOT NULL,
        id_tipo        INT         NOT NULL,
        archivo_nombre VARCHAR(500),
        archivo_size   INT,
        mime_type      VARCHAR(100),
        archivo_data   LONGBLOB,
        comentario     TEXT        NULL,
        subido_at      DATETIME    DEFAULT CURRENT_TIMESTAMP,
        subido_por     INT         NULL
      )
    `);
    // Agrega columnas si la tabla ya existía
    await pool.query(`ALTER TABLE credito_documentos ADD COLUMN comentario TEXT NULL`)
      .catch(e => { if (e.errno !== 1060) throw e; });
    await pool.query(`ALTER TABLE credito_documentos ADD COLUMN aprobado TINYINT NULL`)
      .catch(e => { if (e.errno !== 1060) throw e; });
    await pool.query(`ALTER TABLE credito_documentos ADD COLUMN aprobado_por VARCHAR(200) NULL`)
      .catch(e => { if (e.errno !== 1060) throw e; });
    await pool.query(`ALTER TABLE credito_documentos ADD COLUMN rechazado_por VARCHAR(200) NULL`)
      .catch(e => { if (e.errno !== 1060) throw e; });
    await pool.query(`ALTER TABLE credito_documentos ADD COLUMN aprobado_at DATETIME NULL`)
      .catch(e => { if (e.errno !== 1060) throw e; });
    // Bitácora de visualizaciones (para informe de Riesgo Operacional)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credito_documento_vistos (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        id_doc         INT      NOT NULL,
        id_credito     INT      NULL,
        id_usuario     INT      NULL,
        usuario_nombre VARCHAR(200) NULL,
        usuario_email  VARCHAR(200) NULL,
        visto_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_doc (id_doc),
        INDEX idx_credito (id_credito)
      )
    `);
  } catch(e) { if (e.errno !== 1050) console.error('[credito_documentos migration]', e.message); }
})();

/* ─── GET por crédito (sin datos binarios) ──────────────────────────────── */
const getByCredito = async (req, res) => {
  try {
    const idUser = req.usuario?.id_usuario || null;
    const [rows] = await pool.query(
      `SELECT cd.id_doc, cd.id_credito, cd.id_tipo, cd.archivo_nombre, cd.archivo_size, cd.mime_type,
              cd.comentario, cd.subido_at, cd.subido_por,
              cd.aprobado, cd.aprobado_por, cd.rechazado_por, cd.aprobado_at,
              EXISTS(SELECT 1 FROM credito_documento_vistos v
                     WHERE v.id_doc = cd.id_doc AND (? IS NULL OR v.id_usuario = ?)) AS visto
       FROM credito_documentos cd WHERE cd.id_credito = ? ORDER BY cd.id_tipo, cd.subido_at DESC`,
      [idUser, idUser, req.params.id_credito]
    );
    res.json({ success: true, data: rows, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

/* ─── UPLOAD (base64 en JSON) ───────────────────────────────────────────── */
const upload = async (req, res) => {
  try {
    const { id_credito, id_tipo, archivo_nombre, archivo_size, mime_type, archivo_data, comentario } = req.body;
    if (!id_credito || !id_tipo || !archivo_data)
      return res.status(400).json({ success: false, data: null, error: 'id_credito, id_tipo y archivo_data son requeridos' });

    const buffer     = Buffer.from(archivo_data, 'base64');
    const id_usuario = req.usuario?.id_usuario || null;

    // Nombre legible del tipo de documento
    let tipoNombre = `tipo ID ${id_tipo}`;
    try {
      const [tn] = await pool.query('SELECT nombre FROM tipos_documento WHERE id_tipo=?', [id_tipo]);
      if (tn.length) tipoNombre = tn[0].nombre;
    } catch(e) {}

    // Reemplaza el doc anterior del mismo tipo para este crédito
    await pool.query('DELETE FROM credito_documentos WHERE id_credito=? AND id_tipo=?', [id_credito, id_tipo]);

    const [r] = await pool.query(
      `INSERT INTO credito_documentos
         (id_credito, id_tipo, archivo_nombre, archivo_size, mime_type, archivo_data, comentario, subido_por)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id_credito, id_tipo, archivo_nombre || 'documento', archivo_size || buffer.length,
       mime_type || 'application/octet-stream', buffer, comentario || null, id_usuario]
    );
    audit.registrar({
      id_credito, req,
      accion: 'DOCUMENTO_CARGADO',
      detalle: `${tipoNombre}: ${archivo_nombre || 'documento'}`,
      meta: { id_tipo, tipo_nombre: tipoNombre, archivo_nombre, archivo_size: archivo_size || buffer.length, mime_type },
    });
    res.status(201).json({ success: true, data: { id_doc: r.insertId }, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

/* ─── PATCH comentario ───────────────────────────────────────────────────── */
const updateComentario = async (req, res) => {
  try {
    const { comentario } = req.body;
    await pool.query('UPDATE credito_documentos SET comentario=? WHERE id_doc=?',
      [comentario || null, req.params.id_doc]);
    res.json({ success: true, data: { id_doc: req.params.id_doc }, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

/* ─── VIEW inline (para previsualización) ───────────────────────────────── */
const view = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT archivo_nombre, mime_type, archivo_data FROM credito_documentos WHERE id_doc=?',
      [req.params.id_doc]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Documento no encontrado' });
    const doc = rows[0];
    // Registrar visualización (bitácora Riesgo Operacional) — fire & forget
    const u = req.usuario || {};
    pool.query(
      `INSERT INTO credito_documento_vistos (id_doc, id_credito, id_usuario, usuario_nombre, usuario_email)
       SELECT ?, id_credito, ?, ?, ? FROM credito_documentos WHERE id_doc=?`,
      [req.params.id_doc, u.id_usuario || null,
       [u.nombre, u.apellido].filter(Boolean).join(' ') || null, u.email || null, req.params.id_doc]
    ).catch(e => console.error('[visto log]', e.message));
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.archivo_nombre)}`);
    res.send(doc.archivo_data);
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

/* ─── DOWNLOAD (fuerza descarga) ────────────────────────────────────────── */
const download = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT archivo_nombre, mime_type, archivo_data FROM credito_documentos WHERE id_doc=?',
      [req.params.id_doc]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: 'Documento no encontrado' });
    const doc = rows[0];
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.archivo_nombre)}`);
    res.send(doc.archivo_data);
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

/* ─── DELETE ────────────────────────────────────────────────────────────── */
const remove = async (req, res) => {
  try {
    // Obtener datos antes de borrar para la auditoría
    const [prev] = await pool.query(
      `SELECT cd.id_credito, cd.archivo_nombre, cd.id_tipo,
              t.nombre AS tipo_nombre
       FROM credito_documentos cd
       LEFT JOIN tipos_documento t ON t.id_tipo = cd.id_tipo
       WHERE cd.id_doc=?`,
      [req.params.id_doc]
    );
    await pool.query('DELETE FROM credito_documentos WHERE id_doc=?', [req.params.id_doc]);
    if (prev.length) {
      const tipoNombre = prev[0].tipo_nombre || `tipo ID ${prev[0].id_tipo}`;
      audit.registrar({
        id_credito: prev[0].id_credito, req,
        accion: 'DOCUMENTO_ELIMINADO',
        detalle: `${tipoNombre}: ${prev[0].archivo_nombre || 'documento'} eliminado`,
        meta: { id_tipo: prev[0].id_tipo, tipo_nombre: tipoNombre, archivo_nombre: prev[0].archivo_nombre },
      });
    }
    res.json({ success: true, data: { mensaje: 'Documento eliminado' }, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

/* ─── DELETE ALL por crédito ─────────────────────────────────────────────── */
const removeAll = async (req, res) => {
  try {
    const { id_credito } = req.params;
    const [prev] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM credito_documentos WHERE id_credito=?', [id_credito]
    );
    await pool.query('DELETE FROM credito_documentos WHERE id_credito=?', [id_credito]);
    audit.registrar({
      id_credito, req,
      accion: 'DOCUMENTOS_LIMPIADOS',
      detalle: `Se eliminaron ${prev[0]?.cnt || 0} documentos del crédito`,
      meta: { total: prev[0]?.cnt || 0 },
    });
    res.json({ success: true, data: { mensaje: 'Documentos eliminados', total: prev[0]?.cnt || 0 }, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

/* ─── PATCH aprobación por documento ────────────────────────────────────── */
const updateAprobacion = async (req, res) => {
  try {
    const { aprobado, aprobado_por, rechazado_por } = req.body;
    const aprobado_at = (aprobado !== null && aprobado !== undefined) ? new Date() : null;

    const [prev] = await pool.query(
      `SELECT cd.id_credito, cd.archivo_nombre, cd.id_tipo,
              t.nombre AS tipo_nombre
       FROM credito_documentos cd
       LEFT JOIN tipos_documento t ON t.id_tipo = cd.id_tipo
       WHERE cd.id_doc=?`,
      [req.params.id_doc]
    );
    if (!prev.length)
      return res.status(404).json({ success: false, data: null, error: 'Documento no encontrado' });

    const tipoNombre = prev[0].tipo_nombre || `tipo ID ${prev[0].id_tipo}`;

    await pool.query(
      `UPDATE credito_documentos
         SET aprobado=?, aprobado_por=?, rechazado_por=?, aprobado_at=?
       WHERE id_doc=?`,
      [aprobado ?? null, aprobado_por || null, rechazado_por || null, aprobado_at, req.params.id_doc]
    );

    const accion = aprobado === 1
      ? 'DOCUMENTO_APROBADO'
      : aprobado === 0
        ? 'DOCUMENTO_RECHAZADO'
        : 'DOCUMENTO_REVISION_ANULADA';

    audit.registrar({
      id_credito: prev[0].id_credito, req, accion,
      detalle: aprobado === 1
        ? `${tipoNombre} — Aprobado por ${aprobado_por}`
        : aprobado === 0
          ? `${tipoNombre} — Rechazado por ${rechazado_por}`
          : `${tipoNombre} — Revisión anulada`,
      meta: { aprobado, tipo_nombre: tipoNombre, aprobado_por, rechazado_por, archivo_nombre: prev[0].archivo_nombre },
    });

    res.json({ success: true, data: { id_doc: req.params.id_doc }, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

module.exports = { getByCredito, upload, updateComentario, updateAprobacion, view, download, remove, removeAll };
