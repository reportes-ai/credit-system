'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   RRHH — Entrega de Equipos (Pato, 23-09-2026).
   Inventario de laptops, celulares y otros equipos, con su historial de entregas y
   devoluciones por colaborador y el Acta de Recepción/Devolución en PDF, cuyo texto
   se edita desde la misma página (rh_config → acta_eq_*). Reemplaza la planilla
   ENTREGA EQUIPOS.xlsx y el acta Word que se llenaba a mano.
   · rh_equipos      → el equipo (uno por serie); estado DISPONIBLE / ASIGNADO / BAJA.
   · rh_equipos_mov  → cada ENTREGA y DEVOLUCION (quién, cuándo, acta firmada).
   · NUNCA se guardan claves de acceso del equipo (la planilla las traía; aquí no).
   · Amarre onboarding/offboarding: la entrega marca la tarea "Entrega de equipos" del
     ONBOARDING abierto; la devolución del último equipo marca la del OFFBOARDING.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const almacen = require('../../../../shared/almacen-docs');
const empresa = require('../../../../shared/empresa');   // a nivel de módulo: sus migraciones se encolan al boot, no dentro de un bloque

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const TIPOS = ['LAPTOP', 'CELULAR', 'OTRO'];
const TIPO_LABEL = { LAPTOP: 'Laptop', CELULAR: 'Celular', OTRO: 'Otro' };
const nombreDe = u => [u?.nombre, u?.apellido].filter(Boolean).join(' ') || u?.email || 'Sistema';
const isoFecha = f => f instanceof Date ? `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}` : String(f || '').slice(0, 10);
const hoyChile = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const fmtD = s => { const [y, m, d] = isoFecha(s).split('-'); return d ? `${d}/${m}/${y}` : ''; };

// Texto del acta: claves de rh_config con su valor por defecto (el acta Word que se usaba a mano)
const TEXTOS_DEFAULT = {
  acta_eq_titulo: 'Acta de Recepción Conforme',
  acta_eq_intro: 'Por la presente, yo, {nombre}, RUT: {rut}, declaro recibir a entera satisfacción, el equipo entregado por {empresa}, RUT: {rut_empresa} e individualizado a continuación:',
  acta_eq_importante: 'Certifico que los elementos detallados en el presente documento, me han sido entregados para mi cuidado y custodia con el propósito de cumplir con las tareas y asignaciones propias de mi cargo en la institución, siendo estos de mi única y exclusiva responsabilidad. Me comprometo a usar correctamente los recursos, y solo para los fines establecidos, a no instalar ni permitir la instalación de software por personal ajeno al grupo interno de trabajo de soporte Tecnológico, responsabilizándome por la pérdida o deterioros asociados a negligencias los cuales serán bajo mi cargo. En caso de que el Trabajador se retire de la empresa, ya sea por renuncia voluntaria o por desvinculación, tendrá la obligación de devolver el equipo, en las mismas condiciones en que fue entregado. En caso de no efectuar la devolución anteriormente descrita, la Empresa se reserva el derecho de ejercer las acciones legales pertinentes, tanto civiles, como penales.',
  acta_eq_telefonos: 'Para el caso de los Teléfonos, estos se consideran herramientas de trabajo y deben estar encendidos y ser atendidos durante la jornada de trabajo.',
  acta_eq_dev_titulo: 'Acta de Devolución de Equipo',
  acta_eq_dev_intro: '{empresa}, RUT: {rut_empresa}, declara recibir de {nombre}, RUT: {rut}, el equipo individualizado a continuación, que le fuera entregado el {fecha_entrega} para el desempeño de sus funciones:',
  acta_eq_dev_importante: 'El equipo se recibe en las condiciones que se indican en las observaciones. Con esta devolución el trabajador queda liberado de la custodia y responsabilidad sobre el equipo.',
  acta_eq_firmante: '',   // quien firma por la empresa; vacío = representante legal de Datos de la Empresa
};
const CLAVES_TEXTO = Object.keys(TEXTOS_DEFAULT);

require('../../../../shared/migrate').enFila('rrhh-equipos', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_equipos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    tipo VARCHAR(12) NOT NULL,
    descripcion VARCHAR(160) NULL,
    marca VARCHAR(80) NULL,
    modelo VARCHAR(160) NULL,
    serie VARCHAR(80) NULL,
    numero_linea VARCHAR(20) NULL,
    estado VARCHAR(12) NOT NULL DEFAULT 'DISPONIBLE',
    id_usuario_actual INT NULL,
    id_mov_actual INT NULL,
    comentarios VARCHAR(500) NULL,
    creado_por VARCHAR(160) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_tipo (tipo, estado), INDEX idx_usuario (id_usuario_actual)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_equipos_mov (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_equipo INT NOT NULL,
    accion VARCHAR(12) NOT NULL,
    id_usuario INT NULL,
    nombre VARCHAR(200) NULL,
    rut VARCHAR(15) NULL,
    fecha DATE NOT NULL,
    usuario_login VARCHAR(80) NULL,
    comentario VARCHAR(500) NULL,
    id_documento INT NULL,
    registrado_por VARCHAR(160) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_equipo (id_equipo, id), INDEX idx_usuario (id_usuario)
  )`);
  for (const [k, v] of Object.entries(TEXTOS_DEFAULT)) await pool.query('INSERT IGNORE INTO rh_config (clave, valor) VALUES (?,?)', [k, v]);
  // El acta firmada va a la Carpeta Digital con su propio tipo (catálogo paramétrico rh_config.doc_tipos)
  await pool.query("UPDATE rh_config SET valor=CONCAT(valor, ',ACTA EQUIPOS') WHERE clave='doc_tipos' AND FIND_IN_SET('ACTA EQUIPOS', valor)=0");
  // Card + permiso rh_equipos (hereda de quien tiene rh_colaboradores)
  const [[modRRHH]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  const [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_equipos' LIMIT 1`);
  if (modRRHH && !f) {
    const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
      VALUES (?, 'Entrega de Equipos', 'rh_equipos', '/recursos-humanos/equipos/', 'bi-laptop')`, [modRRHH.id_modulo]);
    await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
      SELECT pp.id_perfil, ?, 1 FROM permisos_perfil pp JOIN funcionalidades f2 ON f2.id_funcionalidad=pp.id_funcionalidad
      WHERE f2.codigo='rh_colaboradores' AND pp.habilitado=1`, [r.insertId]);
    await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1, ?, 1)`, [r.insertId]);
    console.log('[rrhh-equipos] card creada');
  }
  // Tarea de ONBOARDING (la de OFFBOARDING "Devolución de equipos" ya existe en la plantilla sembrada)
  const [[t]] = await pool.query(`SELECT id FROM rh_onb_plantilla WHERE tipo='ONBOARDING' AND tarea LIKE 'Entrega de equipos%' LIMIT 1`);
  if (!t) await pool.query(`INSERT INTO rh_onb_plantilla (tipo, orden, tarea, responsable, dias_plazo) VALUES ('ONBOARDING', 2, 'Entrega de equipos (laptop / celular) con acta firmada', 'TI', 0)`);
});

/* ── Textos del acta ─────────────────────────────────────────────────────── */
async function textos() {
  const [rows] = await pool.query('SELECT clave, valor FROM rh_config WHERE clave IN (?)', [CLAVES_TEXTO]);
  const t = { ...TEXTOS_DEFAULT }; rows.forEach(r => { if (r.valor != null && r.valor !== '') t[r.clave] = r.valor; });
  return t;
}
exports.getTextos = async (req, res) => { try { ok(res, { textos: await textos(), defaults: TEXTOS_DEFAULT }); } catch (e) { fail(res, e.message); } };
exports.setTextos = async (req, res) => {
  try {
    const b = req.body || {};
    for (const k of CLAVES_TEXTO) if (k in b)
      await pool.query('INSERT INTO rh_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', [k, String(b[k] == null ? '' : b[k]).slice(0, 5000)]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'equipos-acta', detalle: 'Editó el texto del acta de equipos: ' + Object.keys(b).filter(k => CLAVES_TEXTO.includes(k)).join(', ') });
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

/* ── Inventario ──────────────────────────────────────────────────────────── */
exports.listar = async (req, res) => {
  try {
    const [equipos] = await pool.query(
      `SELECT e.*, COALESCE(NULLIF(TRIM(CONCAT_WS(' ', u.nombre, u.apellido)), ''), m.nombre) AS asignado_nombre, m.fecha AS fecha_entrega, m.usuario_login
         FROM rh_equipos e
         LEFT JOIN usuarios u ON u.id_usuario = e.id_usuario_actual
         LEFT JOIN rh_equipos_mov m ON m.id = e.id_mov_actual
        ORDER BY e.estado='ASIGNADO' DESC, e.marca, e.modelo LIMIT 2000`);
    const [colab] = await pool.query(
      `SELECT id_usuario, rut, TRIM(CONCAT_WS(' ', nombre, apellido, apellido_materno)) AS nombre, cargo
         FROM usuarios WHERE estado='activo' ORDER BY nombre LIMIT 800`);
    ok(res, { equipos, colaboradores: colab });
  } catch (e) { console.error('[equipos listar]', e.message); fail(res, 'Error interno del servidor'); }
};

const limpiar = b => ({
  tipo: TIPOS.includes(String(b.tipo || '').toUpperCase()) ? String(b.tipo).toUpperCase() : null,
  descripcion: String(b.descripcion || '').trim().slice(0, 160) || null,
  marca: String(b.marca || '').trim().slice(0, 80) || null,
  modelo: String(b.modelo || '').trim().slice(0, 160) || null,
  serie: String(b.serie || '').trim().slice(0, 80) || null,
  numero_linea: String(b.numero_linea || '').replace(/\s/g, '').slice(0, 20) || null,
  comentarios: String(b.comentarios || '').trim().slice(0, 500) || null,
});

exports.crear = async (req, res) => {
  try {
    const d = limpiar(req.body || {});
    if (!d.tipo) return fail(res, 'Tipo inválido', 400);
    if (d.tipo === 'OTRO' && !d.descripcion) return fail(res, 'Indica qué equipo es (descripción)', 400);
    if (d.tipo !== 'OTRO' && !d.marca && !d.modelo) return fail(res, 'Indica marca o modelo', 400);
    if (d.serie) {
      const [[dup]] = await pool.query("SELECT id FROM rh_equipos WHERE serie=? AND estado<>'BAJA' LIMIT 1", [d.serie]);
      if (dup) return fail(res, `Ya existe un equipo con la serie ${d.serie} (#${dup.id})`, 400);
    }
    const [r] = await pool.query('INSERT INTO rh_equipos (tipo, descripcion, marca, modelo, serie, numero_linea, comentarios, creado_por) VALUES (?,?,?,?,?,?,?,?)',
      [d.tipo, d.descripcion, d.marca, d.modelo, d.serie, d.numero_linea, d.comentarios, nombreDe(req.usuario)]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'equipo', entidad_id: r.insertId, detalle: `${TIPO_LABEL[d.tipo]} ${d.marca || ''} ${d.modelo || ''} serie ${d.serie || '—'}` });
    ok(res, { id: r.insertId });
  } catch (e) { console.error('[equipos crear]', e.message); fail(res, 'Error interno del servidor'); }
};

exports.editar = async (req, res) => {
  try {
    const id = Number(req.params.id); if (!id) return fail(res, 'ID inválido', 400);
    const d = limpiar(req.body || {});
    if (!d.tipo) return fail(res, 'Tipo inválido', 400);
    const estado = ['DISPONIBLE', 'BAJA'].includes(req.body?.estado) ? req.body.estado : null;
    const [[e]] = await pool.query('SELECT * FROM rh_equipos WHERE id=?', [id]);
    if (!e) return fail(res, 'Equipo no existe', 404);
    if (estado && e.estado === 'ASIGNADO') return fail(res, 'Primero registra la devolución', 400);
    await pool.query('UPDATE rh_equipos SET tipo=?, descripcion=?, marca=?, modelo=?, serie=?, numero_linea=?, comentarios=?, estado=COALESCE(?, estado) WHERE id=?',
      [d.tipo, d.descripcion, d.marca, d.modelo, d.serie, d.numero_linea, d.comentarios, estado, id]);
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'equipo', entidad_id: id, detalle: `Editó ${TIPO_LABEL[d.tipo]} serie ${d.serie || '—'}${estado ? ' → ' + estado : ''}` });
    ok(res, { ok: true });
  } catch (e) { console.error('[equipos editar]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── Amarre con el checklist de onboarding / offboarding ─────────────────── */
async function marcarTareaOnb(tipo, idUsuario, patron, quien) {
  try {
    await pool.query(
      `UPDATE rh_onb_items i JOIN rh_onb_procesos p ON p.id=i.id_proceso
          SET i.ok=1, i.ok_por=?, i.ok_at=NOW()
        WHERE p.tipo=? AND p.estado='ABIERTO' AND p.id_usuario=? AND i.ok=0 AND i.tarea LIKE ?`, [quien, tipo, idUsuario, patron]);
  } catch (e) { console.error('[equipos onb]', e.message); }
}

/* ── Entrega / Devolución ────────────────────────────────────────────────── */
exports.entregar = async (req, res) => {
  try {
    const id = Number(req.params.id); const b = req.body || {};
    const idUsuario = Number(b.id_usuario);
    if (!id || !idUsuario) return fail(res, 'Falta el colaborador', 400);
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(b.fecha || '') ? b.fecha : hoyChile();
    const [[e]] = await pool.query('SELECT * FROM rh_equipos WHERE id=?', [id]);
    if (!e) return fail(res, 'Equipo no existe', 404);
    if (e.estado === 'ASIGNADO') return fail(res, 'El equipo ya está asignado: registra primero la devolución', 400);
    if (e.estado === 'BAJA') return fail(res, 'El equipo está dado de baja', 400);
    const [[u]] = await pool.query("SELECT id_usuario, rut, TRIM(CONCAT_WS(' ', nombre, apellido, apellido_materno)) nombre FROM usuarios WHERE id_usuario=?", [idUsuario]);
    if (!u) return fail(res, 'Colaborador no existe', 404);
    const quien = nombreDe(req.usuario);
    const [r] = await pool.query('INSERT INTO rh_equipos_mov (id_equipo, accion, id_usuario, nombre, rut, fecha, usuario_login, comentario, registrado_por) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, 'ENTREGA', u.id_usuario, u.nombre, u.rut, fecha, String(b.usuario_login || '').trim().slice(0, 80) || null, String(b.comentario || '').trim().slice(0, 500) || null, quien]);
    await pool.query("UPDATE rh_equipos SET estado='ASIGNADO', id_usuario_actual=?, id_mov_actual=? WHERE id=?", [u.id_usuario, r.insertId, id]);
    await marcarTareaOnb('ONBOARDING', u.id_usuario, 'Entrega de equipos%', quien);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'equipo-entrega', entidad_id: r.insertId, detalle: `Entregó ${TIPO_LABEL[e.tipo]} ${e.marca || ''} ${e.modelo || ''} serie ${e.serie || '—'} a ${u.nombre} (${fecha})` });
    ok(res, { id_mov: r.insertId });
  } catch (e) { console.error('[equipos entregar]', e.message); fail(res, 'Error interno del servidor'); }
};

exports.devolver = async (req, res) => {
  try {
    const id = Number(req.params.id); const b = req.body || {};
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(b.fecha || '') ? b.fecha : hoyChile();
    const [[e]] = await pool.query('SELECT * FROM rh_equipos WHERE id=?', [id]);
    if (!e) return fail(res, 'Equipo no existe', 404);
    if (e.estado !== 'ASIGNADO') return fail(res, 'El equipo no está asignado', 400);
    const [[ent]] = await pool.query('SELECT * FROM rh_equipos_mov WHERE id=?', [e.id_mov_actual]);
    const quien = nombreDe(req.usuario);
    const [r] = await pool.query('INSERT INTO rh_equipos_mov (id_equipo, accion, id_usuario, nombre, rut, fecha, comentario, registrado_por) VALUES (?,?,?,?,?,?,?,?)',
      [id, 'DEVOLUCION', ent?.id_usuario || e.id_usuario_actual, ent?.nombre || null, ent?.rut || null, fecha, String(b.comentario || '').trim().slice(0, 500) || null, quien]);
    const nuevoEstado = b.baja ? 'BAJA' : 'DISPONIBLE';
    await pool.query('UPDATE rh_equipos SET estado=?, id_usuario_actual=NULL, id_mov_actual=NULL WHERE id=?', [nuevoEstado, id]);
    const idU = ent?.id_usuario || e.id_usuario_actual;
    if (idU) {
      const [[pend]] = await pool.query("SELECT COUNT(*) n FROM rh_equipos WHERE id_usuario_actual=? AND estado='ASIGNADO'", [idU]);
      if (!pend.n) await marcarTareaOnb('OFFBOARDING', idU, 'Devolución de equipos%', quien);
    }
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'equipo-devolucion', entidad_id: r.insertId, detalle: `Devolución de ${TIPO_LABEL[e.tipo]} serie ${e.serie || '—'} por ${ent?.nombre || '—'} (${fecha})${b.baja ? ' → BAJA' : ''}` });
    ok(res, { id_mov: r.insertId });
  } catch (e) { console.error('[equipos devolver]', e.message); fail(res, 'Error interno del servidor'); }
};

exports.historial = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [movs] = await pool.query('SELECT * FROM rh_equipos_mov WHERE id_equipo=? ORDER BY id DESC LIMIT 200', [id]);
    ok(res, movs);
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

/* ── Acta PDF (motor único shared/acta-equipos-pdf) ──────────────────────── */
async function armarActa(idMov) {
  const [[m]] = await pool.query('SELECT * FROM rh_equipos_mov WHERE id=?', [idMov]);
  if (!m) return null;
  const [[e]] = await pool.query('SELECT * FROM rh_equipos WHERE id=?', [m.id_equipo]);
  const t = await textos();
  const emp = await empresa.datosEmpresa();
  const firmante = t.acta_eq_firmante || emp.representante || '';
  const dev = m.accion === 'DEVOLUCION';
  let fechaEntrega = '';
  if (dev) {
    const [[ent]] = await pool.query("SELECT fecha FROM rh_equipos_mov WHERE id_equipo=? AND accion='ENTREGA' AND id<? ORDER BY id DESC LIMIT 1", [m.id_equipo, m.id]);
    fechaEntrega = ent ? fmtD(ent.fecha) : '';
  }
  const vars = { nombre: m.nombre || '', rut: m.rut || '', empresa: emp.razon_social || '', rut_empresa: emp.rut_formateado || '', fecha: fmtD(m.fecha), fecha_entrega: fechaEntrega,
    equipo: TIPO_LABEL[e.tipo] || e.tipo, marca: e.marca || '', modelo: e.modelo || '', serie: e.serie || '', observaciones: m.comentario || '' };
  const { generarActaEquiposPDF } = require('../../../../shared/acta-equipos-pdf');
  const buffer = await generarActaEquiposPDF({
    accion: m.accion,
    textos: dev ? { titulo: t.acta_eq_dev_titulo, intro: t.acta_eq_dev_intro, importante: t.acta_eq_dev_importante + (m.comentario ? `\nObservaciones: ${m.comentario}` : ''), firma_empresa: firmante }
                : { titulo: t.acta_eq_titulo, intro: t.acta_eq_intro, importante: t.acta_eq_importante, telefonos: t.acta_eq_telefonos, firma_empresa: firmante },
    vars, equipo: { ...e, tipo_label: e.tipo === 'OTRO' ? (e.descripcion || 'Otro') : TIPO_LABEL[e.tipo] },
  });
  return { buffer, m, e, nombre: `Acta-${dev ? 'Devolucion' : 'Recepcion'}-Equipo-${(e.serie || e.id)}-${isoFecha(m.fecha)}.pdf` };
}

exports.acta = async (req, res) => {
  try {
    const a = await armarActa(Number(req.params.id));
    if (!a) return fail(res, 'Movimiento no existe', 404);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(a.nombre)}"`);
    res.send(a.buffer);
  } catch (e) { console.error('[equipos acta]', e.message); fail(res, 'Error interno del servidor'); }
};

// Vista previa del texto editado (sin movimiento): datos de ejemplo
exports.actaPreview = async (req, res) => {
  try {
    const t = { ...(await textos()), ...(req.query || {}) };
    const emp = await empresa.datosEmpresa();
    const firmante = t.acta_eq_firmante || emp.representante || '';
    const dev = req.query.tipo === 'DEVOLUCION';
    const vars = { nombre: 'Nombre Apellido Apellido', rut: '12.345.678-9', empresa: emp.razon_social || '', rut_empresa: emp.rut_formateado || '', fecha: fmtD(hoyChile()), fecha_entrega: '01/01/2026', equipo: 'Laptop', marca: 'Marca', modelo: 'Modelo', serie: 'SERIE123' };
    const { generarActaEquiposPDF } = require('../../../../shared/acta-equipos-pdf');
    const buffer = await generarActaEquiposPDF({ accion: dev ? 'DEVOLUCION' : 'ENTREGA',
      textos: dev ? { titulo: t.acta_eq_dev_titulo, intro: t.acta_eq_dev_intro, importante: t.acta_eq_dev_importante, firma_empresa: firmante }
                  : { titulo: t.acta_eq_titulo, intro: t.acta_eq_intro, importante: t.acta_eq_importante, telefonos: t.acta_eq_telefonos, firma_empresa: firmante },
      vars, equipo: { tipo: 'LAPTOP', tipo_label: 'Laptop', marca: 'Marca', modelo: 'Modelo', serie: 'SERIE123' } });
    res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', 'inline; filename="acta-ejemplo.pdf"');
    res.send(buffer);
  } catch (e) { console.error('[equipos preview]', e.message); fail(res, 'Error interno del servidor'); }
};

// Acta firmada (escaneada) → carpeta digital del colaborador (rh_documentos, tipo ACTA EQUIPOS)
exports.subirActaFirmada = async (req, res) => {
  try {
    const idMov = Number(req.params.id); const b = req.body || {};
    const [[m]] = await pool.query('SELECT * FROM rh_equipos_mov WHERE id=?', [idMov]);
    if (!m) return fail(res, 'Movimiento no existe', 404);
    if (!m.id_usuario) return fail(res, 'El movimiento no tiene colaborador asociado', 400);
    if (!b.archivo_data) return fail(res, 'Falta el archivo', 400);
    const buffer = Buffer.from(String(b.archivo_data).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (buffer.length > 8 * 1024 * 1024) return fail(res, 'Archivo mayor a 8 MB', 400);
    const nombre = String(b.archivo_nombre || `Acta-Equipo-${m.id_equipo}-firmada.pdf`).slice(0, 255);
    const d = await almacen.colocar({ ambito: 'rrhh-documentos', clave: m.id_usuario, buffer, mime: b.mime_type || 'application/pdf', nombre });
    const [rd] = await pool.query(
      'INSERT INTO rh_documentos (id_usuario, tipo, nombre_archivo, mime_type, archivo_data, doc_storage, doc_ruta, doc_bytes, subido_por) VALUES (?,?,?,?,?,?,?,?,?)',
      [m.id_usuario, 'ACTA EQUIPOS', nombre, b.mime_type || 'application/pdf', d.blob, d.storage, d.ruta, d.bytes, nombreDe(req.usuario)]);
    await pool.query('UPDATE rh_equipos_mov SET id_documento=? WHERE id=?', [rd.insertId, idMov]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'documento', entidad_id: rd.insertId, detalle: `Acta de equipos firmada (${m.accion}) a la carpeta de ${m.nombre}` });
    ok(res, { id_documento: rd.insertId });
  } catch (e) { console.error('[equipos acta firmada]', e.message); fail(res, 'Error interno del servidor'); }
};
