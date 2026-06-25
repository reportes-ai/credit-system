'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Seguimiento Fundantes — carga y validación de documentos fundantes de las
   operaciones OTORGADAS de brokerage (AUTOFIN / UNIDAD).

   Flujo: el Ejecutivo Comercial sube los documentos de su operación; cuando
   están TODOS los obligatorios, los envía a Validación (ENVIADO). Operaciones
   los aprueba (→ CERRADO) o los rechaza (→ RECHAZADO, con comentario obligatorio),
   y el ejecutivo puede volver a subirlos y reenviarlos.

   Tipos de documento por financiera → tabla paramétrica fundantes_seg_tipos
   (AUTOFIN: contrato compraventa + transferencia + limitación(*) + GPS(*);
    UNIDAD: contrato compraventa + transferencia). (*) sólo obligatorio si viene
   contratado en el crédito (columnas creditos.limitacion / creditos.gps).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { tieneFunc } = require('../../../../shared/middleware/permisos');

const MODULO_ID = 410001;
const FINANCIERAS = ['AUTOFIN', 'UNIDAD DE CREDITO'];          // brokerage (configurable vía seed de tipos)
const ESTADOS = ['PENDIENTE', 'ENVIADO', 'CERRADO', 'RECHAZADO'];
// Buckets de antigüedad (días pendientes) para la matriz resumen.
const BUCKETS = [
  { lbl: '<=7 días', max: 7 }, { lbl: '8-15 días', max: 15 }, { lbl: '16-30 días', max: 30 },
  { lbl: '31-60', max: 60 }, { lbl: '61-90', max: 90 }, { lbl: '91+', max: Infinity },
];
const bucketDe = d => BUCKETS.findIndex(b => d <= b.max);

/* ─── Migración + seed + registro de módulo ──────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fundantes_seg (
        id_credito         INT PRIMARY KEY,
        estado             VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
        comentario_rechazo TEXT,
        fecha_envio        DATETIME, enviado_por VARCHAR(150), id_enviado_por INT,
        fecha_validacion   DATETIME, validado_por VARCHAR(150), id_validado_por INT,
        updated_at         DATETIME DEFAULT NOW() ON UPDATE NOW(),
        INDEX idx_estado (estado)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fundantes_seg_docs (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        id_credito     INT NOT NULL,
        codigo         VARCHAR(40) NOT NULL,
        archivo_nombre VARCHAR(300), mime_type VARCHAR(120), archivo_data LONGBLOB,
        subido_por     VARCHAR(150), id_subido_por INT,
        created_at     DATETIME DEFAULT NOW(),
        UNIQUE KEY uk_doc (id_credito, codigo),
        INDEX idx_cred (id_credito)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fundantes_seg_tipos (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        financiera        VARCHAR(40) NOT NULL,
        codigo            VARCHAR(40) NOT NULL,
        nombre            VARCHAR(120) NOT NULL,
        obligatorio       TINYINT(1) NOT NULL DEFAULT 1,
        requiere_contrato VARCHAR(20) NULL,   -- 'gps' | 'limitacion' → sólo exigido si viene contratado
        orden             INT DEFAULT 0,
        UNIQUE KEY uk_tipo (financiera, codigo)
      )`);
    const seed = [
      ['AUTOFIN', 'CONTRATO_CV', 'Contrato Compraventa', 1, null, 1],
      ['AUTOFIN', 'SOL_TRANSFERENCIA', 'Solicitud Transferencia', 1, null, 2],
      ['AUTOFIN', 'SOL_LIMITACION', 'Solicitud Limitación', 1, 'limitacion', 3],
      ['AUTOFIN', 'INFORME_GPS', 'Informe GPS', 1, 'gps', 4],
      ['UNIDAD DE CREDITO', 'CONTRATO_CV', 'Contrato Compraventa', 1, null, 1],
      ['UNIDAD DE CREDITO', 'SOL_TRANSFERENCIA', 'Solicitud Transferencia', 1, null, 2],
    ];
    for (const s of seed)
      await pool.query(
        `INSERT IGNORE INTO fundantes_seg_tipos (financiera, codigo, nombre, obligatorio, requiere_contrato, orden) VALUES (?,?,?,?,?,?)`, s);

    // Registro del módulo/card en Home (idempotente).
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (?, 'Seguimiento Fundantes', 'Carga y validación de los documentos fundantes de operaciones otorgadas (contrato de compraventa, transferencia, limitación, GPS): el ejecutivo los sube y Operaciones los valida', 'bi-folder-check', '/fundantes-seguimiento/', 108, 'activo')`,
      [MODULO_ID]);
    const funcs = [
      ['Seguimiento Fundantes', 'fundantes_seguimiento', '/fundantes-seguimiento/', 'bi-folder-check'],
      ['Validar Fundantes', 'fundantes_validar', null, 'bi-check2-circle'],
    ];
    const idFunc = {};
    for (const [nombre, codigo, href, icono] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)`,
        [MODULO_ID, nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    for (const codigo of Object.keys(idFunc)) {
      const idf = idFunc[codigo];
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    }
    console.log('[fundantes-seguimiento] módulo registrado');
  } catch (e) { console.error('[fundantes-seguimiento migration]', e.message); }
})();

/* ─── helpers ─────────────────────────────────────────────────────────────── */
const nombreUsuario = req => (req.usuario && `${req.usuario.nombre || ''} ${req.usuario.apellido || ''}`.trim()) ||
  (req.usuario && req.usuario.email) || 'Sistema';
const esEjecutivoComercial = req => req.usuario && req.usuario.perfil_nombre === 'Ejecutivo Comercial';
// ¿el campo contratado (gps/limitacion) viene "con el crédito"?  null/0/'' → no contratado.
const contratado = v => { const s = String(v == null ? '' : v).trim(); return s !== '' && s !== '0' && Number(s) !== 0; };

// Lista de ejecutivos visibles para este usuario (Ejecutivo Comercial → sólo los suyos; resto → todos).
async function ejecutivosVisibles(req) {
  if (!esEjecutivoComercial(req)) return { all: true, lista: null };
  const [asg] = await pool.query('SELECT ejecutivo FROM usuario_ejecutivos WHERE id_usuario = ?', [req.usuario.id_usuario]);
  return { all: false, lista: asg.map(r => r.ejecutivo) };
}

// Tipos requeridos para una operación según financiera + lo contratado. Devuelve [{codigo,nombre,obligatorio,orden}].
function tiposDeOperacion(op, tiposPorFin) {
  const arr = tiposPorFin[String(op.financiera || '').toUpperCase()] || [];
  return arr.map(t => ({
    codigo: t.codigo, nombre: t.nombre, orden: t.orden,
    obligatorio: t.requiere_contrato ? contratado(op[t.requiere_contrato]) : !!t.obligatorio,
  }));
}

/* ─── GET /api/fundantes-seguimiento ──────────────────────────────────────────
   Lista las operaciones otorgadas brokerage con sus documentos + estado + matriz. */
const listar = async (req, res) => {
  try {
    const fEjec = String(req.query.ejecutivo || '').trim();
    const fFin = String(req.query.financiera || '').trim().toUpperCase();
    const incluirCerrados = req.query.cerrados === '1' || req.query.cerrados === 'true';

    const vis = await ejecutivosVisibles(req);
    const filt = ['c.fecha_otorgado IS NOT NULL', 'UPPER(c.financiera) IN (?)'];
    const fp = [FINANCIERAS];
    if (!vis.all) {
      if (!vis.lista.length)
        return res.json({ success: true, data: [], resumen: matrizVacia(), ejecutivos: [], puede_validar: false, es_ejecutivo: true, nombre: nombreUsuario(req), error: null });
      filt.push('c.ejecutivo IN (?)'); fp.push(vis.lista);
    } else if (fEjec) { filt.push('c.ejecutivo = ?'); fp.push(fEjec); }
    if (fFin && FINANCIERAS.includes(fFin)) { filt.push('UPPER(c.financiera) = ?'); fp.push(fFin); }
    const where = 'WHERE ' + filt.join(' AND ');

    // Tipos por financiera (paramétrico)
    const [tipos] = await pool.query('SELECT financiera, codigo, nombre, obligatorio, requiere_contrato, orden FROM fundantes_seg_tipos ORDER BY orden');
    const tiposPorFin = {};
    tipos.forEach(t => (tiposPorFin[t.financiera.toUpperCase()] = tiposPorFin[t.financiera.toUpperCase()] || []).push(t));

    // Matriz resumen (sobre TODO el conjunto filtrado, sin límite, excluye CERRADO).
    const [agg] = await pool.query(`
      SELECT CASE WHEN COALESCE(fs.estado,'PENDIENTE')='ENVIADO' THEN 'ENV' ELSE 'PEND' END AS grp,
             DATEDIFF(CURDATE(), c.fecha_otorgado) AS dias, COUNT(*) AS n
      FROM creditos c LEFT JOIN fundantes_seg fs ON fs.id_credito = c.id
      ${where} AND COALESCE(fs.estado,'PENDIENTE') <> 'CERRADO'
      GROUP BY grp, dias`, fp);
    const resumen = matrizVacia();
    agg.forEach(r => { const b = bucketDe(Number(r.dias) || 0); if (b < 0) return; const k = r.grp === 'ENV' ? 'enviados' : 'pendientes'; resumen[k][b] += Number(r.n) || 0; });
    for (let i = 0; i < BUCKETS.length; i++) resumen.total[i] = resumen.pendientes[i] + resumen.enviados[i];

    // Lista de operaciones (limitada). Por defecto oculta CERRADO; orden: más días pendientes primero.
    const whereData = where + (incluirCerrados ? '' : " AND COALESCE(fs.estado,'PENDIENTE') <> 'CERRADO'");
    const [ops] = await pool.query(`
      SELECT c.id AS id_credito, c.num_op, c.financiera, c.id_financiera, c.ejecutivo,
             c.fecha_otorgado, c.gps, c.limitacion,
             DATEDIFF(CURDATE(), c.fecha_otorgado) AS dias,
             COALESCE(fs.estado,'PENDIENTE') AS estado, fs.comentario_rechazo,
             fs.fecha_envio, fs.fecha_validacion, fs.validado_por
      FROM creditos c LEFT JOIN fundantes_seg fs ON fs.id_credito = c.id
      ${whereData}
      ORDER BY dias DESC, c.num_op DESC
      LIMIT 500`, fp);

    // Documentos subidos de esas operaciones
    const ids = ops.map(o => o.id_credito);
    let docsPorOp = {};
    if (ids.length) {
      const [docs] = await pool.query(
        `SELECT id, id_credito, codigo, archivo_nombre, created_at FROM fundantes_seg_docs WHERE id_credito IN (?)`, [ids]);
      docs.forEach(d => (docsPorOp[d.id_credito] = docsPorOp[d.id_credito] || {})[d.codigo] = d);
    }

    const data = ops.map(o => {
      const reqs = tiposDeOperacion(o, tiposPorFin);
      const subidos = docsPorOp[o.id_credito] || {};
      const docs = reqs.map(t => {
        const d = subidos[t.codigo];
        return { codigo: t.codigo, nombre: t.nombre, obligatorio: t.obligatorio,
          subido: !!d, doc_id: d ? d.id : null, archivo_nombre: d ? d.archivo_nombre : null };
      });
      const faltan = docs.filter(d => d.obligatorio && !d.subido).length;
      const puede_enviar = (o.estado === 'PENDIENTE' || o.estado === 'RECHAZADO') && faltan === 0;
      return {
        id_credito: o.id_credito, num_op: o.num_op, financiera: o.financiera,
        id_financiera: o.id_financiera, ejecutivo: o.ejecutivo,
        fecha_otorgado: o.fecha_otorgado, dias: Number(o.dias) || 0,
        estado: o.estado, comentario_rechazo: o.comentario_rechazo,
        fecha_envio: o.fecha_envio, fecha_validacion: o.fecha_validacion, validado_por: o.validado_por,
        docs, faltan, puede_enviar,
      };
    });

    const [ejRows] = await pool.query(
      `SELECT DISTINCT ejecutivo FROM creditos WHERE fecha_otorgado IS NOT NULL AND UPPER(financiera) IN (?) AND ejecutivo IS NOT NULL AND ejecutivo<>'' ORDER BY ejecutivo`, [FINANCIERAS]);
    const ejecutivos = vis.all ? ejRows.map(r => r.ejecutivo) : (vis.lista || []);
    const puede_validar = await tieneFunc(req.usuario.id_usuario, 'fundantes_validar');

    res.json({ success: true, data, resumen, ejecutivos, puede_validar,
      es_ejecutivo: !vis.all, nombre: vis.all ? (fEjec || 'Todos los ejecutivos') : nombreUsuario(req), error: null });
  } catch (e) {
    console.error('[fundantes-seguimiento listar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

const matrizVacia = () => ({ pendientes: [0, 0, 0, 0, 0, 0], enviados: [0, 0, 0, 0, 0, 0], total: [0, 0, 0, 0, 0, 0], buckets: BUCKETS.map(b => b.lbl) });

/* ─── helper de propiedad: ¿el usuario puede tocar esta operación? ──────────── */
async function puedeOperar(req, id_credito) {
  if (await tieneFunc(req.usuario.id_usuario, 'fundantes_validar')) return true;   // Operaciones / Admin
  if (!esEjecutivoComercial(req)) return true;                                     // otros perfiles ven todo
  const vis = await ejecutivosVisibles(req);
  const [[c]] = await pool.query('SELECT ejecutivo FROM creditos WHERE id=?', [id_credito]);
  return !!c && vis.lista.includes(c.ejecutivo);
}

/* ─── POST /api/fundantes-seguimiento/:id/doc — sube (o reemplaza) un documento ── */
const subirDoc = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { codigo, archivo_nombre, mime_type, archivo_data } = req.body || {};
    if (!id || !codigo) return res.status(400).json({ success: false, data: null, error: 'id y codigo requeridos' });
    if (!archivo_data) return res.status(400).json({ success: false, data: null, error: 'Falta el archivo' });
    const [[op]] = await pool.query('SELECT id, financiera FROM creditos WHERE id=?', [id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    if (!(await puedeOperar(req, id))) return res.status(403).json({ success: false, data: null, error: 'Sin permiso sobre esta operación' });
    // El código debe ser un tipo válido de la financiera
    const [[tipo]] = await pool.query('SELECT codigo FROM fundantes_seg_tipos WHERE UPPER(financiera)=? AND codigo=?', [String(op.financiera || '').toUpperCase(), codigo]);
    if (!tipo) return res.status(400).json({ success: false, data: null, error: 'Tipo de documento no válido para esta financiera' });

    const buffer = Buffer.from(archivo_data, 'base64');
    await pool.query(
      `INSERT INTO fundantes_seg_docs (id_credito, codigo, archivo_nombre, mime_type, archivo_data, subido_por, id_subido_por)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE archivo_nombre=VALUES(archivo_nombre), mime_type=VALUES(mime_type),
         archivo_data=VALUES(archivo_data), subido_por=VALUES(subido_por), id_subido_por=VALUES(id_subido_por), created_at=NOW()`,
      [id, codigo, archivo_nombre || null, mime_type || null, buffer, nombreUsuario(req), req.usuario.id_usuario || null]);
    res.json({ success: true, data: { id_credito: id, codigo }, error: null });
  } catch (e) {
    console.error('[fundantes-seguimiento subirDoc]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── DELETE /api/fundantes-seguimiento/:id/doc/:codigo — quita un documento ── */
const eliminarDoc = async (req, res) => {
  try {
    const id = Number(req.params.id), codigo = String(req.params.codigo || '');
    if (!id || !codigo) return res.status(400).json({ success: false, data: null, error: 'id y codigo requeridos' });
    if (!(await puedeOperar(req, id))) return res.status(403).json({ success: false, data: null, error: 'Sin permiso sobre esta operación' });
    await pool.query('DELETE FROM fundantes_seg_docs WHERE id_credito=? AND codigo=?', [id, codigo]);
    res.json({ success: true, data: { id_credito: id, codigo }, error: null });
  } catch (e) {
    console.error('[fundantes-seguimiento eliminarDoc]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── GET /api/fundantes-seguimiento/doc/:docId/download ──────────────────── */
const descargar = async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT archivo_nombre, mime_type, archivo_data FROM fundantes_seg_docs WHERE id=?', [req.params.docId]);
    if (!row || !row.archivo_data) return res.status(404).json({ success: false, data: null, error: 'Archivo no encontrado' });
    res.set('Content-Type', row.mime_type || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${String(row.archivo_nombre || 'fundante').replace(/"/g, '').replace(/[^\x20-\x7E]/g, '_')}"`);
    res.send(row.archivo_data);
  } catch (e) {
    console.error('[fundantes-seguimiento descargar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── POST /api/fundantes-seguimiento/:id/enviar — envía a Validación ──────── */
const enviar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, data: null, error: 'id requerido' });
    const [[op]] = await pool.query('SELECT id, num_op, financiera, gps, limitacion FROM creditos WHERE id=?', [id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    if (!(await puedeOperar(req, id))) return res.status(403).json({ success: false, data: null, error: 'Sin permiso sobre esta operación' });
    const [[fs]] = await pool.query('SELECT estado FROM fundantes_seg WHERE id_credito=?', [id]);
    const estado = (fs && fs.estado) || 'PENDIENTE';
    if (estado === 'ENVIADO' || estado === 'CERRADO')
      return res.status(409).json({ success: false, data: null, error: 'La operación ya fue enviada' });

    // Verifica que estén todos los obligatorios (server-side)
    const [tipos] = await pool.query('SELECT codigo, nombre, obligatorio, requiere_contrato FROM fundantes_seg_tipos WHERE UPPER(financiera)=?', [String(op.financiera || '').toUpperCase()]);
    const oblig = tipos.filter(t => t.requiere_contrato ? contratado(op[t.requiere_contrato]) : !!t.obligatorio).map(t => t.codigo);
    const [subidos] = await pool.query('SELECT codigo FROM fundantes_seg_docs WHERE id_credito=?', [id]);
    const set = new Set(subidos.map(s => s.codigo));
    const faltan = oblig.filter(c => !set.has(c));
    if (faltan.length) return res.status(400).json({ success: false, data: null, error: 'Faltan documentos obligatorios por subir' });

    await pool.query(
      `INSERT INTO fundantes_seg (id_credito, estado, comentario_rechazo, fecha_envio, enviado_por, id_enviado_por)
       VALUES (?, 'ENVIADO', NULL, NOW(), ?, ?)
       ON DUPLICATE KEY UPDATE estado='ENVIADO', comentario_rechazo=NULL, fecha_envio=NOW(), enviado_por=VALUES(enviado_por), id_enviado_por=VALUES(id_enviado_por)`,
      [id, nombreUsuario(req), req.usuario.id_usuario || null]);
    auditar({ req, accion: 'ENVIAR_FUNDANTES', modulo: 'fundantes-seguimiento', entidad: 'credito', entidad_id: id,
      detalle: `Envió a validación los fundantes de la OP ${op.num_op}` });
    res.json({ success: true, data: { id_credito: id, estado: 'ENVIADO' }, error: null });
  } catch (e) {
    console.error('[fundantes-seguimiento enviar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ─── POST /api/fundantes-seguimiento/:id/validar — Operaciones aprueba/rechaza ──
   { accion:'aprobar'|'rechazar', comentario }. Rechazo exige comentario. (route: requireFunc fundantes_validar) */
const validar = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const accion = String((req.body || {}).accion || '').toLowerCase();
    const comentario = String((req.body || {}).comentario || '').trim();
    if (!id || !['aprobar', 'rechazar'].includes(accion))
      return res.status(400).json({ success: false, data: null, error: 'accion debe ser aprobar o rechazar' });
    if (accion === 'rechazar' && !comentario)
      return res.status(400).json({ success: false, data: null, error: 'El rechazo requiere un comentario' });
    const [[op]] = await pool.query('SELECT id, num_op FROM creditos WHERE id=?', [id]);
    if (!op) return res.status(404).json({ success: false, data: null, error: 'Operación no encontrada' });
    const [[fs]] = await pool.query('SELECT estado FROM fundantes_seg WHERE id_credito=?', [id]);
    if (!fs || fs.estado !== 'ENVIADO')
      return res.status(409).json({ success: false, data: null, error: 'Sólo se pueden validar operaciones ENVIADAS' });

    const estado = accion === 'aprobar' ? 'CERRADO' : 'RECHAZADO';
    await pool.query(
      `UPDATE fundantes_seg SET estado=?, comentario_rechazo=?, fecha_validacion=NOW(), validado_por=?, id_validado_por=? WHERE id_credito=?`,
      [estado, accion === 'rechazar' ? comentario : null, nombreUsuario(req), req.usuario.id_usuario || null, id]);
    auditar({ req, accion: accion === 'aprobar' ? 'APROBAR_FUNDANTES' : 'RECHAZAR_FUNDANTES', modulo: 'fundantes-seguimiento', entidad: 'credito', entidad_id: id,
      detalle: `${accion === 'aprobar' ? 'Aprobó (CERRADO)' : 'Rechazó'} los fundantes de la OP ${op.num_op}${comentario ? ' — ' + comentario : ''}`, meta: { estado, comentario: comentario || null } });
    res.json({ success: true, data: { id_credito: id, estado }, error: null });
  } catch (e) {
    console.error('[fundantes-seguimiento validar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { listar, subirDoc, eliminarDoc, descargar, enviar, validar };
