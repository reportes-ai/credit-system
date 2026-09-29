'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   FISCALIZACIONES — carpeta de cada fiscalización laboral (Dirección del
   Trabajo, SUSESO, mutual, SEREMI de Salud, etc.).
   · RRHH crea la carpeta y sube los documentos (acta, resolución de multa,
     citación, descargos, comprobantes de corrección).
   · La IA lee TODOS los documentos de la carpeta y arma el resumen: qué se
     fiscalizó, sanciones, por qué, y compromisos adquiridos con sus plazos.
     Se regenera solo cada vez que se sube un documento nuevo.
   · INMUTABLE: los documentos se suben pero NO se borran ni se reemplazan
     (Pato, 29-09-2026). Por eso no existe ninguna ruta DELETE ni PUT, y el
     objeto del bucket nunca se toca después de colocado.
   · Pagar una multa NO se hace aquí: se paga por Órdenes de Pago, que es
     quien contabiliza (Máxima 4). Esta carpeta es el respaldo documental.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const ALMACEN = require('../../../../shared/almacen-docs');
const { auditar } = require('../../../../shared/audit');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

const DOC_MAX = 7 * 1024 * 1024;          // body del gateway 10 MB; el base64 infla ~37%
const IA_MAX_ADJ = 20 * 1024 * 1024;      // tope de PDFs/imágenes que se mandan juntos a la IA
const IA_CODIGO = 'rrhh_fiscalizacion_resumen';
const MIMES_OK = /pdf|image\/(jpe?g|png|webp)|wordprocessingml/i;

const migrate = require('../../../../shared/migrate');
migrate.enFila('rrhh-fiscalizaciones', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_fiscalizaciones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(200) NOT NULL,
    organismo VARCHAR(120) NULL,
    fecha DATE NULL,
    ia_estado VARCHAR(16) NOT NULL DEFAULT 'SIN_DOCS',
    ia_resumen JSON NULL,
    ia_error VARCHAR(300) NULL,
    ia_at DATETIME NULL,
    creado_por INT NULL,
    creado_por_nombre VARCHAR(160) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_fecha (fecha)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_fiscalizacion_docs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_fiscalizacion INT NOT NULL,
    nombre_archivo VARCHAR(255) NOT NULL,
    mime VARCHAR(120) NULL,
    archivo LONGBLOB NULL,
    doc_storage VARCHAR(10) NOT NULL DEFAULT 'db',
    doc_ruta VARCHAR(500) NULL,
    doc_bytes BIGINT NULL,
    nota VARCHAR(300) NULL,
    subido_por INT NULL,
    subido_por_nombre VARCHAR(160) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_fisc (id_fiscalizacion)
  )`);
  // v282.1: la carpeta nace de los documentos y la IA le pone el nombre (Pato: "llena tú los campos")
  await pool.query(`ALTER TABLE rh_fiscalizaciones ADD COLUMN nombre_auto TINYINT(1) NOT NULL DEFAULT 0`)
    .catch(e => { if (e.code !== 'ER_DUP_FIELDNAME') throw e; });
  // Card en RRHH: solo Administrador de entrada; el resto se asigna en la matriz de Perfiles
  const [[modRRHH]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  if (modRRHH) {
    const [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_fiscalizaciones' LIMIT 1`);
    if (!f) {
      const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
        VALUES (?, 'Fiscalizaciones', 'rh_fiscalizaciones', '/recursos-humanos/fiscalizaciones/', 'bi-clipboard2-pulse')`, [modRRHH.id_modulo]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1, ?, 1)`, [r.insertId]);
    }
  }
  await require('../../../../shared/ia').registrarFuncionalidad({
    codigo: IA_CODIGO, nombre: 'Resumen de fiscalizaciones',
    descripcion: 'Lee los documentos de una fiscalización (acta, resolución de multa, citación, descargos) y resume qué se fiscalizó, las sanciones, el porqué y los compromisos con sus plazos. Solo lee: no modifica los documentos.',
    modelo: 'claude-sonnet-4-6',
  });
});
// Pato pidió que la IA resuma: se enciende UNA vez; si el Administrador la apaga después, queda apagada.
migrate.migrar('rrhh_fiscalizacion_ia_on_v1', async () => {
  await pool.query(`UPDATE ia_funcionalidades SET activa=1 WHERE codigo=?`, [IA_CODIGO]);
  require('../../../../shared/ia').invalidar();
});

const nombreDe = u => [u.nombre, u.apellido].filter(Boolean).join(' ') || u.email || null;
const idNum = v => { const n = parseInt(v, 10); return n > 0 ? n : null; };
const fechaOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null;
const parseJSON = v => { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (_) { return null; } };

/* GET /api/rrhh/fiscalizaciones */
exports.listar = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT f.id, f.nombre, f.organismo, f.fecha, f.ia_estado, f.ia_resumen, f.creado_por_nombre, f.created_at,
              (SELECT COUNT(*) FROM rh_fiscalizacion_docs d WHERE d.id_fiscalizacion=f.id) AS n_docs
         FROM rh_fiscalizaciones f ORDER BY COALESCE(f.fecha, DATE(f.created_at)) DESC, f.id DESC LIMIT 500`);
    ok(res, rows.map(r => {
      const s = parseJSON(r.ia_resumen) || {};
      return { ...r, ia_resumen: undefined,
        n_sanciones: Array.isArray(s.sanciones) ? s.sanciones.length : 0,
        n_compromisos: Array.isArray(s.compromisos) ? s.compromisos.length : 0,
        materia: s.materia || null };
    }));
  } catch (e) { console.error('[fiscalizaciones listar]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /api/rrhh/fiscalizaciones { nombre?, organismo?, fecha? } — crea la carpeta.
   Sin nombre (lo normal) nace con uno provisorio y la IA lo reemplaza al leer los documentos. */
exports.crear = async (req, res) => {
  try {
    const b = req.body || {};
    const manual = String(b.nombre || '').trim().slice(0, 200);
    if (manual && manual.length < 3) return fail(res, 'El nombre debe tener al menos 3 caracteres', 400);
    const nombre = manual || 'Nueva fiscalización';
    const organismo = String(b.organismo || '').trim().slice(0, 120) || null;
    const fecha = b.fecha ? fechaOk(b.fecha) : null;
    if (b.fecha && !fecha) return fail(res, 'Fecha inválida', 400);
    const u = req.usuario || {};
    const [r] = await pool.query(
      `INSERT INTO rh_fiscalizaciones (nombre, nombre_auto, organismo, fecha, creado_por, creado_por_nombre) VALUES (?,?,?,?,?,?)`,
      [nombre, manual ? 0 : 1, organismo, fecha, u.id_usuario || null, nombreDe(u)]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'fiscalizacion', entidad_id: r.insertId,
      detalle: `Creó la carpeta de fiscalización "${nombre}"` });
    ok(res, { id: r.insertId });
  } catch (e) { console.error('[fiscalizaciones crear]', e.message); fail(res, 'Error interno del servidor'); }
};

/* GET /api/rrhh/fiscalizaciones/:id — carpeta + documentos + resumen */
exports.detalle = async (req, res) => {
  try {
    const id = idNum(req.params.id);
    if (!id) return fail(res, 'Id inválido', 400);
    const [[f]] = await pool.query('SELECT * FROM rh_fiscalizaciones WHERE id=?', [id]);
    if (!f) return fail(res, 'Fiscalización no encontrada', 404);
    const [docs] = await pool.query(
      `SELECT id, nombre_archivo, mime, doc_bytes, nota, subido_por_nombre, created_at
         FROM rh_fiscalizacion_docs WHERE id_fiscalizacion=? ORDER BY id`, [id]);
    ok(res, { ...f, ia_resumen: parseJSON(f.ia_resumen), docs });
  } catch (e) { console.error('[fiscalizaciones detalle]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /api/rrhh/fiscalizaciones/:id/docs { archivo_nombre, mime_type, archivo_data(base64), nota? } */
exports.subirDoc = async (req, res) => {
  try {
    const id = idNum(req.params.id);
    if (!id) return fail(res, 'Id inválido', 400);
    const { archivo_nombre, mime_type, archivo_data, nota } = req.body || {};
    if (!archivo_data) return fail(res, 'Falta el archivo', 400);
    if (!MIMES_OK.test(mime_type || '')) return fail(res, 'Formato no admitido: sube PDF, imagen (JPG/PNG) o Word (.docx)', 400);
    const [[f]] = await pool.query('SELECT id, nombre FROM rh_fiscalizaciones WHERE id=?', [id]);
    if (!f) return fail(res, 'Fiscalización no encontrada', 404);
    const buffer = Buffer.from(String(archivo_data).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buffer.length) return fail(res, 'El archivo llegó vacío', 400);
    if (buffer.length > DOC_MAX) return fail(res, 'El archivo supera el máximo de 7 MB', 400);
    const nombre = String(archivo_nombre || 'documento').slice(0, 255);
    const col = await ALMACEN.colocar({ ambito: 'rrhh-fiscalizaciones', clave: id, buffer, mime: mime_type, nombre });
    const u = req.usuario || {};
    const [r] = await pool.query(
      `INSERT INTO rh_fiscalizacion_docs (id_fiscalizacion, nombre_archivo, mime, archivo, doc_storage, doc_ruta, doc_bytes, nota, subido_por, subido_por_nombre)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, nombre, mime_type || null, col.blob, col.storage, col.ruta, col.bytes,
       String(nota || '').trim().slice(0, 300) || null, u.id_usuario || null, nombreDe(u)]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'fiscalizacion_doc', entidad_id: r.insertId,
      detalle: `Subió "${nombre}" a la fiscalización #${id} "${f.nombre}"` });
    // El resumen se rehace en segundo plano: la subida no espera a la IA
    await pool.query(`UPDATE rh_fiscalizaciones SET ia_estado='GENERANDO', ia_error=NULL WHERE id=?`, [id]);
    resumir(id, u.id_usuario || null);
    ok(res, { id: r.insertId });
  } catch (e) { console.error('[fiscalizaciones subirDoc]', e.message); fail(res, 'Error interno del servidor'); }
};

/* GET /api/rrhh/fiscalizaciones/docs/:docId — ver el documento (inline) */
exports.verDoc = async (req, res) => {
  try {
    const docId = idNum(req.params.docId);
    if (!docId) return fail(res, 'Id inválido', 400);
    const [[d]] = await pool.query('SELECT * FROM rh_fiscalizacion_docs WHERE id=?', [docId]);
    if (!d) return fail(res, 'Documento no encontrado', 404);
    await ALMACEN.servir(res, { ruta: d.doc_ruta, blob: d.archivo, nombre: d.nombre_archivo, mime: d.mime });
  } catch (e) { console.error('[fiscalizaciones verDoc]', e.message); fail(res, 'Error interno del servidor'); }
};

/* POST /api/rrhh/fiscalizaciones/:id/resumir — rehacer el resumen a pedido */
exports.reResumir = async (req, res) => {
  try {
    const id = idNum(req.params.id);
    if (!id) return fail(res, 'Id inválido', 400);
    const [r] = await pool.query(`UPDATE rh_fiscalizaciones SET ia_estado='GENERANDO', ia_error=NULL WHERE id=?`, [id]);
    if (!r.affectedRows) return fail(res, 'Fiscalización no encontrada', 404);
    resumir(id, req.usuario?.id_usuario || null);
    ok(res, { id, ia_estado: 'GENERANDO' });
  } catch (e) { console.error('[fiscalizaciones reResumir]', e.message); fail(res, 'Error interno del servidor'); }
};

/* Motor del resumen: junta todos los documentos de la carpeta y le pide a la IA
   el JSON. Nunca lanza: el resultado queda en ia_estado (OK / ERROR / IA_OFF). */
async function resumir(id, id_usuario) {
  const marcar = (estado, err) => pool.query(
    'UPDATE rh_fiscalizaciones SET ia_estado=?, ia_error=? WHERE id=?', [estado, err ? String(err).slice(0, 300) : null, id]).catch(() => {});
  try {
    const AI = require('../../../../shared/anthropic');
    if (!AI.disponible()) return marcar('IA_OFF', 'El servidor no tiene la IA configurada');
    if (!(await require('../../../../shared/ia').iaActiva(IA_CODIGO)))
      return marcar('IA_OFF', 'La IA "Resumen de fiscalizaciones" está apagada en el mantenedor de IA');

    const [docs] = await pool.query('SELECT * FROM rh_fiscalizacion_docs WHERE id_fiscalizacion=? ORDER BY id', [id]);
    if (!docs.length) return marcar('SIN_DOCS');
    const adjuntos = [], textos = [], omitidos = [];
    let peso = 0;
    for (const d of docs) {
      let buf;
      try { buf = await ALMACEN.obtener({ ruta: d.doc_ruta, blob: d.archivo }); } catch (_) { buf = null; }
      if (!buf) { omitidos.push(d.nombre_archivo); continue; }
      if (/wordprocessingml/i.test(d.mime || '')) {
        try { textos.push(`--- ${d.nombre_archivo} ---\n` + (await require('mammoth').extractRawText({ buffer: buf })).value.trim().slice(0, 40000)); }
        catch (_) { omitidos.push(d.nombre_archivo); }
        continue;
      }
      if (peso + buf.length > IA_MAX_ADJ) { omitidos.push(d.nombre_archivo); continue; }
      peso += buf.length;
      adjuntos.push(/pdf/i.test(d.mime || '')
        ? { tipo: 'pdf', data: buf.toString('base64') }
        : { tipo: 'image', media_type: d.mime, data: buf.toString('base64') });
    }
    if (!adjuntos.length && !textos.length) return marcar('ERROR', 'No se pudo leer ningún documento de la carpeta');

    const { datos, stop_reason } = await AI.analizar({
      codigo: IA_CODIGO, id_usuario, json: true, max_tokens: 6000,
      system: 'Eres asesor laboral de AutoFácil (empresa de crédito automotriz en Chile). Lees los documentos de una fiscalización (Dirección del Trabajo, SUSESO, mutual de seguridad, SEREMI de Salud u otro organismo) y haces un resumen ejecutivo fiel. Jamás inventes: lo que el documento no dice va como null o lista vacía. Montos tal como aparecen (UTM, UF o pesos). Fechas YYYY-MM-DD. Español de Chile, formal y breve. No incluyas RUT ni datos personales de trabajadores: refiérete a ellos por cargo o como "un trabajador".',
      prompt: `Resume la fiscalización con este JSON exacto:
{
 "titulo": string  (nombre corto para la carpeta, máx. 70 caracteres: organismo abreviado · materia · mes-año; ej. "DT · Jornada y descansos · sep-2026"),
 "organismo": string|null,
 "fecha_fiscalizacion": string|null,
 "numero_expediente": string|null  (N° de fiscalización, acta o resolución),
 "materia": string|null  (qué se fiscalizó, una línea),
 "resumen": string  (3 a 6 líneas: qué pasó, de principio a fin según los documentos),
 "sanciones": [{"descripcion": string, "monto": string|null, "norma_infringida": string|null}],
 "motivo": string|null  (por qué se sancionó u observó: los hechos constatados),
 "compromisos": [{"compromiso": string, "plazo": string|null, "responsable": string|null}]  (correcciones o acciones que la empresa debe hacer o se comprometió a hacer),
 "plazos_legales": [string]  (reclamo, reconsideración, pago con rebaja, etc., si el documento los menciona),
 "estado": string|null  (en curso, multa cursada, reconsiderada, cerrada… según lo último que muestren los documentos)
}` + (textos.length ? `\n\nDocumentos Word (texto extraído):\n${textos.join('\n\n')}` : ''),
      documentos: adjuntos,
    });
    if (!datos) return marcar('ERROR', stop_reason === 'max_tokens' ? 'La respuesta de la IA vino cortada' : 'La IA no devolvió un resumen legible');
    if (omitidos.length) datos.documentos_no_leidos = omitidos;
    const fechaIA = fechaOk(datos.fecha_fiscalizacion);
    const titulo = String(datos.titulo || '').trim().slice(0, 200) || null;
    // Lo puesto a mano manda; la IA completa lo vacío y renombra solo las carpetas con nombre automático
    await pool.query(
      `UPDATE rh_fiscalizaciones SET ia_estado='OK', ia_error=NULL, ia_resumen=?, ia_at=NOW(),
         nombre=IF(nombre_auto=1 AND ? IS NOT NULL, ?, nombre),
         organismo=COALESCE(organismo, ?), fecha=COALESCE(fecha, ?) WHERE id=?`,
      [JSON.stringify(datos), titulo, titulo, datos.organismo ? String(datos.organismo).slice(0, 120) : null, fechaIA, id]);
  } catch (e) {
    console.error('[fiscalizaciones resumir]', e.message);
    marcar(e.code === 'IA_OFF' ? 'IA_OFF' : 'ERROR', e.message);
  }
}
