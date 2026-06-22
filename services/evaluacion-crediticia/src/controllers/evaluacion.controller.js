const pool = require('../../../../shared/config/database');

/* ──────────────────────────────────────────────────────────────────────────
 * Evaluación Crediticia
 * Card propia en el Home (anti-hardcode: vive en BD) + endpoint agregador que
 * arma la "ficha" del cliente por RUT: nombre, antigüedad de antecedentes y
 * cotizaciones guardadas (última primero). El pull en vivo a DealerNet lo hace
 * el módulo /api/dealernet/consultar al iniciar la evaluación.
 * ────────────────────────────────────────────────────────────────────────── */

const normRut = v => v ? String(v).replace(/\./g, '').toUpperCase().trim() : null;

(async () => {
  try {
    // Documentos que el ejecutivo carga para evaluar (por RUT + documento requerido).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS evaluacion_documentos (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        rut_cliente    VARCHAR(15)  NOT NULL,
        ocupacion      VARCHAR(80),
        documento      VARCHAR(255) NOT NULL,
        archivo_nombre VARCHAR(500),
        archivo_size   INT,
        mime_type      VARCHAR(120),
        archivo_data   LONGBLOB,
        subido_por     INT,
        created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_rut_doc (rut_cliente, documento),
        INDEX idx_evdoc_rut (rut_cliente)
      )`);

    // Módulo/card propio "Evaluación Crediticia" en el Home.
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (390001, 'Evaluación Crediticia',
               'Evalúa crediticiamente a un cliente por RUT: antecedentes, cotizaciones e informe DealerNet',
               'bi-clipboard-pulse', '/evaluacion-crediticia/', 106, 'activo')`);

    // Funcionalidad (genera la card por permiso y el sub-item gestionable).
    let idFunc;
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='evaluacion_crediticia' LIMIT 1");
    if (ex) idFunc = ex.id_funcionalidad;
    else {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (390001,?,?,?,?)",
        ['Evaluación Crediticia', 'evaluacion_crediticia', '/evaluacion-crediticia/', 'bi-clipboard-pulse']);
      idFunc = r.insertId;
    }

    // Permisos por defecto: Administrador (bypass igual) + perfiles que evalúan crédito.
    const nombres = ['Administrador', 'Gerente', 'Ejecutivo', 'Ejecutivo Comercial',
                     'Analista', 'Supervisor de Crédito', 'Jefe Comercial'];
    const [perfs] = await pool.query('SELECT id_perfil FROM perfiles WHERE nombre IN (?)', [nombres]);
    for (const { id_perfil } of perfs) {
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [id_perfil, idFunc]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [id_perfil, idFunc]);
    }
    console.log('[evaluacion-crediticia] módulo/card y permisos listos');
  } catch (e) { console.error('[evaluacion-crediticia migration]', e.message); }
})();

/* GET /api/evaluacion-crediticia/ficha/:rut — ficha del cliente para evaluar */
const ficha = async (req, res) => {
  try {
    const rut = normRut(decodeURIComponent(req.params.rut || ''));
    if (!rut) return res.status(400).json({ success: false, data: null, error: 'RUT requerido' });

    // 1) Cliente (nombre)
    let cliente = null;
    try {
      const [[c]] = await pool.query(
        'SELECT rut, nombre_completo, nombres, apellido_paterno, apellido_materno FROM clientes WHERE rut=? LIMIT 1', [rut]);
      if (c) {
        const armado = [c.nombres, c.apellido_paterno, c.apellido_materno].filter(Boolean).join(' ').trim();
        cliente = { rut: c.rut, nombre: (c.nombre_completo && c.nombre_completo.trim()) || armado || null };
      }
    } catch (_) {}
    // Fallback: nombre desde créditos (carga masiva) si no está en clientes
    if (!cliente) {
      try {
        const [[op]] = await pool.query(
          `SELECT cl.rut, COALESCE(cl.nombre_completo,'') AS nombre
           FROM clientes cl JOIN creditos cr ON cr.id_cliente = cl.id_cliente
           WHERE cl.rut=? LIMIT 1`, [rut]);
        if (op) cliente = { rut: op.rut, nombre: op.nombre || null };
      } catch (_) {}
    }

    // 2) Antecedentes laborales (antigüedad en días)
    let antecedentes = null;
    try {
      const [[a]] = await pool.query(
        `SELECT updated_at, created_at, tipo_trabajador,
                DATEDIFF(NOW(), COALESCE(updated_at, created_at)) AS dias
         FROM antecedentes_laborales WHERE rut_cliente=? LIMIT 1`, [rut]);
      if (a) antecedentes = {
        existe: true,
        fecha: a.updated_at || a.created_at,
        dias: a.dias == null ? null : Number(a.dias),
        tipo_trabajador: a.tipo_trabajador || null,
      };
    } catch (_) {}

    // 3) Cotizaciones guardadas (última primero)
    let cotizaciones = [];
    try {
      const [rows] = await pool.query(
        `SELECT id_cotizacion, fecha_cotizacion, created_at, valor_vehiculo, pie,
                monto_financiado, cuota, plazo
         FROM cotizaciones WHERE rut_cliente=? ORDER BY created_at DESC LIMIT 20`, [rut]);
      cotizaciones = rows.map(r => ({
        id: r.id_cotizacion,
        fecha: r.fecha_cotizacion || r.created_at,
        valor_vehiculo: r.valor_vehiculo,
        saldo_precio: (Number(r.valor_vehiculo) || 0) - (Number(r.pie) || 0),
        monto_credito: r.monto_financiado,
        cuota: r.cuota,
        plazo: r.plazo,
      }));
    } catch (_) {}

    res.json({ success: true, data: { cliente, antecedentes, cotizaciones }, error: null });
  } catch (e) {
    console.error('[evaluacion ficha]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* GET /api/evaluacion-crediticia/documentos/:rut — documentos ya cargados */
const getDocumentos = async (req, res) => {
  try {
    const rut = normRut(decodeURIComponent(req.params.rut || ''));
    if (!rut) return res.status(400).json({ success: false, data: null, error: 'RUT requerido' });
    const [rows] = await pool.query(
      `SELECT id, ocupacion, documento, archivo_nombre, archivo_size, mime_type, created_at
       FROM evaluacion_documentos WHERE rut_cliente=? ORDER BY id`, [rut]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    console.error('[evaluacion getDocumentos]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* POST /api/evaluacion-crediticia/documento — sube/reemplaza un documento (base64) */
const subirDocumento = async (req, res) => {
  try {
    const { rut, ocupacion, documento, archivo_nombre, archivo_size, mime_type, archivo_data } = req.body || {};
    const r = normRut(rut);
    if (!r || !documento || !archivo_data)
      return res.status(400).json({ success: false, data: null, error: 'rut, documento y archivo_data son requeridos' });
    const buffer = Buffer.from(archivo_data, 'base64');
    if (buffer.length > 15 * 1024 * 1024)
      return res.status(413).json({ success: false, data: null, error: 'El archivo supera 15 MB' });
    const id_usuario = req.usuario?.id_usuario || null;
    await pool.query(
      `INSERT INTO evaluacion_documentos
         (rut_cliente, ocupacion, documento, archivo_nombre, archivo_size, mime_type, archivo_data, subido_por)
       VALUES (?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE ocupacion=VALUES(ocupacion), archivo_nombre=VALUES(archivo_nombre),
         archivo_size=VALUES(archivo_size), mime_type=VALUES(mime_type), archivo_data=VALUES(archivo_data),
         subido_por=VALUES(subido_por), created_at=CURRENT_TIMESTAMP`,
      [r, ocupacion || null, String(documento).slice(0, 255), archivo_nombre || 'documento',
       archivo_size || buffer.length, mime_type || 'application/octet-stream', buffer, id_usuario]);
    const [[row]] = await pool.query('SELECT id FROM evaluacion_documentos WHERE rut_cliente=? AND documento=? LIMIT 1', [r, String(documento).slice(0, 255)]);
    res.json({ success: true, data: { id: row ? row.id : null }, error: null });
  } catch (e) {
    console.error('[evaluacion subirDocumento]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* GET /api/evaluacion-crediticia/documento/:id/view — ver archivo */
const verDocumento = async (req, res) => {
  try {
    const [[doc]] = await pool.query(
      'SELECT archivo_nombre, mime_type, archivo_data FROM evaluacion_documentos WHERE id=?', [req.params.id]);
    if (!doc) return res.status(404).json({ success: false, data: null, error: 'No encontrado' });
    res.setHeader('Content-Type', doc.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(doc.archivo_nombre || 'documento')}`);
    res.send(doc.archivo_data);
  } catch (e) {
    console.error('[evaluacion verDocumento]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* DELETE /api/evaluacion-crediticia/documento/:id — elimina archivo cargado */
const removeDocumento = async (req, res) => {
  try {
    await pool.query('DELETE FROM evaluacion_documentos WHERE id=?', [req.params.id]);
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) {
    console.error('[evaluacion removeDocumento]', e);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { ficha, getDocumentos, subirDocumento, verDocumento, removeDocumento };
