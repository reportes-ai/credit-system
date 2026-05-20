const pool = require('../../../../shared/config/database');

/* ─── Ensure table ───────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS documentos_af (
        id_doc_af          INT AUTO_INCREMENT PRIMARY KEY,
        id_credito         INT NOT NULL,
        codigo             VARCHAR(60)  NOT NULL,
        nombre             VARCHAR(200) NOT NULL,
        mime_type          VARCHAR(100) NULL,
        contenido          LONGBLOB     NULL,
        comentario         TEXT         NULL,
        validado           TINYINT(1)   DEFAULT 0,
        validado_por       VARCHAR(200) NULL,
        validado_at        DATETIME     NULL,
        rechazado          TINYINT(1)   DEFAULT 0,
        comentario_rechazo TEXT         NULL,
        rechazado_por      VARCHAR(200) NULL,
        rechazado_at       DATETIME     NULL,
        created_at         DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at         DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_credito_codigo (id_credito, codigo)
      )
    `);
  } catch (e) {
    if (e.errno !== 1050) console.error('[documentos_af migration]', e.message);
  }
})();

/* ─── GET /:id_credito ───────────────────────────────────────────────────── */
const getByCredito = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_doc_af, id_credito, codigo, nombre, mime_type,
              comentario, validado, validado_por, validado_at,
              rechazado, comentario_rechazo, rechazado_por, rechazado_at,
              created_at, updated_at,
              (contenido IS NOT NULL) AS tiene_archivo
       FROM documentos_af WHERE id_credito = ? ORDER BY id_doc_af`,
      [req.params.id_credito]
    );
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ─── POST / (upload / replace) ─────────────────────────────────────────── */
const upload = async (req, res) => {
  try {
    const { id_credito, codigo, nombre, mime_type, base64, comentario } = req.body;
    if (!id_credito || !codigo || !base64)
      return res.status(400).json({ success: false, data: null, error: 'id_credito, codigo y base64 son requeridos' });

    const buf = Buffer.from(base64, 'base64');

    // Upsert — si ya existe ese código para ese crédito, reemplaza y resetea validación
    const [existing] = await pool.query(
      'SELECT id_doc_af FROM documentos_af WHERE id_credito=? AND codigo=?',
      [id_credito, codigo]
    );

    if (existing.length) {
      await pool.query(
        `UPDATE documentos_af
         SET nombre=?, mime_type=?, contenido=?, comentario=?,
             validado=0, validado_por=NULL, validado_at=NULL,
             rechazado=0, comentario_rechazo=NULL, rechazado_por=NULL, rechazado_at=NULL
         WHERE id_credito=? AND codigo=?`,
        [nombre || codigo, mime_type || null, buf, comentario || null, id_credito, codigo]
      );
      res.json({ success: true, data: { id_doc_af: existing[0].id_doc_af }, error: null });
    } else {
      const [r] = await pool.query(
        `INSERT INTO documentos_af (id_credito, codigo, nombre, mime_type, contenido, comentario)
         VALUES (?,?,?,?,?,?)`,
        [id_credito, codigo, nombre || codigo, mime_type || null, buf, comentario || null]
      );
      res.status(201).json({ success: true, data: { id_doc_af: r.insertId }, error: null });
    }
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ─── PATCH /:id_doc/comentario ─────────────────────────────────────────── */
const updateComentario = async (req, res) => {
  try {
    await pool.query(
      'UPDATE documentos_af SET comentario=? WHERE id_doc_af=?',
      [req.body.comentario || null, req.params.id_doc]
    );
    res.json({ success: true, data: null, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ─── PATCH /:id_doc/validar ─────────────────────────────────────────────── */
const validar = async (req, res) => {
  try {
    const { validado_por } = req.body;
    if (!validado_por)
      return res.status(400).json({ success: false, data: null, error: 'validado_por es requerido' });
    await pool.query(
      `UPDATE documentos_af
       SET validado=1, validado_por=?, validado_at=NOW(),
           rechazado=0, comentario_rechazo=NULL, rechazado_por=NULL, rechazado_at=NULL
       WHERE id_doc_af=?`,
      [validado_por, req.params.id_doc]
    );
    res.json({ success: true, data: null, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ─── PATCH /:id_doc/rechazar ────────────────────────────────────────────── */
const rechazar = async (req, res) => {
  try {
    const { comentario_rechazo, rechazado_por } = req.body;
    if (!comentario_rechazo)
      return res.status(400).json({ success: false, data: null, error: 'comentario_rechazo es requerido' });
    await pool.query(
      `UPDATE documentos_af
       SET rechazado=1, comentario_rechazo=?, rechazado_por=?, rechazado_at=NOW(),
           validado=0, validado_por=NULL, validado_at=NULL
       WHERE id_doc_af=?`,
      [comentario_rechazo, rechazado_por || null, req.params.id_doc]
    );
    res.json({ success: true, data: null, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

/* ─── GET /view/:id_doc ──────────────────────────────────────────────────── */
const view = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT nombre, mime_type, contenido FROM documentos_af WHERE id_doc_af=?',
      [req.params.id_doc]
    );
    if (!rows.length || !rows[0].contenido)
      return res.status(404).json({ success: false, error: 'Documento no encontrado' });
    const { nombre, mime_type, contenido } = rows[0];
    res.setHeader('Content-Type', mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(nombre)}"`);
    res.send(contenido);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ─── GET /download/:id_doc ──────────────────────────────────────────────── */
const download = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT nombre, mime_type, contenido FROM documentos_af WHERE id_doc_af=?',
      [req.params.id_doc]
    );
    if (!rows.length || !rows[0].contenido)
      return res.status(404).json({ success: false, error: 'Documento no encontrado' });
    const { nombre, mime_type, contenido } = rows[0];
    res.setHeader('Content-Type', mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(nombre)}"`);
    res.send(contenido);
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
};

/* ─── DELETE /:id_doc ────────────────────────────────────────────────────── */
const remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM documentos_af WHERE id_doc_af=?', [req.params.id_doc]);
    res.json({ success: true, data: null, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

module.exports = { getByCredito, upload, updateComentario, validar, rechazar, view, download, remove };
