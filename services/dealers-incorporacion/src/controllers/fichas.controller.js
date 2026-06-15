'use strict';
/**
 * Fichas de Incorporación de Concesionarios (Dealers).
 * Flujo: Ejecutivo Comercial llena la ficha → imprime → cliente firma →
 * sube PDF/foto → envía a revisión (pool de Analistas de Operaciones) →
 * aprobada (crea el dealer + avisa al ejecutivo) o rechazada (con motivo;
 * el ejecutivo corrige/apela y reenvía).
 */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
const { tieneFunc } = require('../../../../shared/middleware/permisos');

/* ── Comisiones por defecto según tipo de ficha (instructivo) ─────────────── */
const COM_DEFAULT = {
  GENERAL: { com_6_12: 2.5, com_13_24: 5.0,  com_25_36: 7.5, com_37: 10.0 },
  PARQUE:  { com_6_12: 0.0, com_13_24: 2.5,  com_25_36: 5.0, com_37: 7.5  },
};

/* ── Migración: tabla + registro de módulo/funcionalidades/permisos ───────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealer_fichas (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        tipo             VARCHAR(10)  NOT NULL DEFAULT 'GENERAL',
        estado           VARCHAR(20)  NOT NULL DEFAULT 'BORRADOR',
        id_ejecutivo     INT          NULL,
        ejecutivo_email  VARCHAR(150) NULL,
        ejecutivo_nombre VARCHAR(200) NULL,
        fecha_solicitud  DATE         NULL,
        rut              VARCHAR(20)  NULL,
        nombre_razon     VARCHAR(200) NULL,
        nombre_fantasia  VARCHAR(200) NULL,
        direccion        VARCHAR(300) NULL,
        comuna           VARCHAR(120) NULL,
        cc_nombre        VARCHAR(150) NULL,
        cc_telefono      VARCHAR(40)  NULL,
        cc_email         VARCHAR(150) NULL,
        cf_nombre        VARCHAR(150) NULL,
        cf_telefono      VARCHAR(40)  NULL,
        cf_email         VARCHAR(150) NULL,
        com_6_12         DECIMAL(5,2) NULL,
        com_13_24        DECIMAL(5,2) NULL,
        com_25_36        DECIMAL(5,2) NULL,
        com_37           DECIMAL(5,2) NULL,
        tipo_documento   VARCHAR(10)  NULL,
        cuenta_tipo      VARCHAR(10)  NULL,
        banco            VARCHAR(80)  NULL,
        rut_cuenta       VARCHAR(20)  NULL,
        num_cuenta       VARCHAR(40)  NULL,
        correo_confirmacion VARCHAR(150) NULL,
        observaciones    TEXT         NULL,
        ficha_nombre     VARCHAR(200) NULL,
        ficha_mime       VARCHAR(100) NULL,
        ficha_data       LONGBLOB     NULL,
        tomada_por       INT          NULL,
        tomada_por_nombre VARCHAR(200) NULL,
        fecha_tomada     DATETIME     NULL,
        revisor_id       INT          NULL,
        revisor_nombre   VARCHAR(200) NULL,
        fecha_revision   DATETIME     NULL,
        motivo_rechazo   TEXT         NULL,
        apelacion        TEXT         NULL,
        id_dealer        INT          NULL,
        created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_estado (estado),
        INDEX idx_ejecutivo (id_ejecutivo),
        INDEX idx_rut (rut)
      )
    `);
  } catch (e) { if (e.errno !== 1050) console.error('[dealer_fichas migration]', e.message); }

  // Columnas geográficas derivadas de la comuna (provincia/región) — incrementales.
  try {
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS provincia VARCHAR(120) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS region VARCHAR(120) NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS excepciones JSON NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS excepciones_comentarios JSON NULL`);
    await pool.query(`ALTER TABLE dealer_fichas ADD COLUMN IF NOT EXISTS diferencias JSON NULL`);
  } catch (e) { console.error('[dealer_fichas alter cols]', e.message); }

  // Archivos adjuntos múltiples (informes comerciales empresa/socios, hasta 3 c/u).
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dealer_ficha_archivos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        id_ficha    INT          NOT NULL,
        categoria   VARCHAR(20)  NOT NULL,
        nombre      VARCHAR(200) NULL,
        mime        VARCHAR(100) NULL,
        data        LONGBLOB     NULL,
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ficha (id_ficha)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[dealer_ficha_archivos migration]', e.message); }

  // Registro del módulo en el menú (idempotente).
  try {
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (370001, 'Creación/Mantenedor de Dealer', 'Fichas de incorporación de concesionarios y mantención de dealers', 'bi-building-add', '/dealers-incorporacion/', 104, 'activo')`);
    const funcs = [
      ['Creación/Mantenedor de Dealer', 'dealer_inc_ver',     '/dealers-incorporacion/', 'bi-building-add'],
      ['Crear ficha de dealer',         'dealer_ficha_crear', null,                      null],
      ['Revisar fichas de dealer',      'dealer_ficha_revisar', null,                    null],
      ['Mantener dealers',              'dealer_mantener',    null,                      null],
    ];
    const idFunc = {};
    for (const [nombre, codigo, href, icono] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (370001,?,?,?,?)`,
        [nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    // Permisos por defecto: { codigo: [perfiles] }  (1 Admin, 4 Ejecutivo Comercial, 6 Analista de Operaciones, 90008 Gerente Operaciones)
    const seed = {
      dealer_inc_ver:       [1, 4, 6, 90008],
      dealer_ficha_crear:   [1, 4],
      dealer_ficha_revisar: [1, 6, 90008],
      dealer_mantener:      [1, 6, 90008],
    };
    for (const [codigo, perfiles] of Object.entries(seed)) {
      const idf = idFunc[codigo]; if (!idf) continue;
      for (const idp of perfiles) {
        const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [idp, idf]);
        if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
      }
    }
    console.log('[dealers-incorporacion] módulo registrado');
  } catch (e) { console.error('[dealers-incorporacion migration]', e.message); }
})();

/* ── Helpers ──────────────────────────────────────────────────────────────── */
const norm = s => String(s || '').trim();
const num  = v => { const n = Number(String(v ?? '').replace(',', '.').replace(/[^\d.-]/g, '')); return isNaN(n) ? null : n; };

// Usuarios activos que pueden revisar (pool) — Administradores + quien tenga el permiso.
async function idsRevisores(excluirId) {
  const [rows] = await pool.query(
    `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
       WHERE p.nombre='Administrador' AND u.estado='activo'
     UNION
     SELECT u.id_usuario FROM usuarios u
       JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil
       JOIN funcionalidades f  ON f.id_funcionalidad=pp.id_funcionalidad
     WHERE f.codigo='dealer_ficha_revisar' AND pp.habilitado=1 AND u.estado='activo'`
  );
  return rows.map(r => r.id_usuario).filter(id => id !== excluirId);
}

// ¿El usuario puede revisar (pool de Analistas de Operaciones + Admin)?
function puedeRevisar(req) {
  if ((req.usuario || {}).perfil_nombre === 'Administrador') return true;
  return tieneFunc(req.usuario.id_usuario, 'dealer_ficha_revisar');
}

// Campos editables de la ficha (todo menos workflow/archivo).
const CAMPOS = ['tipo','ejecutivo_nombre','fecha_solicitud','rut','nombre_razon','nombre_fantasia','direccion','comuna','provincia','region',
  'cc_nombre','cc_telefono','cc_email','cf_nombre','cf_telefono','cf_email',
  'com_6_12','com_13_24','com_25_36','com_37','tipo_documento','cuenta_tipo','banco',
  'rut_cuenta','num_cuenta','correo_confirmacion','observaciones'];

const CATEGORIAS = ['EMPRESA', 'SOCIOS', 'PODER_SIMPLE', 'PODER_REP_LEGAL'];   // adjuntos
const normRut = r => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();

// Comentario de excepción válido: ≥10 caracteres y al menos un espacio (no se avisan las reglas al usuario).
const comentarioOK = c => { const s = String(c || '').trim(); return s.length >= 10 && /\s/.test(s); };

// Normaliza el payload de excepciones y valida sus comentarios.
function excepcionesDe(body) {
  const exc = Array.isArray(body.excepciones) ? body.excepciones : [];
  const com = Array.isArray(body.excepciones_comentarios) ? body.excepciones_comentarios : [];
  return { exc, com };
}

function armarValores(body) {
  const v = {};
  for (const k of CAMPOS) {
    if (!(k in body)) continue;
    if (k.startsWith('com_')) v[k] = num(body[k]);
    else if (k === 'tipo') v[k] = (norm(body[k]).toUpperCase() === 'PARQUE') ? 'PARQUE' : 'GENERAL';
    else if (k === 'fecha_solicitud') v[k] = body[k] || null;
    else v[k] = norm(body[k]) || null;
  }
  return v;
}

/* ── GET /ejecutivos — nombres elegibles para la ficha ────────────────────── */
const ejecutivos = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT(COALESCE(u.nombre,''),' ',COALESCE(u.apellido,''))) AS nombre, p.nombre AS perfil
       FROM usuarios u JOIN perfiles p ON p.id_perfil = u.id_perfil
       WHERE u.estado='activo' AND p.nombre IN ('Ejecutivo Comercial','Jefe Comercial','Analista de Operaciones')
       ORDER BY u.nombre, u.apellido`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[fichas ejecutivos]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /fichas — lista (ejecutivo ve las suyas; revisores ven todas) ─────── */
const listar = async (req, res) => {
  try {
    const rev = await puedeRevisar(req);
    const { estado, q } = req.query;
    const where = [], vals = [];
    if (!rev) { where.push('id_ejecutivo = ?'); vals.push(req.usuario.id_usuario); }
    if (estado) { where.push('estado = ?'); vals.push(estado); }
    if (q) { where.push('(rut LIKE ? OR nombre_razon LIKE ? OR nombre_fantasia LIKE ? OR ejecutivo_nombre LIKE ?)');
      const like = '%' + q + '%'; vals.push(like, like, like, like); }
    const whereStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [rows] = await pool.query(
      `SELECT id, tipo, estado, id_ejecutivo, ejecutivo_nombre, fecha_solicitud, rut, nombre_razon, nombre_fantasia,
              comuna, direccion, apelacion, tomada_por, tomada_por_nombre, revisor_nombre, fecha_revision, motivo_rechazo,
              com_6_12, com_13_24, com_25_36, com_37, tipo_documento, cuenta_tipo, banco, num_cuenta, rut_cuenta,
              cc_nombre, cc_telefono, cc_email, id_dealer, (ficha_data IS NOT NULL) AS tiene_ficha, created_at, updated_at
       FROM dealer_fichas ${whereStr} ORDER BY
         FIELD(estado,'RECHAZADA','EN_REVISION','TOMADA','BORRADOR','APROBADA'), updated_at DESC
       LIMIT 500`, vals);
    res.json({ success: true, data: { rows, puede_revisar: rev }, error: null });
  } catch (e) { console.error('[fichas listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /fichas/:id ──────────────────────────────────────────────────────── */
const obtener = async (req, res) => {
  try {
    const [[f]] = await pool.query(
      `SELECT id, tipo, estado, id_ejecutivo, ejecutivo_email, ejecutivo_nombre, fecha_solicitud,
              rut, nombre_razon, nombre_fantasia, direccion, comuna, provincia, region,
              cc_nombre, cc_telefono, cc_email, cf_nombre, cf_telefono, cf_email,
              com_6_12, com_13_24, com_25_36, com_37, tipo_documento, cuenta_tipo, banco,
              rut_cuenta, num_cuenta, correo_confirmacion, observaciones,
              excepciones, excepciones_comentarios, diferencias,
              ficha_nombre, ficha_mime, (ficha_data IS NOT NULL) AS tiene_ficha,
              tomada_por, tomada_por_nombre, fecha_tomada, revisor_nombre, fecha_revision,
              motivo_rechazo, apelacion, id_dealer, created_at, updated_at
       FROM dealer_fichas WHERE id = ?`, [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (!(await puedeRevisar(req)) && f.id_ejecutivo !== req.usuario.id_usuario)
      return res.status(403).json({ success: false, data: null, error: 'Sin acceso a esta ficha' });
    res.json({ success: true, data: f, error: null });
  } catch (e) { console.error('[fichas obtener]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /fichas — crear borrador ────────────────────────────────────────── */
const crear = async (req, res) => {
  try {
    const v = armarValores(req.body);
    if (!v.tipo) v.tipo = 'GENERAL';
    // Comisiones por defecto si no vienen
    const def = COM_DEFAULT[v.tipo] || COM_DEFAULT.GENERAL;
    for (const k of ['com_6_12','com_13_24','com_25_36','com_37'])
      if (v[k] == null) v[k] = def[k];
    const u = req.usuario;
    // ejecutivo_nombre es editable (otro Ejecutivo/Jefe Comercial/Analista); default = creador.
    if (!v.ejecutivo_nombre) v.ejecutivo_nombre = [u.nombre, u.apellido].filter(Boolean).join(' ') || null;
    // Excepciones (comisión modificada, boleta…) — cada una requiere comentario válido.
    const { exc, com } = excepcionesDe(req.body);
    if (exc.length && !com.every(c => comentarioOK(c.comentario)))
      return res.status(400).json({ success: false, data: null, error: 'Cada excepción requiere un comentario válido' });
    const cols = ['id_ejecutivo','ejecutivo_email', ...Object.keys(v), 'excepciones','excepciones_comentarios'];
    const ph   = cols.map(() => '?').join(',');
    const vals = [u.id_usuario, u.email || null, ...Object.values(v),
      JSON.stringify(exc), JSON.stringify(com)];
    const [r] = await pool.query(`INSERT INTO dealer_fichas (${cols.join(',')}) VALUES (${ph})`, vals);
    auditar({ req, accion: 'CREAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: r.insertId,
      detalle: `Creó ficha de incorporación (${v.tipo}) ${v.nombre_razon || v.rut || ''}`.trim()
        + (exc.length ? ` · ${exc.length} excepción(es)` : ''), rut: v.rut, meta: exc.length ? { excepciones: exc } : null });
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { console.error('[fichas crear]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── PUT /fichas/:id — editar (solo dueño, en BORRADOR/RECHAZADA) ──────────── */
const editar = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT id_ejecutivo, estado FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.id_ejecutivo !== req.usuario.id_usuario && req.usuario.perfil_nombre !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Solo el ejecutivo que la creó puede editarla' });
    if (!['BORRADOR', 'RECHAZADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'La ficha está en revisión o aprobada; no se puede editar' });
    const v = armarValores(req.body);
    const setCols = Object.keys(v).map(k => `${k}=?`);
    const setVals = Object.values(v);
    // Excepciones (si vienen en el payload): validar comentarios y persistir.
    if ('excepciones' in req.body) {
      const { exc, com } = excepcionesDe(req.body);
      if (exc.length && !com.every(c => comentarioOK(c.comentario)))
        return res.status(400).json({ success: false, data: null, error: 'Cada excepción requiere un comentario válido' });
      setCols.push('excepciones=?', 'excepciones_comentarios=?');
      setVals.push(JSON.stringify(exc), JSON.stringify(com));
    }
    if (!setCols.length) return res.status(400).json({ success: false, data: null, error: 'Sin cambios' });
    await pool.query(`UPDATE dealer_fichas SET ${setCols.join(',')} WHERE id=?`, [...setVals, req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: req.params.id,
      detalle: `Editó ficha de dealer #${req.params.id}`, meta: { campos: Object.keys(v) } });
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) { console.error('[fichas editar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /fichas/:id/archivo — subir ficha firmada (base64) ───────────────── */
const subirFicha = async (req, res) => {
  try {
    const { archivo_nombre, mime_type, archivo_data } = req.body || {};
    if (!archivo_data) return res.status(400).json({ success: false, data: null, error: 'Falta el archivo' });
    const [[f]] = await pool.query('SELECT id_ejecutivo, estado FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.id_ejecutivo !== req.usuario.id_usuario && req.usuario.perfil_nombre !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Sin permiso' });
    if (!['BORRADOR', 'RECHAZADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'No se puede cambiar el archivo en este estado' });
    const buffer = Buffer.from(archivo_data, 'base64');
    await pool.query('UPDATE dealer_fichas SET ficha_nombre=?, ficha_mime=?, ficha_data=? WHERE id=?',
      [archivo_nombre || 'ficha.pdf', mime_type || 'application/octet-stream', buffer, req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: req.params.id,
      detalle: `Subió ficha firmada de dealer #${req.params.id} (${archivo_nombre || ''})` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[fichas subir]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /fichas/:id/archivo — ver/descargar ficha firmada ─────────────────── */
const verFicha = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT id_ejecutivo, ficha_nombre, ficha_mime, ficha_data FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f || !f.ficha_data) return res.status(404).json({ success: false, data: null, error: 'Sin archivo' });
    if (!(await puedeRevisar(req)) && f.id_ejecutivo !== req.usuario.id_usuario)
      return res.status(403).json({ success: false, data: null, error: 'Sin acceso' });
    auditar({ req, accion: 'VER_DOCUMENTO', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: req.params.id,
      detalle: `Visualizó ficha firmada de dealer #${req.params.id}` });
    res.set('Content-Type', f.ficha_mime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${(f.ficha_nombre || 'ficha').replace(/"/g, '')}"`);
    res.send(f.ficha_data);
  } catch (e) { console.error('[fichas verFicha]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* Compara la ficha contra el dealer ya existente en el sistema (match por RUT). */
async function calcularDiferencias(f) {
  const dif = [];
  try {
    const [rows] = await pool.query('SELECT * FROM dealers WHERE rut IS NOT NULL', []);
    const dl = rows.find(d => normRut(d.rut) === normRut(f.rut));
    if (!dl) return dif;
    const cmp = (campo, fv, sv) => {
      const a = (fv == null ? '' : String(fv)).trim(), b = (sv == null ? '' : String(sv)).trim();
      if (a && a.toUpperCase() !== b.toUpperCase()) dif.push({ campo, ficha: a, sistema: b || '—' });
    };
    cmp('Razón Social', f.nombre_razon, dl.nombre_razon);
    cmp('Nombre Fantasía', f.nombre_fantasia, dl.nombre_indexa);
    cmp('Dirección', f.direccion, dl.direccion);
    cmp('Banco', f.banco, dl.banco);
    cmp('N° Cuenta', f.num_cuenta, dl.num_cuenta);
    cmp('RUT Cuenta', f.rut_cuenta, dl.rut_pago);
    const fDoc = f.tipo_documento === 'FACTURA' ? 'FACTURA' : 'BOLETA';
    const sDoc = dl.tiene_factura ? 'FACTURA' : 'BOLETA';
    if (fDoc !== sDoc) dif.push({ campo: 'Documento tributario', ficha: fDoc, sistema: sDoc });
  } catch (e) { console.error('[calcularDiferencias]', e.message); }
  return dif;
}

/* ── POST /fichas/:id/enviar — manda a revisión (pool) ─────────────────────── */
const enviar = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT * FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.id_ejecutivo !== req.usuario.id_usuario && req.usuario.perfil_nombre !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Solo el ejecutivo que la creó puede enviarla' });
    if (!['BORRADOR', 'RECHAZADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'La ficha ya está en revisión o aprobada' });
    if (!f.ficha_data) return res.status(400).json({ success: false, data: null, error: 'Debes subir la ficha firmada (PDF o foto) antes de enviar' });
    if (!f.rut || !f.nombre_razon) return res.status(400).json({ success: false, data: null, error: 'Faltan datos obligatorios (RUT y Razón Social)' });
    // Informes comerciales obligatorios: al menos 1 de Empresa y 1 de Socios.
    const [cats] = await pool.query('SELECT categoria, COUNT(*) n FROM dealer_ficha_archivos WHERE id_ficha=? GROUP BY categoria', [req.params.id]);
    const porCat = Object.fromEntries(cats.map(c => [c.categoria, c.n]));
    if (!porCat.EMPRESA) return res.status(400).json({ success: false, data: null, error: 'Debes cargar al menos un Informe Comercial Empresa antes de enviar' });
    if (!porCat.SOCIOS)  return res.status(400).json({ success: false, data: null, error: 'Debes cargar al menos un Informe Comercial Socios antes de enviar' });
    // Depósito a tercero (RUT de la cuenta distinto al del concesionario): exige Poder Simple + Poderes del Rep. Legal.
    if (f.rut_cuenta && normRut(f.rut_cuenta) !== normRut(f.rut)) {
      if (!porCat.PODER_SIMPLE)    return res.status(400).json({ success: false, data: null, error: 'La cuenta es de un tercero: debes cargar el Poder Simple firmado antes de enviar' });
      if (!porCat.PODER_REP_LEGAL) return res.status(400).json({ success: false, data: null, error: 'La cuenta es de un tercero: debes cargar los Poderes del Representante Legal antes de enviar' });
    }

    // Compara la ficha con los datos del dealer ya cargado en el sistema (por RUT) → diferencias para el revisor.
    const diferencias = await calcularDiferencias(f);

    const reenvio = f.estado === 'RECHAZADA';
    const apelacion = norm(req.body.apelacion) || null;
    await pool.query(
      `UPDATE dealer_fichas SET estado='EN_REVISION', tomada_por=NULL, tomada_por_nombre=NULL, fecha_tomada=NULL,
         motivo_rechazo=NULL, apelacion=?, diferencias=?, fecha_revision=NULL, revisor_id=NULL, revisor_nombre=NULL WHERE id=?`,
      [apelacion, JSON.stringify(diferencias), req.params.id]);

    // Pool: avisa a todos los revisores con una clave compartida (para anular luego al resto)
    const ids = await idsRevisores(req.usuario.id_usuario);
    await notificar(ids, {
      tipo: 'DEALER_FICHA',
      titulo: reenvio ? '🔁 Ficha de dealer corregida' : '🛎️ Nueva ficha de dealer para revisión',
      mensaje: `${f.ejecutivo_nombre || 'Un ejecutivo'} envió la ficha de ${f.nombre_razon || f.rut || ''}`
        + (apelacion ? ` · Apelación: ${apelacion}` : '')
        + (diferencias.length ? ` · ⚠ ${diferencias.length} diferencia(s) con los datos del sistema` : ''),
      href: '/dealers-incorporacion/mantencion.html?tab=revision',
      prioridad: 'alta', sonar: 1, son_tipo: diferencias.length ? 'alarma' : 'dingdong',
      clave: `dealerficha:${f.id}:rev`,
    });
    auditar({ req, accion: reenvio ? 'EDITAR' : 'CREAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: f.id,
      detalle: `${reenvio ? 'Reenvió' : 'Envió'} a revisión la ficha de ${f.nombre_razon || f.rut || ''}`
        + (apelacion ? ` · Apelación: "${apelacion}"` : ''), rut: f.rut });
    res.json({ success: true, data: { estado: 'EN_REVISION' }, error: null });
  } catch (e) { console.error('[fichas enviar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /fichas/:id/tomar — un revisor la reclama (anula aviso al resto) ──── */
const tomar = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT id, estado, tomada_por FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.estado === 'TOMADA' && f.tomada_por && f.tomada_por !== req.usuario.id_usuario)
      return res.status(409).json({ success: false, data: null, error: 'Otro analista ya está revisando esta ficha' });
    if (!['EN_REVISION', 'TOMADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'La ficha no está en revisión' });
    const nombre = [req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') || req.usuario.email;
    await pool.query('UPDATE dealer_fichas SET estado=\'TOMADA\', tomada_por=?, tomada_por_nombre=?, fecha_tomada=NOW() WHERE id=?',
      [req.usuario.id_usuario, nombre, req.params.id]);
    // Anula el aviso del pool para los demás (el que la toma primero lo elimina al resto)
    await pool.query('DELETE FROM notificaciones WHERE clave=? AND id_usuario<>? AND leida=0',
      [`dealerficha:${f.id}:rev`, req.usuario.id_usuario]).catch(() => {});
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: f.id,
      detalle: `Tomó para revisión la ficha de dealer #${f.id}` });
    res.json({ success: true, data: { estado: 'TOMADA', tomada_por: req.usuario.id_usuario }, error: null });
  } catch (e) { console.error('[fichas tomar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /fichas/:id/aprobar — crea el dealer y avisa al ejecutivo ────────── */
const aprobar = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT * FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (!['EN_REVISION', 'TOMADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'La ficha no está en revisión' });

    // Crea el dealer en el mantenedor (número correlativo)
    const [[{ maxN }]] = await pool.query('SELECT COALESCE(MAX(numero),0)+1 AS maxN FROM dealers');
    const [d] = await pool.query(
      `INSERT INTO dealers (numero, rut, nombre_indexa, nombre_razon, ccs_parque, direccion,
         fecha_incorporacion, contacto, telefono, correo, num_cuenta, banco, rut_pago,
         activo, tiene_factura, observaciones)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      [maxN, f.rut, f.nombre_fantasia || f.nombre_razon, f.nombre_razon, f.tipo, f.direccion,
       f.fecha_solicitud, f.cc_nombre, f.cc_telefono, f.cc_email, f.num_cuenta, f.banco, f.rut_cuenta,
       f.tipo_documento === 'FACTURA' ? 1 : 0, f.observaciones]);

    const nombre = [req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') || req.usuario.email;
    await pool.query(
      `UPDATE dealer_fichas SET estado='APROBADA', revisor_id=?, revisor_nombre=?, fecha_revision=NOW(),
         motivo_rechazo=NULL, id_dealer=? WHERE id=?`,
      [req.usuario.id_usuario, nombre, d.insertId, req.params.id]);
    // Limpia cualquier aviso de pool pendiente
    await pool.query('DELETE FROM notificaciones WHERE clave=? AND leida=0', [`dealerficha:${f.id}:rev`]).catch(() => {});

    if (f.id_ejecutivo) await notificar([f.id_ejecutivo], {
      tipo: 'DEALER_FICHA_APROBADA',
      titulo: '✅ Dealer creado',
      mensaje: `Tu ficha de ${f.nombre_razon || f.rut || ''} fue aprobada — el dealer N°${maxN} ya está en el sistema.`,
      href: '/dealers-incorporacion/mantencion.html', prioridad: 'alta', sonar: 1, son_tipo: 'dingdong',
    });
    auditar({ req, accion: 'APROBAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: f.id,
      detalle: `Aprobó la ficha de ${f.nombre_razon || f.rut || ''} → dealer N°${maxN}`, rut: f.rut, meta: { id_dealer: d.insertId, numero: maxN } });
    res.json({ success: true, data: { estado: 'APROBADA', id_dealer: d.insertId, numero: maxN }, error: null });
  } catch (e) { console.error('[fichas aprobar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── POST /fichas/:id/rechazar — exige motivo y avisa al ejecutivo ─────────── */
const rechazar = async (req, res) => {
  try {
    const motivo = norm(req.body.motivo);
    if (motivo.length < 5) return res.status(400).json({ success: false, data: null, error: 'Debes indicar un motivo de rechazo válido' });
    const [[f]] = await pool.query('SELECT * FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (!['EN_REVISION', 'TOMADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'La ficha no está en revisión' });
    const nombre = [req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') || req.usuario.email;
    await pool.query(
      `UPDATE dealer_fichas SET estado='RECHAZADA', revisor_id=?, revisor_nombre=?, fecha_revision=NOW(), motivo_rechazo=? WHERE id=?`,
      [req.usuario.id_usuario, nombre, motivo, req.params.id]);
    await pool.query('DELETE FROM notificaciones WHERE clave=? AND leida=0', [`dealerficha:${f.id}:rev`]).catch(() => {});

    if (f.id_ejecutivo) await notificar([f.id_ejecutivo], {
      tipo: 'DEALER_FICHA_RECHAZADA',
      titulo: '❌ Ficha de dealer rechazada',
      mensaje: `Tu ficha de ${f.nombre_razon || f.rut || ''} fue rechazada: ${motivo}. Corrígela y reenvíala.`,
      href: '/dealers-incorporacion/mantencion.html', prioridad: 'alta', sonar: 1, son_tipo: 'alarma',
    });
    auditar({ req, accion: 'RECHAZAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: f.id,
      detalle: `Rechazó la ficha de ${f.nombre_razon || f.rut || ''}: "${motivo}"`, rut: f.rut });
    res.json({ success: true, data: { estado: 'RECHAZADA' }, error: null });
  } catch (e) { console.error('[fichas rechazar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Archivos adjuntos (informes comerciales empresa/socios, máx 3 c/u) ───── */
async function fichaDe(id) { const [[f]] = await pool.query('SELECT id, id_ejecutivo, estado FROM dealer_fichas WHERE id=?', [id]); return f; }

const listarArchivos = async (req, res) => {
  try {
    const f = await fichaDe(req.params.id);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (!(await puedeRevisar(req)) && f.id_ejecutivo !== req.usuario.id_usuario)
      return res.status(403).json({ success: false, data: null, error: 'Sin acceso' });
    const [rows] = await pool.query('SELECT id, categoria, nombre, mime, created_at FROM dealer_ficha_archivos WHERE id_ficha=? ORDER BY id', [req.params.id]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[fichas archivos listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const subirArchivo = async (req, res) => {
  try {
    const { categoria, archivo_nombre, mime_type, archivo_data } = req.body || {};
    const cat = String(categoria || '').toUpperCase();
    if (!CATEGORIAS.includes(cat)) return res.status(400).json({ success: false, data: null, error: 'Categoría inválida' });
    if (!archivo_data) return res.status(400).json({ success: false, data: null, error: 'Falta el archivo' });
    const f = await fichaDe(req.params.id);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.id_ejecutivo !== req.usuario.id_usuario && req.usuario.perfil_nombre !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Sin permiso' });
    if (!['BORRADOR', 'RECHAZADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'No se pueden cambiar archivos en este estado' });
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM dealer_ficha_archivos WHERE id_ficha=? AND categoria=?', [req.params.id, cat]);
    if (n >= 3) return res.status(400).json({ success: false, data: null, error: 'Máximo 3 archivos por categoría' });
    const buffer = Buffer.from(archivo_data, 'base64');
    const [r] = await pool.query('INSERT INTO dealer_ficha_archivos (id_ficha, categoria, nombre, mime, data) VALUES (?,?,?,?,?)',
      [req.params.id, cat, archivo_nombre || 'archivo', mime_type || 'application/octet-stream', buffer]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: req.params.id,
      detalle: `Subió informe comercial (${cat}) a ficha #${req.params.id}: ${archivo_nombre || ''}` });
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { console.error('[fichas archivos subir]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const verArchivo = async (req, res) => {
  try {
    const [[a]] = await pool.query(
      `SELECT a.nombre, a.mime, a.data, f.id_ejecutivo FROM dealer_ficha_archivos a
         JOIN dealer_fichas f ON f.id=a.id_ficha WHERE a.id=? AND a.id_ficha=?`, [req.params.archivoId, req.params.id]);
    if (!a || !a.data) return res.status(404).json({ success: false, data: null, error: 'Sin archivo' });
    if (!(await puedeRevisar(req)) && a.id_ejecutivo !== req.usuario.id_usuario)
      return res.status(403).json({ success: false, data: null, error: 'Sin acceso' });
    auditar({ req, accion: 'VER_DOCUMENTO', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: req.params.id,
      detalle: `Visualizó informe comercial de ficha #${req.params.id}` });
    res.set('Content-Type', a.mime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${(a.nombre || 'archivo').replace(/"/g, '')}"`);
    res.send(a.data);
  } catch (e) { console.error('[fichas archivos ver]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const eliminarArchivo = async (req, res) => {
  try {
    const f = await fichaDe(req.params.id);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    if (f.id_ejecutivo !== req.usuario.id_usuario && req.usuario.perfil_nombre !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Sin permiso' });
    if (!['BORRADOR', 'RECHAZADA'].includes(f.estado))
      return res.status(400).json({ success: false, data: null, error: 'No se pueden cambiar archivos en este estado' });
    await pool.query('DELETE FROM dealer_ficha_archivos WHERE id=? AND id_ficha=?', [req.params.archivoId, req.params.id]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[fichas archivos eliminar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── DELETE /fichas/:id — eliminar borrador propio ────────────────────────── */
const eliminar = async (req, res) => {
  try {
    const [[f]] = await pool.query('SELECT id_ejecutivo, estado, nombre_razon FROM dealer_fichas WHERE id=?', [req.params.id]);
    if (!f) return res.status(404).json({ success: false, data: null, error: 'Ficha no encontrada' });
    const esAdmin = req.usuario.perfil_nombre === 'Administrador';
    if (f.id_ejecutivo !== req.usuario.id_usuario && !esAdmin)
      return res.status(403).json({ success: false, data: null, error: 'Sin permiso' });
    if (!['BORRADOR', 'RECHAZADA'].includes(f.estado) && !esAdmin)
      return res.status(400).json({ success: false, data: null, error: 'Solo se pueden eliminar borradores o rechazadas' });
    await pool.query('DELETE FROM dealer_fichas WHERE id=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'dealers', entidad: 'dealer_ficha', entidad_id: req.params.id,
      detalle: `Eliminó la ficha de dealer #${req.params.id} (${f.nombre_razon || ''})` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[fichas eliminar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { ejecutivos, listar, obtener, crear, editar, subirFicha, verFicha, enviar, tomar, aprobar, rechazar, eliminar,
  listarArchivos, subirArchivo, verArchivo, eliminarArchivo };
