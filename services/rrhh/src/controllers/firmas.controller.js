'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   FIRMA ELECTRÓNICA SIMPLE (FES, Ley 19.799) de CONTRATOS y FINIQUITOS.
   · Dos firmas por documento: TRABAJADOR (el propio usuario, desde Mi Ficha)
     y EMPLEADOR (quien tenga rh_aprobar). Con ambas → estado FIRMADO.
   · Cada firma registra usuario, nombre, cargo, IP, fecha y el hash SHA-256
     del contenido del documento al momento de firmar; si el documento se
     altera después, la verificación marca "no íntegro".
   · El documento queda CONGELADO al enviarse a firma (no se edita más).
   ───────────────────────────────────────────────────────────────────────────── */
const crypto = require('crypto');
const pool = require('../../../../shared/config/database');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
const { auditar } = require('../../../../shared/audit');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

require('../../../../shared/migrate').enFila('rrhh-firmas', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_firmas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    entidad VARCHAR(12) NOT NULL,
    entidad_id INT NOT NULL,
    rol VARCHAR(12) NOT NULL,
    id_usuario INT NOT NULL,
    nombre VARCHAR(160), cargo VARCHAR(120), ip VARCHAR(45),
    hash_doc CHAR(64) NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_doc_rol (entidad, entidad_id, rol)
  )`);
  // Repositorio: documentos externos subidos (papel escaneado) también con huella FES
  for (const col of ['fecha_firma DATE NULL', 'firmado_fes TINYINT(1) DEFAULT 0'])
    try { await pool.query('ALTER TABLE rh_documentos ADD COLUMN ' + col); } catch (e) { if (e.errno !== 1060) throw e; }
  const [[modRRHH]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  if (modRRHH) {
    const [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_docs_firmados' LIMIT 1`);
    if (!f) {
      const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
        VALUES (?, 'Documentos Firmados', 'rh_docs_firmados', '/recursos-humanos/documentos-firmados/', 'bi-patch-check')`, [modRRHH.id_modulo]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
        SELECT pp.id_perfil, ?, 1 FROM permisos_perfil pp JOIN funcionalidades f2 ON f2.id_funcionalidad=pp.id_funcionalidad
        WHERE f2.codigo='rh_colaboradores' AND pp.habilitado=1`, [r.insertId]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1, ?, 1)`, [r.insertId]);
    }
  }
  console.log('[rrhh-firmas] listo');
});

// LIQUIDACION fuera del catálogo doc_tipos: las liquidaciones se obtienen del módulo
// Remuneraciones (emitidas y enviadas por correo) — no se archivan escaneadas.
require('../../../../shared/migrate').enFila('rrhh-doc-tipos-sin-liquidacion', async () => {
  await pool.query(`UPDATE rh_config SET valor=TRIM(BOTH ',' FROM REPLACE(CONCAT(',', valor, ','), ',LIQUIDACION,', ',')) WHERE clave='doc_tipos'`);
});

const TABLAS = { CONTRATO: 'rh_contratos', FINIQUITO: 'rh_finiquitos' };

/* Snapshot canónico del documento (los campos de fondo, en orden fijo) → SHA-256.
   Debe dar idéntico en cada firma y en cada verificación mientras nadie lo altere. */
async function docYHash(entidad, id) {
  const t = TABLAS[entidad];
  if (!t) return null;
  const [[d]] = await pool.query(`SELECT * FROM ${t} WHERE id=?`, [id]);
  if (!d) return null;
  const campos = entidad === 'CONTRATO'
    ? ['id', 'trabajador', 'rut', 'id_cargo', 'sueldo_base', 'fecha_ingreso', 'tipo_contrato', 'jornada', 'beneficios', 'otros']
    : ['id', 'trabajador', 'rut', 'cargo', 'fecha_ingreso', 'fecha_termino', 'causal', 'causal_glosa', 'detalle', 'total'];
  const snap = {};
  for (const c of campos) snap[c] = d[c] instanceof Date ? d[c].toISOString().slice(0, 10) : d[c];
  const hash = crypto.createHash('sha256').update(JSON.stringify(snap)).digest('hex');
  return { doc: d, hash };
}

const esRRHH = req => tieneFunc(req.usuario.id_usuario, 'rh_contratos', 'rh_colaboradores', 'rh_aprobar').catch(() => false);

/* ── Enviar a firma (RRHH) — congela el doc y avisa al trabajador ───────────── */
exports.enviar = async (req, res) => {
  try {
    if (!await esRRHH(req)) return fail(res, 'Sin permiso', 403);
    const entidad = String(req.body?.entidad || '');
    const id = parseInt(req.body?.id);
    const dh = await docYHash(entidad, id);
    if (!dh) return fail(res, 'Documento no existe', 404);
    const { doc } = dh;
    if (!['BORRADOR', 'EMITIDO', 'EN_FIRMA'].includes(doc.estado)) return fail(res, `El documento está ${doc.estado}`, 409);
    // El trabajador necesita cuenta para firmar: si el contrato no la trae, se vincula por RUT
    let idTrab = doc.id_usuario;
    if (!idTrab && doc.rut) {
      const [[u]] = await pool.query(`SELECT id_usuario FROM usuarios WHERE rut=? AND estado='activo' LIMIT 1`, [doc.rut]);
      if (u) { idTrab = u.id_usuario; await pool.query(`UPDATE ${TABLAS[entidad]} SET id_usuario=? WHERE id=?`, [idTrab, id]); }
    }
    if (!idTrab) return fail(res, 'El trabajador aún no tiene cuenta en el sistema — créala primero (la firma FES requiere sesión propia)', 400);
    await pool.query(`UPDATE ${TABLAS[entidad]} SET estado='EN_FIRMA' WHERE id=?`, [id]);
    notificar([idTrab], {
      tipo: 'RRHH', prioridad: 'alta', sonar: true,
      titulo: `Tienes un ${entidad === 'CONTRATO' ? 'contrato' : 'finiquito'} por firmar`,
      mensaje: 'Revísalo y fírmalo electrónicamente en Mi Ficha → Documentos por firmar',
      href: '/recursos-humanos/mi-ficha/', clave: `firma_env_${entidad}_${id}` });
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'rh_firma', entidad_id: id, detalle: `${entidad} #${id} enviado a firma FES` });
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Pendientes de MI firma (trabajador, Mi Ficha) ──────────────────────────── */
exports.pendientes = async (req, res) => {
  try {
    const me = req.usuario.id_usuario;
    const [cts] = await pool.query(
      `SELECT ct.id, 'CONTRATO' entidad, ct.trabajador, ct.sueldo_base, ct.tipo_contrato, ct.jornada,
              DATE_FORMAT(ct.fecha_ingreso,'%Y-%m-%d') fecha, c.nombre cargo, ct.beneficios, ct.otros
         FROM rh_contratos ct JOIN rh_cargos c ON c.id=ct.id_cargo
        WHERE ct.estado='EN_FIRMA' AND ct.id_usuario=?
          AND NOT EXISTS (SELECT 1 FROM rh_firmas f WHERE f.entidad='CONTRATO' AND f.entidad_id=ct.id AND f.rol='TRABAJADOR')`, [me]);
    const [fqs] = await pool.query(
      `SELECT fq.id, 'FINIQUITO' entidad, fq.trabajador, fq.cargo, fq.causal, fq.causal_glosa, fq.total,
              DATE_FORMAT(fq.fecha_termino,'%Y-%m-%d') fecha, fq.detalle
         FROM rh_finiquitos fq
        WHERE fq.estado='EN_FIRMA' AND fq.id_usuario=?
          AND NOT EXISTS (SELECT 1 FROM rh_firmas f WHERE f.entidad='FINIQUITO' AND f.entidad_id=fq.id AND f.rol='TRABAJADOR')`, [me]);
    ok(res, { pendientes: [...cts, ...fqs] });
  } catch (e) { fail(res, e.message); }
};

/* ── Firmar (TRABAJADOR = el titular · EMPLEADOR = rh_aprobar) ──────────────── */
exports.firmar = async (req, res) => {
  try {
    const entidad = String(req.body?.entidad || '');
    const id = parseInt(req.body?.id);
    const rol = String(req.body?.rol || 'TRABAJADOR');
    if (!['TRABAJADOR', 'EMPLEADOR'].includes(rol)) return fail(res, 'Rol inválido', 400);
    const dh = await docYHash(entidad, id);
    if (!dh) return fail(res, 'Documento no existe', 404);
    if (dh.doc.estado !== 'EN_FIRMA') return fail(res, `El documento está ${dh.doc.estado}, no en firma`, 409);
    const me = req.usuario.id_usuario;
    if (rol === 'TRABAJADOR' && dh.doc.id_usuario !== me) return fail(res, 'Solo el titular puede firmar como trabajador', 403);
    if (rol === 'EMPLEADOR' && !await tieneFunc(me, 'rh_aprobar').catch(() => false)) return fail(res, 'La firma del empleador requiere permiso rh_aprobar', 403);
    const [[u]] = await pool.query(`SELECT CONCAT_WS(' ', nombre, apellido) nombre, cargo FROM usuarios WHERE id_usuario=?`, [me]);
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 45);
    try {
      await pool.query(`INSERT INTO rh_firmas (entidad, entidad_id, rol, id_usuario, nombre, cargo, ip, hash_doc) VALUES (?,?,?,?,?,?,?,?)`,
        [entidad, id, rol, me, u?.nombre || '', u?.cargo || '', ip, dh.hash]);
    } catch (e) { if (e.errno === 1062) return fail(res, `Ya existe la firma ${rol} de este documento`, 409); throw e; }
    // ¿Están las dos? → FIRMADO + aviso
    const [[n]] = await pool.query(`SELECT COUNT(*) n FROM rh_firmas WHERE entidad=? AND entidad_id=?`, [entidad, id]);
    if (n.n >= 2) {
      await pool.query(`UPDATE ${TABLAS[entidad]} SET estado='FIRMADO' WHERE id=?`, [id]);
      const avisar = [dh.doc.id_usuario, dh.doc.creado_por].filter(x => x && x !== me);
      if (avisar.length) notificar(avisar, {
        tipo: 'RRHH', prioridad: 'media',
        titulo: `${entidad === 'CONTRATO' ? 'Contrato' : 'Finiquito'} #${id} firmado por ambas partes`,
        mensaje: `${dh.doc.trabajador} — documento FIRMADO con FES (Ley 19.799)`,
        href: '/recursos-humanos/contratos/', clave: `firma_ok_${entidad}_${id}` });
    } else if (rol === 'TRABAJADOR') {
      // avisar a los que pueden firmar por la empresa
      const [emp] = await pool.query(
        `SELECT DISTINCT u.id_usuario FROM usuarios u
          JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil AND pp.habilitado=1
          JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
         WHERE f.codigo='rh_aprobar' AND u.estado='activo'`);
      if (emp.length) notificar(emp.map(x => x.id_usuario), {
        tipo: 'RRHH', prioridad: 'alta', sonar: true,
        titulo: `${entidad === 'CONTRATO' ? 'Contrato' : 'Finiquito'} #${id} firmado por el trabajador`,
        mensaje: `${dh.doc.trabajador} ya firmó — falta la firma del empleador (Contratos → Firmas)`,
        href: '/recursos-humanos/contratos/', clave: `firma_trab_${entidad}_${id}` });
    }
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'rh_firma', entidad_id: id, detalle: `Firma FES ${rol} de ${entidad} #${id} (hash ${dh.hash.slice(0, 12)}…)` });
    ok(res, { ok: true, firmado: n.n >= 2 });
  } catch (e) { fail(res, e.message); }
};

/* ── MIS documentos firmados (repositorio del colaborador, Mi Ficha) ────────── */
exports.misDocumentos = async (req, res) => {
  try {
    const me = parseInt(req.params.idUsuario) || req.usuario.id_usuario;
    if (me !== req.usuario.id_usuario && !await esRRHH(req)) return fail(res, 'Sin permiso', 403);
    const docs = [];
    const [cts] = await pool.query(
      `SELECT ct.id, ct.estado, c.nombre cargo, DATE_FORMAT(ct.fecha_ingreso,'%Y-%m-%d') fecha
         FROM rh_contratos ct JOIN rh_cargos c ON c.id=ct.id_cargo WHERE ct.id_usuario=?`, [me]);
    cts.forEach(c => docs.push({ entidad: 'CONTRATO', id: c.id, glosa: `Contrato de trabajo — ${c.cargo}`, fecha: c.fecha, estado: c.estado }));
    const [fqs] = await pool.query(
      `SELECT id, estado, causal_glosa, DATE_FORMAT(fecha_termino,'%Y-%m-%d') fecha FROM rh_finiquitos WHERE id_usuario=?`, [me]);
    fqs.forEach(f => docs.push({ entidad: 'FINIQUITO', id: f.id, glosa: `Finiquito — ${f.causal_glosa || ''}`, fecha: f.fecha, estado: f.estado }));
    const [vcs] = await pool.query(
      `SELECT v.id, v.estado, v.dias, DATE_FORMAT(v.fecha_desde,'%Y-%m-%d') fecha
         FROM rh_vacaciones v WHERE v.id_usuario=? AND EXISTS (SELECT 1 FROM rh_firmas f WHERE f.entidad='VACACIONES' AND f.entidad_id=v.id)`, [me]);
    vcs.forEach(v => docs.push({ entidad: 'VACACIONES', id: v.id, glosa: `Vacaciones — ${v.dias} día(s) desde ${v.fecha}`, fecha: v.fecha, estado: v.estado }));
    const [sols] = await pool.query(`SELECT id, tipo, estado, DATE_FORMAT(created_at,'%Y-%m-%d') fecha FROM rh_solicitudes WHERE id_usuario=?`, [me]);
    sols.forEach(s => docs.push({ entidad: 'SOLICITUD', id: s.id, glosa: `Solicitud ${s.tipo}`, fecha: s.fecha, estado: s.estado }));
    // firmas de cada documento (rh_firmas para docs; rh_sol_firmas para solicitudes)
    const [fd] = await pool.query(
      `SELECT entidad, entidad_id, rol, nombre, cargo, DATE_FORMAT(created_at,'%d-%m-%Y %H:%i') fecha
         FROM rh_firmas WHERE (entidad, entidad_id) IN (
           SELECT 'CONTRATO', id FROM rh_contratos WHERE id_usuario=? UNION
           SELECT 'FINIQUITO', id FROM rh_finiquitos WHERE id_usuario=? UNION
           SELECT 'VACACIONES', id FROM rh_vacaciones WHERE id_usuario=?) ORDER BY created_at`, [me, me, me]);
    const [fs] = await pool.query(
      `SELECT f.id_solicitud, f.rol, f.nombre, f.cargo, f.decision, DATE_FORMAT(f.created_at,'%d-%m-%Y %H:%i') fecha
         FROM rh_sol_firmas f JOIN rh_solicitudes s ON s.id=f.id_solicitud WHERE s.id_usuario=? ORDER BY f.created_at`, [me]);
    docs.forEach(d => {
      d.firmas = d.entidad === 'SOLICITUD'
        ? fs.filter(x => x.id_solicitud === d.id)
        : fd.filter(x => x.entidad === d.entidad && x.entidad_id === d.id);
    });
    docs.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
    ok(res, { documentos: docs.filter(d => d.firmas.length) });
  } catch (e) { fail(res, e.message); }
};

/* ── REPOSITORIO central (RRHH): todos los documentos firmados FES ──────────── */
exports.repositorio = async (req, res) => {
  try {
    if (!await esRRHH(req)) return fail(res, 'Solo RRHH', 403);
    const docs = [];
    const [cts] = await pool.query(
      `SELECT ct.id, ct.estado, ct.id_usuario, ct.trabajador, c.nombre cargo, DATE_FORMAT(ct.fecha_ingreso,'%Y-%m-%d') fecha
         FROM rh_contratos ct JOIN rh_cargos c ON c.id=ct.id_cargo
        WHERE EXISTS (SELECT 1 FROM rh_firmas f WHERE f.entidad='CONTRATO' AND f.entidad_id=ct.id) LIMIT 1000`);
    cts.forEach(c => docs.push({ tipo: 'CONTRATO', id: c.id, empleado: c.trabajador, glosa: `Contrato — ${c.cargo}`, fecha: c.fecha, estado: c.estado }));
    const [fqs] = await pool.query(
      `SELECT id, estado, trabajador, causal_glosa, DATE_FORMAT(fecha_termino,'%Y-%m-%d') fecha FROM rh_finiquitos
        WHERE EXISTS (SELECT 1 FROM rh_firmas f WHERE f.entidad='FINIQUITO' AND f.entidad_id=rh_finiquitos.id) LIMIT 1000`);
    fqs.forEach(f => docs.push({ tipo: 'FINIQUITO', id: f.id, empleado: f.trabajador, glosa: `Finiquito — ${f.causal_glosa || ''}`, fecha: f.fecha, estado: f.estado }));
    const [vcs] = await pool.query(
      `SELECT v.id, v.estado, v.nombre, v.dias, DATE_FORMAT(v.fecha_desde,'%Y-%m-%d') fecha FROM rh_vacaciones v
        WHERE EXISTS (SELECT 1 FROM rh_firmas f WHERE f.entidad='VACACIONES' AND f.entidad_id=v.id) LIMIT 1000`);
    vcs.forEach(v => docs.push({ tipo: 'VACACIONES', id: v.id, empleado: v.nombre, glosa: `Vacaciones — ${v.dias} día(s)`, fecha: v.fecha, estado: v.estado }));
    const [sols] = await pool.query(`SELECT id, tipo, estado, nombre, DATE_FORMAT(created_at,'%Y-%m-%d') fecha FROM rh_solicitudes
        WHERE EXISTS (SELECT 1 FROM rh_sol_firmas f WHERE f.id_solicitud=rh_solicitudes.id) LIMIT 1000`);
    sols.forEach(s => docs.push({ tipo: 'SOLICITUD', id: s.id, empleado: s.nombre, glosa: `Solicitud ${s.tipo}`, fecha: s.fecha, estado: s.estado }));
    const [subs] = await pool.query(
      `SELECT d.id, d.tipo doc_tipo, d.nombre_archivo, DATE_FORMAT(d.fecha_firma,'%Y-%m-%d') fecha,
              TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) empleado
         FROM rh_documentos d LEFT JOIN usuarios u ON u.id_usuario=d.id_usuario
        WHERE d.firmado_fes=1 LIMIT 1000`);
    subs.forEach(s => docs.push({ tipo: s.doc_tipo || 'OTRO', id: s.id, empleado: s.empleado, glosa: s.nombre_archivo, fecha: s.fecha, estado: 'FIRMADO', doc_id: s.id }));
    // firmas de todo
    const [fd] = await pool.query(`SELECT entidad, entidad_id, rol, nombre, cargo, DATE_FORMAT(created_at,'%d-%m-%Y %H:%i') ff FROM rh_firmas ORDER BY created_at`);
    const [fs] = await pool.query(`SELECT id_solicitud, rol, nombre, decision, DATE_FORMAT(created_at,'%d-%m-%Y %H:%i') ff FROM rh_sol_firmas ORDER BY created_at`);
    docs.forEach(d => {
      if (d.tipo === 'SOLICITUD') d.firmas = fs.filter(x => x.id_solicitud === d.id);
      else if (d.doc_id) d.firmas = fd.filter(x => x.entidad === 'ARCHIVO' && x.entidad_id === d.doc_id);
      else d.firmas = fd.filter(x => x.entidad === d.tipo && x.entidad_id === d.id);
    });
    docs.sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')));
    // catálogos para la pestaña Subir
    const [[t]] = await pool.query(`SELECT valor FROM rh_config WHERE clave='doc_tipos'`);
    const tipos = String(t?.valor || 'CONTRATO,ANEXO,OTRO').split(',').map(s => s.trim()).filter(Boolean);
    const [emps] = await pool.query(`SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre FROM usuarios u LEFT JOIN rh_fichas unm ON unm.id_usuario=u.id_usuario WHERE u.estado='activo' AND COALESCE(unm.no_mostrar,0)=0 ORDER BY nombre`);
    ok(res, { documentos: docs, tipos, empleados: emps });
  } catch (e) { fail(res, e.message); }
};

/* ── Subir documento firmado en papel (escaneado) — queda con huella FES ────── */
exports.subirFirmado = async (req, res) => {
  try {
    if (!await esRRHH(req)) return fail(res, 'Solo RRHH', 403);
    const b = req.body || {};
    const idU = parseInt(b.id_usuario);
    const tipo = String(b.tipo || '').toUpperCase().slice(0, 40);
    const fecha = String(b.fecha_firma || '').slice(0, 10);
    if (!idU || !tipo || !fecha || !b.archivo_data) return fail(res, 'Empleado, tipo, fecha de firma y archivo son requeridos', 400);
    const buffer = Buffer.from(b.archivo_data, 'base64');
    if (buffer.length > 15 * 1024 * 1024) return fail(res, 'Archivo supera 15 MB', 400);
    const [[u]] = await pool.query(`SELECT TRIM(CONCAT_WS(' ', nombre, apellido)) nombre, rut FROM usuarios WHERE id_usuario=?`, [idU]);
    if (!u) return fail(res, 'Empleado no existe', 404);
    // Renombrado canónico: TIPO_Nombre-Apellido_fecha.ext
    const ext = (String(b.archivo_nombre || '').match(/\.[a-z0-9]+$/i) || ['.pdf'])[0];
    const nombreCanon = `${tipo}_${u.nombre.replace(/\s+/g, '-')}_${fecha}${ext}`.slice(0, 255);
    const [[yo]] = await pool.query(`SELECT TRIM(CONCAT_WS(' ', nombre, apellido)) nombre, cargo FROM usuarios WHERE id_usuario=?`, [req.usuario.id_usuario]);
    const [r] = await pool.query(
      `INSERT INTO rh_documentos (id_usuario, tipo, nombre_archivo, mime_type, archivo_data, subido_por, fecha_firma, firmado_fes)
       VALUES (?,?,?,?,?,?,?,1)`,
      [idU, tipo, nombreCanon, b.mime_type || null, buffer, yo?.nombre || '', fecha]);
    // Huella FES del ARCHIVO: hash del binario — cualquier alteración posterior se detecta
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 45);
    await pool.query(`INSERT IGNORE INTO rh_firmas (entidad, entidad_id, rol, id_usuario, nombre, cargo, ip, hash_doc)
      VALUES ('ARCHIVO', ?, 'EMPLEADOR', ?, ?, ?, ?, ?)`, [r.insertId, req.usuario.id_usuario, yo?.nombre || '', yo?.cargo || '', ip, hash]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'documento', entidad_id: r.insertId,
      detalle: `Subió ${tipo} firmado de ${u.nombre} (fecha firma ${fecha}) al repositorio — hash ${hash.slice(0, 12)}…` });
    ok(res, { id: r.insertId, nombre_archivo: nombreCanon });
  } catch (e) { fail(res, e.message); }
};

/* ── Firmas de un documento + verificación de integridad ────────────────────── */
exports.deDocumento = async (req, res) => {
  try {
    const entidad = String(req.params.entidad || '').toUpperCase();
    const id = parseInt(req.params.id);
    const dh = await docYHash(entidad, id);
    if (!dh) return fail(res, 'Documento no existe', 404);
    // lo ve RRHH o el propio titular
    if (dh.doc.id_usuario !== req.usuario.id_usuario && !await esRRHH(req)) return fail(res, 'Sin permiso', 403);
    const [firmas] = await pool.query(
      `SELECT rol, nombre, cargo, ip, hash_doc, DATE_FORMAT(created_at,'%Y-%m-%d %H:%i') fecha
         FROM rh_firmas WHERE entidad=? AND entidad_id=? ORDER BY created_at`, [entidad, id]);
    ok(res, { estado: dh.doc.estado, firmas: firmas.map(f => ({ ...f, integro: f.hash_doc === dh.hash })) });
  } catch (e) { fail(res, e.message); }
};
