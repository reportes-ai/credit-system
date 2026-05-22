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
    // Agrega columna comentario si la tabla ya existía
    await pool.query(`ALTER TABLE credito_documentos ADD COLUMN comentario TEXT NULL`)
      .catch(e => { if (e.errno !== 1060) throw e; });
  } catch(e) { if (e.errno !== 1050) console.error('[credito_documentos migration]', e.message); }
})();

/* ─── GET por crédito (sin datos binarios) ──────────────────────────────── */
const getByCredito = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_doc, id_credito, id_tipo, archivo_nombre, archivo_size, mime_type,
              comentario, subido_at, subido_por
       FROM credito_documentos WHERE id_credito = ? ORDER BY id_tipo, subido_at DESC`,
      [req.params.id_credito]
    );
    res.json({ success: true, data: rows, error: null });
  } catch(e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ─── UPLOAD (base64 en JSON) ───────────────────────────────────────────── */
const upload = async (req, res) => {
  try {
    const { id_credito, id_tipo, archivo_nombre, archivo_size, mime_type, archivo_data, comentario } = req.body;
    if (!id_credito || !id_tipo || !archivo_data)
      return res.status(400).json({ success: false, data: null, error: 'id_credito, id_tipo y archivo_data son requeridos' });

    const buffer     = Buffer.from(archivo_data, 'base64');
    const id_usuario = req.usuario?.id_usuario || null;

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
      detalle: `Archivo cargado: ${archivo_nombre || 'documento'} (tipo ID ${id_tipo})`,
      meta: { id_tipo, archivo_nombre, archivo_size: archivo_size || buffer.length, mime_type },
    });
    res.status(201).json({ success: true, data: { id_doc: r.insertId }, error: null });
  } catch(e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ─── PATCH comentario ───────────────────────────────────────────────────── */
const updateComentario = async (req, res) => {
  try {
    const { comentario } = req.body;
    await pool.query('UPDATE credito_documentos SET comentario=? WHERE id_doc=?',
      [comentario || null, req.params.id_doc]);
    res.json({ success: true, data: { id_doc: req.params.id_doc }, error: null });
  } catch(e) { res.status(500).json({ success: false, data: null, error: e.message }); }
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
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.archivo_nombre)}`);
    res.send(doc.archivo_data);
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
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
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ─── DELETE ────────────────────────────────────────────────────────────── */
const remove = async (req, res) => {
  try {
    // Obtener datos antes de borrar para la auditoría
    const [prev] = await pool.query(
      'SELECT id_credito, archivo_nombre, id_tipo FROM credito_documentos WHERE id_doc=?',
      [req.params.id_doc]
    );
    await pool.query('DELETE FROM credito_documentos WHERE id_doc=?', [req.params.id_doc]);
    if (prev.length) {
      audit.registrar({
        id_credito: prev[0].id_credito, req,
        accion: 'DOCUMENTO_ELIMINADO',
        detalle: `Archivo eliminado: ${prev[0].archivo_nombre || 'documento'} (tipo ID ${prev[0].id_tipo})`,
        meta: { id_tipo: prev[0].id_tipo, archivo_nombre: prev[0].archivo_nombre },
      });
    }
    res.json({ success: true, data: { mensaje: 'Documento eliminado' }, error: null });
  } catch(e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

module.exports = { getByCredito, upload, updateComentario, view, download, remove };
