'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   RECURSOS HUMANOS — Ficha del Colaborador + Carpeta Digital + Directorio.
   (Fase 1 del módulo estilo Buk)
   · Identidad (nombre, rut, cargo, fechas) vive en `usuarios` (una sola fuente);
     `rh_fichas` guarda SOLO los datos laborales/previsionales/contacto extra.
   · Documentos del colaborador en `rh_documentos` (LONGBLOB, tipos paramétricos
     en rh_config.doc_tipos).
   · Permisos: rh_aprobar = RRHH (ve/edita todo); cada colaborador ve su propia
     ficha y edita únicamente sus datos de contacto.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { tieneFunc } = require('../../../../shared/middleware/permisos');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const nombreDe = u => `${u?.nombre || ''} ${u?.apellido || ''}`.trim() || u?.email || null;
const esRRHH = id => tieneFunc(id, 'rh_aprobar').catch(() => false);

/* ── Migración ─────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('rrhh-ficha', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_fichas (
        id_usuario        INT PRIMARY KEY,
        -- contacto (editable por el propio colaborador)
        direccion         VARCHAR(300) NULL,
        comuna            VARCHAR(100) NULL,
        ciudad            VARCHAR(100) NULL,
        email_personal    VARCHAR(150) NULL,
        telefono_personal VARCHAR(30)  NULL,
        emergencia_nombre VARCHAR(150) NULL,
        emergencia_fono   VARCHAR(30)  NULL,
        estado_civil      VARCHAR(30)  NULL,
        nacionalidad      VARCHAR(60)  NULL,
        -- laboral/previsional (solo RRHH)
        tipo_contrato     VARCHAR(30)  NULL,       -- INDEFINIDO / PLAZO FIJO / HONORARIOS
        jornada           VARCHAR(60)  NULL,
        afp               VARCHAR(60)  NULL,
        salud             VARCHAR(80)  NULL,       -- FONASA o Isapre + plan
        sueldo_base       DECIMAL(12,0) NULL,
        banco_pago        VARCHAR(60)  NULL,
        tipo_cuenta_pago  VARCHAR(30)  NULL,
        num_cuenta_pago   VARCHAR(30)  NULL,
        observaciones     TEXT NULL,
        updated_by        VARCHAR(160) NULL,
        updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_documentos (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario     INT NOT NULL,
        tipo           VARCHAR(40) NOT NULL,
        nombre_archivo VARCHAR(255) NOT NULL,
        mime_type      VARCHAR(120) NULL,
        archivo_data   LONGBLOB NOT NULL,
        subido_por     VARCHAR(160) NULL,
        created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_usuario (id_usuario, created_at)
      )`);
    // Tipos de documento paramétricos (mantenedor rh_config)
    await pool.query(`INSERT IGNORE INTO rh_config (clave, valor) VALUES ('doc_tipos', 'CONTRATO,ANEXO,LIQUIDACION,CERTIFICADO,AMONESTACION,TITULO,OTRO')`);

    // ── Promover Recursos Humanos a MÓDULO propio del Home (antes vivía en Soporte) ──
    const [[mod]] = await pool.query('SELECT id_modulo, estado FROM modulos WHERE id_modulo=500002');
    if (mod) {
      await pool.query(`UPDATE modulos SET nombre='Recursos Humanos', icono='bi-people-fill', ruta='/recursos-humanos/', estado='activo' WHERE id_modulo=500002`);
    } else {
      await pool.query(`INSERT INTO modulos (id_modulo, nombre, icono, ruta, orden, estado) VALUES (500002, 'Recursos Humanos', 'bi-people-fill', '/recursos-humanos/', 95, 'activo')`).catch(() => {});
    }
    // Reubicar las funcionalidades RRHH al módulo propio y corregir el href del landing
    await pool.query(`UPDATE funcionalidades SET id_modulo=500002, href='/recursos-humanos/' WHERE codigo='rh_ver'`);
    await pool.query(`UPDATE funcionalidades SET id_modulo=500002 WHERE codigo IN ('rh_vacaciones','rh_antiguedad','rh_aprobar')`);

    // Funcionalidades nuevas
    const funcs = [
      ['Mi Ficha',        'rh_ficha',         '/recursos-humanos/mi-ficha/',      'bi-person-vcard'],
      ['Directorio',      'rh_directorio',    '/recursos-humanos/directorio/',    'bi-person-lines-fill'],
      ['Colaboradores',   'rh_colaboradores', '/recursos-humanos/colaboradores/', 'bi-people'],
    ];
    const idFunc = {};
    for (const [nombre, codigo, href, icono] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500002,?,?,?,?)', [nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    const TODOS = [1, 2, 3, 4, 5, 6, 90008, 90009];
    const seed = { rh_ficha: TODOS, rh_directorio: TODOS, rh_colaboradores: [1, 2, 90009] };
    for (const [codigo, perfiles] of Object.entries(seed)) {
      const idf = idFunc[codigo]; if (!idf) continue;
      for (const idp of perfiles) {
        await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
      }
    }
    console.log('[rrhh-ficha] módulo Recursos Humanos listo');
  } catch (e) { console.error('[rrhh-ficha migration]', e.message); }
});

/* ── Migración: familia (cónyuge + hijos) y 2° contacto de emergencia ───────── */
require('../../../../shared/migrate').enFila('rrhh-ficha-familia', async () => {
  try {
    for (const col of [
      "conyuge_nombre VARCHAR(160) NULL", "conyuge_rut VARCHAR(15) NULL",
      "conyuge_telefono VARCHAR(30) NULL", "conyuge_direccion VARCHAR(300) NULL",
      "conyuge_misma_dir TINYINT NOT NULL DEFAULT 0",
      "emergencia2_nombre VARCHAR(150) NULL", "emergencia2_fono VARCHAR(30) NULL",
    ]) await pool.query(`ALTER TABLE rh_fichas ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_hijos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario INT NOT NULL,
        nombre VARCHAR(160) NULL,
        rut VARCHAR(15) NULL,
        fecha_nacimiento DATE NULL,
        es_carga TINYINT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_usuario (id_usuario)
      )`);
    console.log('[rrhh-ficha-familia] listo');
  } catch (e) { console.error('[rrhh-ficha-familia migration]', e.message); }
});

/* ── Migración: flag no_mostrar (oculta de Colaboradores sin pisar el contrato) ── */
require('../../../../shared/migrate').enFila('rrhh-no-mostrar', async () => {
  try {
    await pool.query('ALTER TABLE rh_fichas ADD COLUMN IF NOT EXISTS no_mostrar TINYINT NOT NULL DEFAULT 0').catch(() => {});
    await pool.query("UPDATE rh_fichas SET no_mostrar=1, tipo_contrato=NULL WHERE tipo_contrato='NO MOSTRAR'");
    console.log('[rrhh-no-mostrar] listo');
  } catch (e) { console.error('[rrhh-no-mostrar migration]', e.message); }
});

/* ── Migración: datos Previred (tramo asignación familiar + cargas no-hijos) ──
   Cargas simples = hijos marcados "es carga" (rh_hijos, fuente única) + cargas_otras
   (cónyuge/ascendientes). Maternales e inválidas se declaran aparte. */
require('../../../../shared/migrate').enFila('rrhh-ficha-previred', async () => {
  try {
    for (const col of [
      "tramo_asignacion CHAR(1) NULL",
      "cargas_otras TINYINT NOT NULL DEFAULT 0",
      "cargas_maternales TINYINT NOT NULL DEFAULT 0",
      "cargas_invalidas TINYINT NOT NULL DEFAULT 0",
    ]) await pool.query(`ALTER TABLE rh_fichas ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
    console.log('[rrhh-ficha-previred] listo');
  } catch (e) { console.error('[rrhh-ficha-previred migration]', e.message); }
});

/* ── Campos de la ficha ─────────────────────────────────────────────────────── */
const CAMPOS_CONTACTO = ['direccion', 'comuna', 'ciudad', 'email_personal', 'telefono_personal',
  'emergencia_nombre', 'emergencia_fono', 'emergencia2_nombre', 'emergencia2_fono',
  'estado_civil', 'nacionalidad',
  'conyuge_nombre', 'conyuge_rut', 'conyuge_telefono', 'conyuge_direccion', 'conyuge_misma_dir'];
const CAMPOS_LABORAL = ['tipo_contrato', 'jornada', 'afp', 'salud', 'plan_isapre_uf', 'sueldo_base',
  'banco_pago', 'tipo_cuenta_pago', 'num_cuenta_pago', 'observaciones',
  'tramo_asignacion', 'cargas_otras', 'cargas_maternales', 'cargas_invalidas', 'anos_trabajados_previos'];
// Identidad en usuarios que RRHH puede actualizar desde la ficha
const CAMPOS_USUARIO = ['cargo', 'fecha_ingreso', 'fecha_nacimiento', 'sexo', 'telefono', 'centro_costo'];

async function armarFicha(idUsuario, conSueldo) {
  const [[u]] = await pool.query(
    `SELECT u.id_usuario, u.rut, u.nombre, u.apellido, u.apellido_materno, u.email, u.telefono,
            u.cargo, u.sexo, u.fecha_ingreso, u.fecha_nacimiento, u.centro_costo, u.estado,
            p.nombre AS perfil,
            TRIM(CONCAT_WS(' ', s.nombre, s.apellido)) AS supervisor
       FROM usuarios u
       LEFT JOIN perfiles p ON p.id_perfil = u.id_perfil
       LEFT JOIN usuarios s ON s.id_usuario = u.id_supervisor
      WHERE u.id_usuario = ? LIMIT 1`, [idUsuario]);
  if (!u) return null;
  const [[f]] = await pool.query('SELECT * FROM rh_fichas WHERE id_usuario = ?', [idUsuario]);
  const ficha = f || {};
  if (!conSueldo) delete ficha.sueldo_base;
  const [docs] = await pool.query(
    'SELECT id, tipo, nombre_archivo, mime_type, subido_por, created_at FROM rh_documentos WHERE id_usuario=? ORDER BY created_at DESC', [idUsuario]);
  const [hijos] = await pool.query(
    "SELECT id, nombre, rut, DATE_FORMAT(fecha_nacimiento,'%Y-%m-%d') fecha_nacimiento, es_carga FROM rh_hijos WHERE id_usuario=? ORDER BY fecha_nacimiento, id", [idUsuario]);
  return { usuario: u, ficha, documentos: docs, hijos };
}

/* GET /api/rrhh/ficha        → la mía
   GET /api/rrhh/ficha/:id    → RRHH */
const getFicha = async (req, res) => {
  try {
    const u = req.usuario || {};
    const rrhh = await esRRHH(u.id_usuario);
    let objetivo = u.id_usuario;
    if (req.params.id && String(req.params.id) !== String(u.id_usuario)) {
      if (!rrhh) return fail(res, 'Solo RRHH puede ver fichas de otros colaboradores', 403);
      objetivo = parseInt(req.params.id, 10);
    }
    // El propio colaborador SÍ ve su sueldo (como en Buk); terceros solo RRHH.
    const data = await armarFicha(objetivo, true);
    if (!data) return fail(res, 'Colaborador no encontrado', 404);
    data.es_rrhh = rrhh;
    data.doc_tipos = await docTipos();
    ok(res, data);
  } catch (e) { console.error('[rrhh getFicha]', e.message); fail(res, 'Error interno del servidor'); }
};

/* PUT /api/rrhh/ficha/:id — RRHH edita todo; el colaborador solo su contacto */
const putFicha = async (req, res) => {
  try {
    const u = req.usuario || {}; const b = req.body || {};
    const rrhh = await esRRHH(u.id_usuario);
    const objetivo = parseInt(req.params.id, 10);
    const propio = String(objetivo) === String(u.id_usuario);
    if (!rrhh && !propio) return fail(res, 'Sin permiso sobre esta ficha', 403);

    const permitidos = rrhh ? [...CAMPOS_CONTACTO, ...CAMPOS_LABORAL] : CAMPOS_CONTACTO;
    const sets = [], vals = [];
    for (const c of permitidos) if (c in b) { sets.push(`${c} = ?`); vals.push(b[c] === '' ? null : b[c]); }
    if (sets.length) {
      await pool.query(
        `INSERT INTO rh_fichas (id_usuario, ${sets.map(s => s.split(' ')[0]).join(', ')}, updated_by)
         VALUES (?${', ?'.repeat(sets.length)}, ?)
         ON DUPLICATE KEY UPDATE ${sets.join(', ')}, updated_by = ?`,
        [objetivo, ...vals, nombreDe(u), ...vals, nombreDe(u)]);
    }
    // Hijos: reemplazo completo del set (viene el arreglo entero desde la ficha)
    if (Array.isArray(b.hijos)) {
      const hijos = b.hijos
        .map(h => ({ nombre: String(h.nombre || '').trim().slice(0, 160), rut: String(h.rut || '').trim().slice(0, 15),
                     fecha_nacimiento: /^\d{4}-\d{2}-\d{2}$/.test(String(h.fecha_nacimiento || '')) ? h.fecha_nacimiento : null,
                     es_carga: h.es_carga ? 1 : 0 }))
        .filter(h => h.nombre || h.rut || h.fecha_nacimiento)
        .slice(0, 20);
      await pool.query('DELETE FROM rh_hijos WHERE id_usuario=?', [objetivo]);
      for (const h of hijos)
        await pool.query('INSERT INTO rh_hijos (id_usuario, nombre, rut, fecha_nacimiento, es_carga) VALUES (?,?,?,?,?)',
          [objetivo, h.nombre || null, h.rut || null, h.fecha_nacimiento, h.es_carga]);
    }
    // Identidad (usuarios) solo RRHH
    if (rrhh) {
      const setsU = [], valsU = [];
      for (const c of CAMPOS_USUARIO) if (c in b) { setsU.push(`${c} = ?`); valsU.push(b[c] === '' ? null : b[c]); }
      if (setsU.length) await pool.query(`UPDATE usuarios SET ${setsU.join(', ')} WHERE id_usuario = ?`, [...valsU, objetivo]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'ficha', entidad_id: objetivo,
      detalle: `${rrhh && !propio ? 'RRHH actualizó' : 'Actualizó'} ficha del colaborador #${objetivo}: ${Object.keys(b).join(', ')}` });
    ok(res, { ok: true });
  } catch (e) { console.error('[rrhh putFicha]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── Colaboradores (RRHH): lista con resumen ───────────────────────────────── */
const listarColaboradores = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario, u.rut, TRIM(CONCAT_WS(' ', u.nombre, u.apellido, u.apellido_materno)) AS nombre,
              u.email, u.telefono, u.cargo, u.fecha_ingreso, u.fecha_nacimiento, u.estado, u.centro_costo,
              p.nombre AS perfil, f.tipo_contrato, f.afp, f.salud,
              (SELECT COUNT(*) FROM rh_documentos d WHERE d.id_usuario = u.id_usuario) AS docs
         FROM usuarios u
         LEFT JOIN perfiles p ON p.id_perfil = u.id_perfil
         LEFT JOIN rh_fichas f ON f.id_usuario = u.id_usuario
        WHERE u.estado = 'activo' AND COALESCE(f.no_mostrar,0) = 0
        ORDER BY nombre LIMIT 800`);
    ok(res, rows);
  } catch (e) { console.error('[rrhh listarColaboradores]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── Directorio (todos): datos públicos, sin nada sensible ──────────────────── */
const directorio = async (req, res) => {
  try {
    // Solo los marcados visibles en el directorio (sin registro = visible por defecto)
    const [rows] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) AS nombre,
              u.cargo, u.email, u.telefono,
              DATE_FORMAT(u.fecha_nacimiento, '%d-%m') AS cumple,
              TRIM(CONCAT_WS(' ', s.nombre, s.apellido)) AS supervisor
         FROM usuarios u
         LEFT JOIN usuarios s ON s.id_usuario = u.id_supervisor
         LEFT JOIN rh_directorio_config c ON c.id_usuario = u.id_usuario
        WHERE u.estado = 'activo' AND COALESCE(c.en_directorio, 1) = 1
        ORDER BY nombre LIMIT 800`);
    ok(res, rows);
  } catch (e) { console.error('[rrhh directorio]', e.message); fail(res, 'Error interno del servidor'); }
};

/* GET /api/rrhh/organigrama — colaboradores visibles en el organigrama + su jefatura */
const organigrama = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) AS nombre,
              u.cargo, u.email, u.id_supervisor
         FROM usuarios u
         LEFT JOIN rh_directorio_config c ON c.id_usuario = u.id_usuario
        WHERE u.estado = 'activo' AND COALESCE(c.en_organigrama, 1) = 1
        ORDER BY nombre LIMIT 800`);
    ok(res, rows);
  } catch (e) { console.error('[rrhh organigrama]', e.message); fail(res, 'Error interno del servidor'); }
};

/* GET /api/rrhh/directorio/config — TODOS los activos con sus dos flags (Admin) */
const directorioConfig = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) AS nombre, u.cargo,
              COALESCE(c.en_directorio, 1)  AS en_directorio,
              COALESCE(c.en_organigrama, 1) AS en_organigrama,
              COALESCE(f.no_mostrar, 0)     AS no_mostrar
         FROM usuarios u
         LEFT JOIN rh_directorio_config c ON c.id_usuario = u.id_usuario
         LEFT JOIN rh_fichas f ON f.id_usuario = u.id_usuario
        WHERE u.estado = 'activo'
        ORDER BY nombre LIMIT 800`);
    ok(res, rows.map(r => ({ ...r, en_directorio: !!r.en_directorio, en_organigrama: !!r.en_organigrama, no_mostrar: !!r.no_mostrar })));
  } catch (e) { console.error('[rrhh directorioConfig]', e.message); fail(res, 'Error interno del servidor'); }
};

/* PUT /api/rrhh/directorio/config { items:[{id_usuario, en_directorio, en_organigrama}] } (Admin) */
const guardarDirectorioConfig = async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    let n = 0;
    for (const it of items) {
      const id = parseInt(it.id_usuario, 10); if (!id) continue;
      await pool.query(
        `INSERT INTO rh_directorio_config (id_usuario, en_directorio, en_organigrama) VALUES (?,?,?)
         ON DUPLICATE KEY UPDATE en_directorio=VALUES(en_directorio), en_organigrama=VALUES(en_organigrama)`,
        [id, it.en_directorio ? 1 : 0, it.en_organigrama ? 1 : 0]);
      if ('no_mostrar' in it)
        await pool.query(
          `INSERT INTO rh_fichas (id_usuario, no_mostrar) VALUES (?,?)
           ON DUPLICATE KEY UPDATE no_mostrar=VALUES(no_mostrar)`, [id, it.no_mostrar ? 1 : 0]);
      n++;
    }
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'directorio_config', detalle: `Actualizó visibilidad de ${n} colaborador(es) en directorio/organigrama` });
    ok(res, { ok: true, n });
  } catch (e) { console.error('[rrhh guardarDirectorioConfig]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── Carpeta digital ────────────────────────────────────────────────────────── */
async function docTipos() {
  try {
    const [[r]] = await pool.query("SELECT valor FROM rh_config WHERE clave='doc_tipos'");
    return String(r?.valor || 'CONTRATO,ANEXO,OTRO').split(',').map(s => s.trim()).filter(Boolean);
  } catch { return ['CONTRATO', 'ANEXO', 'OTRO']; }
}

/* POST /api/rrhh/docs/:idUsuario  { tipo, archivo_nombre, mime_type, archivo_data(base64) } — solo RRHH */
const subirDoc = async (req, res) => {
  try {
    const u = req.usuario || {};
    if (!(await esRRHH(u.id_usuario))) return fail(res, 'Solo RRHH sube documentos', 403);
    const objetivo = parseInt(req.params.idUsuario, 10);
    const { tipo, archivo_nombre, mime_type, archivo_data } = req.body || {};
    if (!objetivo || !tipo || !archivo_data) return fail(res, 'tipo y archivo son requeridos', 400);
    const tipos = await docTipos();
    if (!tipos.includes(String(tipo).toUpperCase())) return fail(res, 'Tipo de documento no válido', 400);
    const buffer = Buffer.from(archivo_data, 'base64');
    if (buffer.length > 15 * 1024 * 1024) return fail(res, 'Archivo supera 15 MB', 400);
    const [r] = await pool.query(
      'INSERT INTO rh_documentos (id_usuario, tipo, nombre_archivo, mime_type, archivo_data, subido_por) VALUES (?,?,?,?,?,?)',
      [objetivo, String(tipo).toUpperCase(), String(archivo_nombre || 'documento').slice(0, 255), mime_type || null, buffer, nombreDe(u)]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'documento', entidad_id: r.insertId,
      detalle: `Subió ${tipo} "${archivo_nombre}" a la carpeta del colaborador #${objetivo}` });
    ok(res, { id: r.insertId });
  } catch (e) { console.error('[rrhh subirDoc]', e.message); fail(res, 'Error interno del servidor'); }
};

/* GET /api/rrhh/docs/archivo/:docId — el dueño o RRHH */
const descargarDoc = async (req, res) => {
  try {
    const u = req.usuario || {};
    const [[d]] = await pool.query('SELECT * FROM rh_documentos WHERE id=?', [req.params.docId]);
    if (!d) return fail(res, 'Documento no encontrado', 404);
    if (String(d.id_usuario) !== String(u.id_usuario) && !(await esRRHH(u.id_usuario)))
      return fail(res, 'Sin permiso sobre este documento', 403);
    res.setHeader('Content-Type', d.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(d.nombre_archivo)}"`);
    res.send(d.archivo_data);
  } catch (e) { console.error('[rrhh descargarDoc]', e.message); fail(res, 'Error interno del servidor'); }
};

/* DELETE /api/rrhh/docs/:docId — solo RRHH */
const eliminarDoc = async (req, res) => {
  try {
    const u = req.usuario || {};
    if (!(await esRRHH(u.id_usuario))) return fail(res, 'Solo RRHH elimina documentos', 403);
    const [[d]] = await pool.query('SELECT id, id_usuario, tipo, nombre_archivo FROM rh_documentos WHERE id=?', [req.params.docId]);
    if (!d) return fail(res, 'Documento no encontrado', 404);
    await pool.query('DELETE FROM rh_documentos WHERE id=?', [d.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'rrhh', entidad: 'documento', entidad_id: d.id,
      detalle: `Eliminó ${d.tipo} "${d.nombre_archivo}" del colaborador #${d.id_usuario}` });
    ok(res, { ok: true });
  } catch (e) { console.error('[rrhh eliminarDoc]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── Visibilidad en directorio/organigrama + funcionalidad de config (solo Admin) ── */
require('../../../../shared/migrate').enFila('rrhh-directorio-config', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_directorio_config (
        id_usuario     INT PRIMARY KEY,
        en_directorio  TINYINT(1) NOT NULL DEFAULT 1,
        en_organigrama TINYINT(1) NOT NULL DEFAULT 1,
        updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    // Funcionalidad de acción (href NULL) para gatear la pestaña Configurar — solo Administrador por ahora
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_directorio_config' LIMIT 1");
    let idf = ex && ex.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500001, 'Configurar Directorio/Organigrama', 'rh_directorio_config', NULL, 'bi-sliders')");
      idf = r.insertId;
    }
    await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    console.log('[rrhh-directorio-config] listo');
  } catch (e) { console.error('[rrhh-directorio-config migration]', e.message); }
});

module.exports = { getFicha, putFicha, listarColaboradores, directorio, organigrama, directorioConfig, guardarDirectorioConfig, subirDoc, descargarDoc, eliminarDoc };
