'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Recursos Humanos — Solicitudes de Vacaciones y de Certificado de Antigüedad.
   Flujo: el empleado solicita → RRHH (permiso rh_aprobar) aprueba/rechaza/emite.
   ──────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');

/* ── Migración ─────────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_vacaciones (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario    INT          NULL,
        nombre        VARCHAR(200) NULL,
        fecha_desde   DATE         NOT NULL,
        fecha_hasta   DATE         NOT NULL,
        dias          INT          NOT NULL DEFAULT 0,
        comentario    TEXT         NULL,
        estado        VARCHAR(12)  NOT NULL DEFAULT 'PENDIENTE',
        resuelto_por  INT          NULL,
        resuelto_nombre VARCHAR(200) NULL,
        motivo_rechazo VARCHAR(300) NULL,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_usuario (id_usuario), INDEX idx_estado (estado)
      )`);
  } catch (e) { console.error('[rh_vacaciones migration]', e.message); }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_antiguedad (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario    INT          NULL,
        nombre        VARCHAR(200) NULL,
        motivo        VARCHAR(300) NULL,
        estado        VARCHAR(12)  NOT NULL DEFAULT 'PENDIENTE',
        fecha_ingreso DATE         NULL,
        resuelto_por  INT          NULL,
        resuelto_nombre VARCHAR(200) NULL,
        motivo_rechazo VARCHAR(300) NULL,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_usuario (id_usuario), INDEX idx_estado (estado)
      )`);
  } catch (e) { console.error('[rh_antiguedad migration]', e.message); }

  try {
    // RRHH vive DENTRO de Soporte (no es módulo propio en Home).
    const MOD_SOPORTE = 500001;
    const funcs = [
      ['Recursos Humanos',            'rh_ver',         '/soporte/recursos-humanos/',    'bi-people-fill', MOD_SOPORTE],
      ['Solicitudes de Vacaciones',   'rh_vacaciones',  '/recursos-humanos/vacaciones/', 'bi-airplane',    MOD_SOPORTE],
      ['Solicitudes de Antigüedad',   'rh_antiguedad',  '/recursos-humanos/antiguedad/', 'bi-award',       MOD_SOPORTE],
      ['Aprobar/Gestionar RRHH',      'rh_aprobar',     null,                            null,             MOD_SOPORTE],
    ];
    // Migración: si ya se sembró como módulo Home (v77.49), reubicarlo en Soporte y apagar el módulo suelto.
    await pool.query("UPDATE funcionalidades SET id_modulo=500001, href='/soporte/recursos-humanos/' WHERE codigo='rh_ver'");
    await pool.query("UPDATE funcionalidades SET id_modulo=500001 WHERE codigo IN ('rh_vacaciones','rh_antiguedad','rh_aprobar')");
    await pool.query("UPDATE modulos SET estado='inactivo' WHERE id_modulo=500002");
    const idFunc = {};
    for (const [nombre, codigo, href, icono, idmod] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)', [idmod, nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    const TODOS = [1, 2, 3, 4, 5, 6, 90008, 90009];
    const seed = { rh_ver: TODOS, rh_vacaciones: TODOS, rh_antiguedad: TODOS, rh_aprobar: [1, 2, 90009] };
    for (const [codigo, perfiles] of Object.entries(seed)) {
      const idf = idFunc[codigo]; if (!idf) continue;
      for (const idp of perfiles) {
        const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [idp, idf]);
        if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
      }
    }
    console.log('[rrhh] módulo registrado');
  } catch (e) { console.error('[rrhh permisos]', e.message); }
})();

/* ── Helpers ────────────────────────────────────────────────────────────────── */
const norm = s => String(s || '').trim();
const nombreDe = u => `${u?.nombre || ''} ${u?.apellido || ''}`.trim() || u?.email || null;
async function esRRHH(id_usuario) { try { const { tieneFunc } = require('../../../../shared/middleware/permisos'); return await tieneFunc(id_usuario, 'rh_aprobar'); } catch { return false; } }
async function poolRRHH(excluir) {
  const [rows] = await pool.query(
    `SELECT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
       WHERE p.nombre='Administrador' AND u.estado='activo'
     UNION
     SELECT u.id_usuario FROM usuarios u JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil
       JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
      WHERE f.codigo='rh_aprobar' AND pp.habilitado=1 AND u.estado='activo'`);
  return rows.map(r => r.id_usuario).filter(x => x && x !== excluir);
}
function diasEntre(d1, d2) { const a = new Date(d1 + 'T00:00:00'), b = new Date(d2 + 'T00:00:00'); return Math.max(1, Math.floor((b - a) / 86400000) + 1); }

/* ════════════ VACACIONES ════════════ */
const crearVacaciones = async (req, res) => {
  try {
    const b = req.body || {}; const u = req.usuario || {};
    const fd = norm(b.fecha_desde), fh = norm(b.fecha_hasta);
    if (!fd || !fh) return res.status(400).json({ success: false, data: null, error: 'Indica las fechas desde y hasta' });
    if (fh < fd) return res.status(400).json({ success: false, data: null, error: 'La fecha hasta no puede ser anterior a desde' });
    const dias = diasEntre(fd, fh);
    const [r] = await pool.query('INSERT INTO rh_vacaciones (id_usuario, nombre, fecha_desde, fecha_hasta, dias, comentario) VALUES (?,?,?,?,?,?)',
      [u.id_usuario || null, nombreDe(u), fd, fh, dias, norm(b.comentario) || null]);
    const ids = await poolRRHH(u.id_usuario);
    if (ids.length) notificar(ids, { tipo: 'RH_VACACIONES', titulo: '🌴 Solicitud de vacaciones', mensaje: `${nombreDe(u)} solicitó ${dias} día(s): ${fd} al ${fh}`, href: '/recursos-humanos/vacaciones/?id=' + r.insertId });
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'vacaciones', entidad_id: r.insertId, detalle: `Solicitó vacaciones ${fd}→${fh} (${dias}d)` });
    res.status(201).json({ success: true, data: { id: r.insertId, dias }, error: null });
  } catch (e) { console.error('[rrhh crearVacaciones]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const listarVacaciones = async (req, res) => {
  try {
    const u = req.usuario || {}; const rrhh = await esRRHH(u.id_usuario);
    const vista = req.query.vista === 'bandeja' && rrhh ? 'bandeja' : 'mias';
    const params = []; let where = '';
    if (vista === 'mias') { where = 'WHERE id_usuario=?'; params.push(u.id_usuario); }
    const [rows] = await pool.query(`SELECT * FROM rh_vacaciones ${where} ORDER BY FIELD(estado,'PENDIENTE','APROBADA','RECHAZADA'), created_at DESC LIMIT 300`, params);
    res.json({ success: true, data: { solicitudes: rows, es_rrhh: rrhh }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const resolverVacaciones = async (req, res) => {
  try {
    const u = req.usuario || {}; if (!(await esRRHH(u.id_usuario))) return res.status(403).json({ success: false, data: null, error: 'Solo RRHH resuelve' });
    const estado = String((req.body || {}).estado || '').toUpperCase();
    if (!['APROBADA', 'RECHAZADA'].includes(estado)) return res.status(400).json({ success: false, data: null, error: 'Estado inválido' });
    const [[s]] = await pool.query('SELECT * FROM rh_vacaciones WHERE id=?', [req.params.id]);
    if (!s) return res.status(404).json({ success: false, data: null, error: 'Solicitud no encontrada' });
    await pool.query('UPDATE rh_vacaciones SET estado=?, resuelto_por=?, resuelto_nombre=?, motivo_rechazo=? WHERE id=?',
      [estado, u.id_usuario || null, nombreDe(u), estado === 'RECHAZADA' ? (norm((req.body || {}).motivo_rechazo) || null) : null, s.id]);
    if (s.id_usuario) notificar([s.id_usuario], { tipo: 'RH_VACACIONES', titulo: `🌴 Vacaciones ${estado === 'APROBADA' ? 'aprobadas' : 'rechazadas'}`, mensaje: `${s.fecha_desde} al ${s.fecha_hasta} (${s.dias}d)`, href: '/recursos-humanos/vacaciones/?id=' + s.id });
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'vacaciones', entidad_id: s.id, detalle: `Vacaciones #${s.id} → ${estado}` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ════════════ ANTIGÜEDAD ════════════ */
const crearAntiguedad = async (req, res) => {
  try {
    const b = req.body || {}; const u = req.usuario || {};
    const [r] = await pool.query('INSERT INTO rh_antiguedad (id_usuario, nombre, motivo) VALUES (?,?,?)', [u.id_usuario || null, nombreDe(u), norm(b.motivo) || null]);
    const ids = await poolRRHH(u.id_usuario);
    if (ids.length) notificar(ids, { tipo: 'RH_ANTIGUEDAD', titulo: '🏅 Solicitud de antigüedad', mensaje: `${nombreDe(u)} pidió un certificado de antigüedad`, href: '/recursos-humanos/antiguedad/?id=' + r.insertId });
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'antiguedad', entidad_id: r.insertId, detalle: 'Solicitó certificado de antigüedad' });
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { console.error('[rrhh crearAntiguedad]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const listarAntiguedad = async (req, res) => {
  try {
    const u = req.usuario || {}; const rrhh = await esRRHH(u.id_usuario);
    const vista = req.query.vista === 'bandeja' && rrhh ? 'bandeja' : 'mias';
    const params = []; let where = '';
    if (vista === 'mias') { where = 'WHERE id_usuario=?'; params.push(u.id_usuario); }
    const [rows] = await pool.query(`SELECT * FROM rh_antiguedad ${where} ORDER BY FIELD(estado,'PENDIENTE','EMITIDA','RECHAZADA'), created_at DESC LIMIT 300`, params);
    res.json({ success: true, data: { solicitudes: rows, es_rrhh: rrhh }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const resolverAntiguedad = async (req, res) => {
  try {
    const u = req.usuario || {}; if (!(await esRRHH(u.id_usuario))) return res.status(403).json({ success: false, data: null, error: 'Solo RRHH resuelve' });
    const b = req.body || {}; const estado = String(b.estado || '').toUpperCase();
    if (!['EMITIDA', 'RECHAZADA'].includes(estado)) return res.status(400).json({ success: false, data: null, error: 'Estado inválido' });
    const [[s]] = await pool.query('SELECT * FROM rh_antiguedad WHERE id=?', [req.params.id]);
    if (!s) return res.status(404).json({ success: false, data: null, error: 'Solicitud no encontrada' });
    if (estado === 'EMITIDA' && !norm(b.fecha_ingreso)) return res.status(400).json({ success: false, data: null, error: 'Indica la fecha de ingreso para emitir' });
    await pool.query('UPDATE rh_antiguedad SET estado=?, fecha_ingreso=?, resuelto_por=?, resuelto_nombre=?, motivo_rechazo=? WHERE id=?',
      [estado, estado === 'EMITIDA' ? norm(b.fecha_ingreso) : null, u.id_usuario || null, nombreDe(u), estado === 'RECHAZADA' ? (norm(b.motivo_rechazo) || null) : null, s.id]);
    if (s.id_usuario) notificar([s.id_usuario], { tipo: 'RH_ANTIGUEDAD', titulo: `🏅 Antigüedad ${estado === 'EMITIDA' ? 'emitida' : 'rechazada'}`, mensaje: estado === 'EMITIDA' ? `Tu certificado está listo (ingreso ${norm(b.fecha_ingreso)})` : 'Tu solicitud fue rechazada', href: '/recursos-humanos/antiguedad/?id=' + s.id });
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'antiguedad', entidad_id: s.id, detalle: `Antigüedad #${s.id} → ${estado}` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { crearVacaciones, listarVacaciones, resolverVacaciones, crearAntiguedad, listarAntiguedad, resolverAntiguedad };
