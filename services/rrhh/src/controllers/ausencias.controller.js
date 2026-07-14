'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   RECURSOS HUMANOS — Fase 2: Ausencias y Permisos + Saldo de Vacaciones.
   · rh_ausencias: licencias médicas, permisos (con/sin goce), día administrativo,
     trámite, etc. Tipos paramétricos en rh_config.ausencia_tipos.
   · Aprobación: la JEFATURA directa (usuarios.id_supervisor) o RRHH (rh_aprobar).
   · Licencia médica permite adjunto (foto/PDF de la licencia).
   · Saldo de vacaciones: devengo proporcional (vac_dias_anuales/12 por mes
     trabajado, default 15 días hábiles/año) − días hábiles L-V aprobados.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const norm = s => String(s || '').trim();
const nombreDe = u => `${u?.nombre || ''} ${u?.apellido || ''}`.trim() || u?.email || null;
const esRRHH = id => tieneFunc(id, 'rh_aprobar').catch(() => false);
// mysql2 devuelve DATE como objeto Date → normalizar a 'YYYY-MM-DD'
const isoF = f => f instanceof Date
  ? `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`
  : String(f || '').slice(0, 10);

/* ── Migración ─────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('rrhh-ausencias', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_ausencias (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario      INT NOT NULL,
        nombre          VARCHAR(200) NULL,
        tipo            VARCHAR(40) NOT NULL,
        fecha_desde     DATE NOT NULL,
        fecha_hasta     DATE NOT NULL,
        medio_dia       TINYINT(1) NOT NULL DEFAULT 0,
        dias_habiles    DECIMAL(5,1) NOT NULL DEFAULT 0,
        comentario      VARCHAR(500) NULL,
        adjunto_nombre  VARCHAR(255) NULL,
        adjunto_mime    VARCHAR(120) NULL,
        adjunto_data    LONGBLOB NULL,
        estado          VARCHAR(12) NOT NULL DEFAULT 'PENDIENTE',
        resuelto_por    INT NULL,
        resuelto_nombre VARCHAR(200) NULL,
        motivo_rechazo  VARCHAR(300) NULL,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_usuario (id_usuario), INDEX idx_estado (estado), INDEX idx_fechas (fecha_desde, fecha_hasta)
      )`);
    await pool.query(`INSERT IGNORE INTO rh_config (clave, valor) VALUES
      ('ausencia_tipos', 'LICENCIA MEDICA,PERMISO CON GOCE,PERMISO SIN GOCE,DIA ADMINISTRATIVO,TRAMITE,NACIMIENTO/MATRIMONIO/DUELO,OTRO'),
      ('vac_dias_anuales', '15')`);
    // Funcionalidad + permisos (todos los perfiles)
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='rh_ausencias' LIMIT 1");
    let idf = ex && ex.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (500002, 'Ausencias y Permisos', 'rh_ausencias', '/recursos-humanos/ausencias/', 'bi-calendar-x')");
      idf = r.insertId;
    }
    for (const idp of [1, 2, 3, 4, 5, 6, 90008, 90009]) {
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
    }
    console.log('[rrhh-ausencias] listo');
  } catch (e) { console.error('[rrhh-ausencias migration]', e.message); }
});

/* ── Helpers ────────────────────────────────────────────────────────────────── */
// Días hábiles L-V entre dos fechas (feriado legal chileno: sábado NO es hábil)
function diasHabilesLV(desde, hasta) {
  const a = new Date(desde + 'T12:00:00'), b = new Date(hasta + 'T12:00:00');
  let n = 0;
  for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}
async function tiposAusencia() {
  try {
    const [[r]] = await pool.query("SELECT valor FROM rh_config WHERE clave='ausencia_tipos'");
    return String(r?.valor || 'PERMISO CON GOCE,OTRO').split(',').map(s => s.trim()).filter(Boolean);
  } catch { return ['PERMISO CON GOCE', 'OTRO']; }
}
// ¿es jefatura directa del solicitante?
async function esJefeDe(idJefe, idColab) {
  const [[r]] = await pool.query('SELECT 1 ok FROM usuarios WHERE id_usuario=? AND id_supervisor=?', [idColab, idJefe]);
  return !!r;
}
async function poolAprobadores(idSolicitante) {
  const ids = new Set();
  const [[sup]] = await pool.query('SELECT id_supervisor FROM usuarios WHERE id_usuario=?', [idSolicitante]);
  if (sup?.id_supervisor) ids.add(sup.id_supervisor);
  const [rrhh] = await pool.query(
    `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil WHERE p.nombre='Administrador' AND u.estado='activo'
     UNION
     SELECT u.id_usuario FROM usuarios u JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil
       JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
      WHERE f.codigo='rh_aprobar' AND pp.habilitado=1 AND u.estado='activo'`);
  rrhh.forEach(r => ids.add(r.id_usuario));
  ids.delete(idSolicitante);
  return [...ids];
}

/* ── POST /api/rrhh/ausencias ───────────────────────────────────────────────── */
const crear = async (req, res) => {
  try {
    const u = req.usuario || {}; const b = req.body || {};
    const tipo = norm(b.tipo).toUpperCase();
    const fd = norm(b.fecha_desde), fh = norm(b.fecha_hasta);
    if (!tipo || !fd || !fh) return fail(res, 'Tipo y fechas son requeridos', 400);
    if (fh < fd) return fail(res, 'La fecha hasta no puede ser anterior a desde', 400);
    const tipos = await tiposAusencia();
    if (!tipos.includes(tipo)) return fail(res, 'Tipo de ausencia no válido', 400);
    const esLicencia = tipo === 'LICENCIA MEDICA';
    let adjNombre = null, adjMime = null, adjData = null;
    if (b.adjunto_data) {
      adjData = Buffer.from(b.adjunto_data, 'base64');
      if (adjData.length > 10 * 1024 * 1024) return fail(res, 'Adjunto supera 10 MB', 400);
      adjNombre = String(b.adjunto_nombre || 'adjunto').slice(0, 255);
      adjMime = b.adjunto_mime || null;
    }

    if (esLicencia) {
      // LICENCIA MÉDICA: no es una solicitud — la INGRESA solo RRHH (o Admin) a
      // nombre del colaborador, sin medio día, queda APROBADA de inmediato y se
      // informa por correo al supervisor directo.
      const rrhh = (u.perfil === 'Administrador') || await esRRHH(u.id_usuario);
      if (!rrhh) return fail(res, 'Las licencias médicas las ingresa Recursos Humanos. Haz llegar tu licencia a RRHH.', 403);
      const idColab = Number(b.id_colaborador);
      if (!idColab) return fail(res, 'Indica el colaborador de la licencia', 400);
      const [[colab]] = await pool.query(
        `SELECT u.id_usuario, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) nombre, u.id_supervisor FROM usuarios u WHERE u.id_usuario=?`, [idColab]);
      if (!colab) return fail(res, 'Colaborador no encontrado', 404);
      const dias = diasHabilesLV(fd, fh);
      const [r] = await pool.query(
        `INSERT INTO rh_ausencias (id_usuario, nombre, tipo, fecha_desde, fecha_hasta, medio_dia, dias_habiles, comentario, adjunto_nombre, adjunto_mime, adjunto_data, estado, resuelto_por, resuelto_nombre)
         VALUES (?,?,?,?,?,0,?,?,?,?,?,'APROBADA',?,?)`,
        [colab.id_usuario, colab.nombre, tipo, fd, fh, dias, norm(b.comentario) || null, adjNombre, adjMime, adjData, u.id_usuario, nombreDe(u)]);
      // Correo informativo al supervisor directo (+ notificación campana)
      const fmtF = f => new Date(f + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' });
      const msg = `Se ha ingresado licencia médica a nombre de ${colab.nombre} entre los días ${fmtF(fd)} y ${fmtF(fh)}, ambas fechas inclusive.`;
      if (colab.id_supervisor) {
        notificar([colab.id_supervisor], { tipo: 'RH_AUSENCIA', titulo: '🏥 Licencia médica ingresada', mensaje: msg, href: '/recursos-humanos/ausencias/' });
        try {
          const [[sup]] = await pool.query('SELECT email, nombre FROM usuarios WHERE id_usuario=?', [colab.id_supervisor]);
          if (sup?.email) {
            const { enviarCorreo, envolverHTML } = require('../../../../shared/mailer');
            const html = `<p>Hola ${sup.nombre || ''},</p><p>${msg}</p><p style="font-size:12px;color:#64748b">Ingresada por ${nombreDe(u)} (Recursos Humanos). Detalle en <a href="https://app.autofacilchile.cl/recursos-humanos/ausencias/">Ausencias y Permisos</a>.</p>`;
            await enviarCorreo({ to: sup.email, subject: `🏥 Licencia médica — ${colab.nombre}`, html: envolverHTML ? envolverHTML(html) : html });
          }
        } catch (e) { console.error('[licencia correo supervisor]', e.message); }
      }
      auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'licencia_medica', entidad_id: r.insertId, detalle: `Licencia de ${colab.nombre} ${fd}→${fh} (${dias}d hábiles), supervisor informado` });
      return ok(res, { id: r.insertId, dias, licencia: true });
    }

    const medioDia = b.medio_dia ? 1 : 0;
    const dias = medioDia ? 0.5 : diasHabilesLV(fd, fh);
    const [r] = await pool.query(
      `INSERT INTO rh_ausencias (id_usuario, nombre, tipo, fecha_desde, fecha_hasta, medio_dia, dias_habiles, comentario, adjunto_nombre, adjunto_mime, adjunto_data)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [u.id_usuario, nombreDe(u), tipo, fd, fh, medioDia, dias, norm(b.comentario) || null, adjNombre, adjMime, adjData]);
    const ids = await poolAprobadores(u.id_usuario);
    if (ids.length) notificar(ids, { tipo: 'RH_AUSENCIA', titulo: '📋 Solicitud de ausencia',
      mensaje: `${nombreDe(u)} solicitó ${tipo} (${fd} al ${fh}, ${dias} día/s hábil/es)`, href: '/recursos-humanos/ausencias/?id=' + r.insertId });
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'ausencia', entidad_id: r.insertId, detalle: `Solicitó ${tipo} ${fd}→${fh} (${dias}d hábiles)` });
    ok(res, { id: r.insertId, dias });
  } catch (e) { console.error('[rrhh ausencias crear]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── GET /api/rrhh/ausencias?vista=mias|bandeja|historicas ──────────────────── */
const listar = async (req, res) => {
  try {
    const u = req.usuario || {};
    const rrhh = await esRRHH(u.id_usuario);
    // ¿tiene reportes directos? (jefatura)
    const [[rep]] = await pool.query("SELECT COUNT(*) c FROM usuarios WHERE id_supervisor=? AND estado='activo'", [u.id_usuario]);
    const esJefe = (rep?.c || 0) > 0;
    let vista = req.query.vista || 'mias';
    if ((vista === 'bandeja' || vista === 'historicas') && !rrhh && !esJefe) vista = 'mias';

    const params = []; let where = '';
    if (vista === 'mias') { where = 'WHERE a.id_usuario=?'; params.push(u.id_usuario); }
    else {
      const estadoW = vista === 'bandeja' ? "a.estado='PENDIENTE'" : "a.estado<>'PENDIENTE'";
      if (rrhh) where = `WHERE ${estadoW}`;
      else { where = `WHERE ${estadoW} AND us.id_supervisor=?`; params.push(u.id_usuario); }
    }
    const [rows] = await pool.query(
      `SELECT a.id, a.id_usuario, a.nombre, a.tipo, a.fecha_desde, a.fecha_hasta, a.medio_dia, a.dias_habiles,
              a.comentario, a.estado, a.resuelto_nombre, a.motivo_rechazo, a.created_at,
              a.adjunto_nombre IS NOT NULL AS tiene_adjunto
         FROM rh_ausencias a JOIN usuarios us ON us.id_usuario = a.id_usuario
        ${where} ORDER BY FIELD(a.estado,'PENDIENTE','APROBADA','RECHAZADA'), a.created_at DESC LIMIT 300`, params);
    ok(res, { solicitudes: rows, es_rrhh: rrhh, es_jefe: esJefe, tipos: await tiposAusencia() });
  } catch (e) { console.error('[rrhh ausencias listar]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── POST /api/rrhh/ausencias/:id/resolver — jefatura directa o RRHH ────────── */
const resolver = async (req, res) => {
  try {
    const u = req.usuario || {};
    const estado = String((req.body || {}).estado || '').toUpperCase();
    if (!['APROBADA', 'RECHAZADA'].includes(estado)) return fail(res, 'Estado inválido', 400);
    const [[s]] = await pool.query('SELECT * FROM rh_ausencias WHERE id=?', [req.params.id]);
    if (!s) return fail(res, 'Solicitud no encontrada', 404);
    if (s.estado !== 'PENDIENTE') return fail(res, 'La solicitud ya fue resuelta', 409);
    const rrhh = await esRRHH(u.id_usuario);
    if (!rrhh && !(await esJefeDe(u.id_usuario, s.id_usuario)))
      return fail(res, 'Solo la jefatura directa o RRHH puede resolver', 403);
    if (String(s.id_usuario) === String(u.id_usuario)) return fail(res, 'No puedes resolver tu propia solicitud', 403);
    await pool.query('UPDATE rh_ausencias SET estado=?, resuelto_por=?, resuelto_nombre=?, motivo_rechazo=? WHERE id=?',
      [estado, u.id_usuario, nombreDe(u), estado === 'RECHAZADA' ? (norm((req.body || {}).motivo_rechazo) || null) : null, s.id]);
    notificar([s.id_usuario], { tipo: 'RH_AUSENCIA', titulo: `📋 ${s.tipo} ${estado === 'APROBADA' ? 'aprobada' : 'rechazada'}`,
      mensaje: `${isoF(s.fecha_desde)} al ${isoF(s.fecha_hasta)} — por ${nombreDe(u)}`, href: '/recursos-humanos/ausencias/?id=' + s.id });
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'ausencia', entidad_id: s.id, detalle: `Ausencia #${s.id} (${s.tipo} de ${s.nombre}) → ${estado}` });
    ok(res, { ok: true });
  } catch (e) { console.error('[rrhh ausencias resolver]', e.message); fail(res, 'Error interno del servidor'); }
};

/* ── GET /api/rrhh/ausencias/adjunto/:id — dueño, su jefe o RRHH ─────────────── */
const adjunto = async (req, res) => {
  try {
    const u = req.usuario || {};
    const [[d]] = await pool.query('SELECT id_usuario, adjunto_nombre, adjunto_mime, adjunto_data FROM rh_ausencias WHERE id=?', [req.params.id]);
    if (!d || !d.adjunto_data) return fail(res, 'Adjunto no encontrado', 404);
    const propio = String(d.id_usuario) === String(u.id_usuario);
    if (!propio && !(await esRRHH(u.id_usuario)) && !(await esJefeDe(u.id_usuario, d.id_usuario)))
      return fail(res, 'Sin permiso', 403);
    res.setHeader('Content-Type', d.adjunto_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(d.adjunto_nombre || 'adjunto')}"`);
    res.send(d.adjunto_data);
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

/* ── GET /api/rrhh/ausencias/hoy — quiénes están ausentes hoy (todos) ────────── */
const ausentesHoy = async (req, res) => {
  try {
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date());
    const [aus] = await pool.query(
      "SELECT nombre, tipo, fecha_desde, fecha_hasta FROM rh_ausencias WHERE estado='APROBADA' AND ? BETWEEN fecha_desde AND fecha_hasta", [hoy]);
    const [vac] = await pool.query(
      "SELECT nombre, 'VACACIONES' AS tipo, fecha_desde, fecha_hasta FROM rh_vacaciones WHERE estado='APROBADA' AND ? BETWEEN fecha_desde AND fecha_hasta", [hoy]);
    ok(res, [...vac, ...aus]);
  } catch (e) { fail(res, 'Error interno del servidor'); }
};

/* ── GET /api/rrhh/vacaciones/saldo — devengado proporcional − usados ─────────
   Devengo: vac_dias_anuales/12 por mes completo trabajado (default 15/año = 1,25/mes).
   Usados: días HÁBILES L-V de las vacaciones APROBADAS (el feriado legal se
   descuenta en hábiles, aunque la solicitud guarde días corridos). */
const saldoVacaciones = async (req, res) => {
  try {
    const u = req.usuario || {};
    const rrhh = await esRRHH(u.id_usuario);
    let objetivo = u.id_usuario;
    if (req.query.id_usuario && String(req.query.id_usuario) !== String(u.id_usuario)) {
      if (!rrhh) return fail(res, 'Solo RRHH consulta saldos de otros', 403);
      objetivo = parseInt(req.query.id_usuario, 10);
    }
    const [[emp]] = await pool.query('SELECT fecha_ingreso FROM usuarios WHERE id_usuario=?', [objetivo]);
    if (!emp) return fail(res, 'Colaborador no encontrado', 404);
    if (!emp.fecha_ingreso) return ok(res, { sin_fecha: true, mensaje: 'RRHH aún no registra tu fecha de ingreso.' });
    const [[cfg]] = await pool.query("SELECT valor FROM rh_config WHERE clave='vac_dias_anuales'");
    const anuales = parseFloat(cfg?.valor) || 15;
    // meses completos trabajados
    const fi = new Date(isoF(emp.fecha_ingreso) + 'T12:00:00');
    const hoy = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date()) + 'T12:00:00');
    let meses = (hoy.getFullYear() - fi.getFullYear()) * 12 + (hoy.getMonth() - fi.getMonth());
    if (hoy.getDate() < fi.getDate()) meses--;
    meses = Math.max(0, meses);
    const devengados = Math.round(meses * (anuales / 12) * 10) / 10;
    // usados: hábiles L-V de vacaciones aprobadas
    const [vacs] = await pool.query("SELECT fecha_desde, fecha_hasta FROM rh_vacaciones WHERE id_usuario=? AND estado='APROBADA'", [objetivo]);
    let usados = 0;
    for (const v of vacs) usados += diasHabilesLV(isoF(v.fecha_desde), isoF(v.fecha_hasta));
    ok(res, { devengados, usados, disponibles: Math.round((devengados - usados) * 10) / 10, meses, dias_anuales: anuales, fecha_ingreso: isoF(emp.fecha_ingreso) });
  } catch (e) { console.error('[rrhh saldoVacaciones]', e.message); fail(res, 'Error interno del servidor'); }
};

module.exports = { crear, listar, resolver, adjunto, ausentesHoy, saldoVacaciones };
