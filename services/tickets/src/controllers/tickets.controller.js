'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Tickets TI — reporte de problemas a TI. Motivos, prioridad, estados, mensajes.
   Paramétrico: motivos, SLA de primera respuesta, escalamiento y correos
   automáticos se configuran en el Mantenedor (no hardcode de negocio).
   ──────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
const { enviarCorreo } = require('../../../../shared/mailer');

const MOTIVOS_SEED = [
  ['Computador / Notebook', 24], ['Impresora / Escáner', 24], ['Internet / Red', 4],
  ['Correo electrónico', 8], ['Sistema AutoFácil (error/bug)', 8], ['Acceso / Contraseña', 4],
  ['Telefonía', 24], ['Software / Instalación', 48], ['Otro', 48],
];

/* ── Migración ─────────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ti_motivos (
        id        INT AUTO_INCREMENT PRIMARY KEY,
        nombre    VARCHAR(120) NOT NULL,
        sla_horas INT          NOT NULL DEFAULT 24,
        orden     INT          NOT NULL DEFAULT 0,
        activo    TINYINT(1)   NOT NULL DEFAULT 1
      )`);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM ti_motivos');
    if (!n) { let o = 0; for (const [nombre, sla] of MOTIVOS_SEED) await pool.query('INSERT INTO ti_motivos (nombre, sla_horas, orden) VALUES (?,?,?)', [nombre, sla, ++o]); }
  } catch (e) { console.error('[ti_motivos migration]', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ti_config (
        id            TINYINT PRIMARY KEY DEFAULT 1,
        escal_horas   INT        NOT NULL DEFAULT 48,
        correo_nuevo  TINYINT(1) NOT NULL DEFAULT 1,
        correo_escal  TINYINT(1) NOT NULL DEFAULT 1,
        correo_cierre TINYINT(1) NOT NULL DEFAULT 1
      )`);
    await pool.query('INSERT IGNORE INTO ti_config (id) VALUES (1)');
  } catch (e) { console.error('[ti_config migration]', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ti_tickets (
        id                  INT AUTO_INCREMENT PRIMARY KEY,
        codigo              VARCHAR(20)  NULL,
        id_motivo           INT          NULL,
        motivo_nombre       VARCHAR(120) NULL,
        asunto              VARCHAR(200) NOT NULL,
        descripcion         TEXT         NULL,
        prioridad           VARCHAR(10)  NOT NULL DEFAULT 'MEDIA',
        estado              VARCHAR(15)  NOT NULL DEFAULT 'ABIERTO',
        creado_por          INT          NULL,
        creado_nombre       VARCHAR(200) NULL,
        creado_email        VARCHAR(200) NULL,
        asignado_a          INT          NULL,
        asignado_nombre     VARCHAR(200) NULL,
        primera_respuesta_at DATETIME    NULL,
        sla_vence           DATETIME     NULL,
        escalado            TINYINT(1)   NOT NULL DEFAULT 0,
        cerrado_at          DATETIME     NULL,
        created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_estado (estado), INDEX idx_creador (creado_por)
      )`);
  } catch (e) { console.error('[ti_tickets migration]', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ti_mensajes (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        id_ticket   INT          NOT NULL,
        autor_id    INT          NULL,
        autor_nombre VARCHAR(200) NULL,
        es_ti       TINYINT(1)   NOT NULL DEFAULT 0,
        mensaje     TEXT         NOT NULL,
        created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ticket (id_ticket)
      )`);
  } catch (e) { console.error('[ti_mensajes migration]', e.message); }

  // Funcionalidades / permisos
  try {
    const MOD_SOPORTE = 500001, MOD_MANT = 30001;
    const funcs = [
      ['Reportar a TI (Tickets)', 'tickets_ti',      '/soporte/tickets-ti/',     'bi-life-preserver', MOD_SOPORTE],
      ['Atender Tickets TI',      'ti_atender',       null,                       null,                MOD_SOPORTE],
      ['Mantenedor Tickets TI',   'tickets_ti_mant',  '/mantenedores/tickets-ti/','bi-life-preserver', MOD_MANT],
    ];
    const idFunc = {};
    for (const [nombre, codigo, href, icono, idmod] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)', [idmod, nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    const TODOS = [1, 2, 3, 4, 5, 6, 90008, 90009];
    const seed = { tickets_ti: TODOS, ti_atender: [1], tickets_ti_mant: [1] };
    for (const [codigo, perfiles] of Object.entries(seed)) {
      const idf = idFunc[codigo]; if (!idf) continue;
      for (const idp of perfiles) {
        const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [idp, idf]);
        if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
      }
    }
    console.log('[tickets-ti] módulo registrado');
  } catch (e) { console.error('[tickets-ti permisos]', e.message); }
})();

/* ── Helpers ────────────────────────────────────────────────────────────────── */
const norm = s => String(s || '').trim();
const nombreDe = u => `${u?.nombre || ''} ${u?.apellido || ''}`.trim() || u?.email || null;
const PRIOS = ['BAJA', 'MEDIA', 'ALTA'];
const ESTADOS = ['ABIERTO', 'EN_PROCESO', 'RESUELTO', 'CERRADO'];

async function esTI(id_usuario) {
  try { const { tieneFunc } = require('../../../../shared/middleware/permisos'); return await tieneFunc(id_usuario, 'ti_atender'); }
  catch { return false; }
}
async function poolTI() {
  const [rows] = await pool.query(
    `SELECT u.id_usuario, u.email, CONCAT(COALESCE(u.nombre,''),' ',COALESCE(u.apellido,'')) nombre FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
       WHERE p.nombre='Administrador' AND u.estado='activo'
     UNION
     SELECT u.id_usuario, u.email, CONCAT(COALESCE(u.nombre,''),' ',COALESCE(u.apellido,'')) nombre FROM usuarios u
       JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
      WHERE f.codigo='ti_atender' AND pp.habilitado=1 AND u.estado='activo'`);
  return rows;
}
async function getConfig() { const [[c]] = await pool.query('SELECT * FROM ti_config WHERE id=1'); return c || { escal_horas: 48, correo_nuevo: 1, correo_escal: 1, correo_cierre: 1 }; }

/* ── Motivos (form público) ────────────────────────────────────────────────── */
const motivos = async (req, res) => {
  try { const [rows] = await pool.query('SELECT id, nombre, sla_horas FROM ti_motivos WHERE activo=1 ORDER BY orden, nombre'); res.json({ success: true, data: rows, error: null }); }
  catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Crear ticket ──────────────────────────────────────────────────────────── */
const crear = async (req, res) => {
  try {
    const b = req.body || {};
    const asunto = norm(b.asunto); if (!asunto) return res.status(400).json({ success: false, data: null, error: 'Falta el asunto' });
    const prioridad = PRIOS.includes(String(b.prioridad).toUpperCase()) ? String(b.prioridad).toUpperCase() : 'MEDIA';
    let motivoNombre = null, sla = 24;
    if (b.id_motivo) { const [[m]] = await pool.query('SELECT nombre, sla_horas FROM ti_motivos WHERE id=?', [b.id_motivo]); if (m) { motivoNombre = m.nombre; sla = m.sla_horas || 24; } }
    const u = req.usuario || {};
    const [r] = await pool.query(
      `INSERT INTO ti_tickets (id_motivo, motivo_nombre, asunto, descripcion, prioridad, estado, creado_por, creado_nombre, creado_email, sla_vence)
       VALUES (?,?,?,?,?,'ABIERTO',?,?,?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
      [b.id_motivo || null, motivoNombre, asunto, norm(b.descripcion) || null, prioridad, u.id_usuario || null, nombreDe(u), u.email || null, sla]);
    const id = r.insertId;
    const codigo = 'TKT-' + String(id).padStart(6, '0');
    await pool.query('UPDATE ti_tickets SET codigo=? WHERE id=?', [codigo, id]);

    // Alerta + correo al pool de TI
    const cfg = await getConfig();
    const pool_ti = await poolTI();
    const ids = pool_ti.map(x => x.id_usuario).filter(x => x && x !== u.id_usuario);
    if (ids.length) notificar(ids, { tipo: 'TICKET_TI', titulo: '🛟 Nuevo ticket de TI', mensaje: `${nombreDe(u)} reportó: ${asunto} (${codigo}, prioridad ${prioridad})`, href: '/soporte/tickets-ti/?id=' + id, prioridad: prioridad === 'ALTA' ? 'alta' : 'normal', sonar: prioridad === 'ALTA' ? 1 : 0, son_tipo: 'dingdong' });
    if (cfg.correo_nuevo) {
      const to = pool_ti.map(x => x.email).filter(Boolean);
      if (to.length) enviarCorreo({ to, subject: `Nuevo ticket de TI ${codigo} — ${asunto}`, html: `<p>Se creó un nuevo ticket de soporte TI.</p><p><b>${codigo}</b> · Prioridad ${prioridad}${motivoNombre ? ' · ' + motivoNombre : ''}<br>Reportado por: ${nombreDe(u)}</p><p><b>${asunto}</b><br>${(norm(b.descripcion) || '').replace(/</g, '&lt;')}</p>` }).catch(() => {});
    }
    auditar({ req, accion: 'CREAR', modulo: 'tickets', entidad: 'ticket', entidad_id: id, detalle: `Creó ticket TI ${codigo}: ${asunto}` });
    res.status(201).json({ success: true, data: { id, codigo }, error: null });
  } catch (e) { console.error('[tickets crear]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Listar ────────────────────────────────────────────────────────────────── */
const listar = async (req, res) => {
  try {
    const u = req.usuario || {};
    const ti = await esTI(u.id_usuario);
    const vista = req.query.vista === 'bandeja' && ti ? 'bandeja' : 'mias';
    const params = []; let where = '';
    if (vista === 'mias') { where = 'WHERE creado_por=?'; params.push(u.id_usuario); }
    if (req.query.estado && ESTADOS.includes(req.query.estado)) { where += (where ? ' AND' : 'WHERE') + ' estado=?'; params.push(req.query.estado); }
    const [rows] = await pool.query(
      `SELECT id, codigo, motivo_nombre, asunto, prioridad, estado, creado_nombre, asignado_nombre, escalado, created_at, updated_at
         FROM ti_tickets ${where} ORDER BY FIELD(estado,'ABIERTO','EN_PROCESO','RESUELTO','CERRADO'), created_at DESC LIMIT 300`, params);
    res.json({ success: true, data: { tickets: rows, es_ti: ti }, error: null });
  } catch (e) { console.error('[tickets listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Ver ticket + mensajes ─────────────────────────────────────────────────── */
const obtener = async (req, res) => {
  try {
    const [[t]] = await pool.query('SELECT * FROM ti_tickets WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({ success: false, data: null, error: 'Ticket no encontrado' });
    const u = req.usuario || {};
    const ti = await esTI(u.id_usuario);
    if (!ti && t.creado_por !== u.id_usuario) return res.status(403).json({ success: false, data: null, error: 'Sin acceso a este ticket' });
    const [msgs] = await pool.query('SELECT id, autor_nombre, es_ti, mensaje, created_at FROM ti_mensajes WHERE id_ticket=? ORDER BY created_at', [req.params.id]);
    res.json({ success: true, data: { ...t, mensajes: msgs, es_ti: ti }, error: null });
  } catch (e) { console.error('[tickets obtener]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Comentar ──────────────────────────────────────────────────────────────── */
const comentar = async (req, res) => {
  try {
    const msg = norm((req.body || {}).mensaje); if (!msg) return res.status(400).json({ success: false, data: null, error: 'Mensaje vacío' });
    const [[t]] = await pool.query('SELECT * FROM ti_tickets WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({ success: false, data: null, error: 'Ticket no encontrado' });
    const u = req.usuario || {};
    const ti = await esTI(u.id_usuario);
    if (!ti && t.creado_por !== u.id_usuario) return res.status(403).json({ success: false, data: null, error: 'Sin acceso' });
    await pool.query('INSERT INTO ti_mensajes (id_ticket, autor_id, autor_nombre, es_ti, mensaje) VALUES (?,?,?,?,?)', [t.id, u.id_usuario || null, nombreDe(u), ti ? 1 : 0, msg]);
    // Primera respuesta de TI → marca SLA cumplido y pasa a EN_PROCESO
    if (ti && !t.primera_respuesta_at) await pool.query("UPDATE ti_tickets SET primera_respuesta_at=NOW(), estado=IF(estado='ABIERTO','EN_PROCESO',estado), asignado_a=COALESCE(asignado_a,?), asignado_nombre=COALESCE(asignado_nombre,?) WHERE id=?", [u.id_usuario || null, nombreDe(u), t.id]);
    // Avisa a la otra parte
    const destino = ti ? t.creado_por : null;
    if (destino && destino !== u.id_usuario) notificar([destino], { tipo: 'TICKET_TI', titulo: '💬 Respuesta a tu ticket', mensaje: `${t.codigo}: ${msg.slice(0, 80)}`, href: '/soporte/tickets-ti/?id=' + t.id });
    else if (!ti) { const ids = (await poolTI()).map(x => x.id_usuario).filter(x => x && x !== u.id_usuario); if (ids.length) notificar(ids, { tipo: 'TICKET_TI', titulo: '💬 Nuevo mensaje en ticket', mensaje: `${t.codigo}: ${msg.slice(0, 80)}`, href: '/soporte/tickets-ti/?id=' + t.id }); }
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[tickets comentar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Cambiar estado / asignar (solo TI) ────────────────────────────────────── */
const cambiarEstado = async (req, res) => {
  try {
    const u = req.usuario || {};
    if (!(await esTI(u.id_usuario))) return res.status(403).json({ success: false, data: null, error: 'Solo TI puede cambiar el estado' });
    const estado = String((req.body || {}).estado || '').toUpperCase();
    if (!ESTADOS.includes(estado)) return res.status(400).json({ success: false, data: null, error: 'Estado inválido' });
    const [[t]] = await pool.query('SELECT * FROM ti_tickets WHERE id=?', [req.params.id]);
    if (!t) return res.status(404).json({ success: false, data: null, error: 'Ticket no encontrado' });
    const cerrar = (estado === 'RESUELTO' || estado === 'CERRADO');
    await pool.query("UPDATE ti_tickets SET estado=?, asignado_a=COALESCE(asignado_a,?), asignado_nombre=COALESCE(asignado_nombre,?), cerrado_at=IF(?,NOW(),cerrado_at), primera_respuesta_at=COALESCE(primera_respuesta_at, IF(?,NOW(),NULL)) WHERE id=?",
      [estado, u.id_usuario || null, nombreDe(u), cerrar ? 1 : 0, cerrar ? 1 : 0, t.id]);
    if (t.creado_por && t.creado_por !== u.id_usuario) notificar([t.creado_por], { tipo: 'TICKET_TI', titulo: `🛟 Ticket ${estado === 'RESUELTO' ? 'resuelto' : estado === 'CERRADO' ? 'cerrado' : 'actualizado'}`, mensaje: `${t.codigo} → ${estado.replace('_', ' ')}`, href: '/soporte/tickets-ti/?id=' + t.id });
    if (cerrar) { const cfg = await getConfig(); if (cfg.correo_cierre && t.creado_email) enviarCorreo({ to: t.creado_email, subject: `Tu ticket ${t.codigo} fue ${estado === 'RESUELTO' ? 'resuelto' : 'cerrado'}`, html: `<p>Tu ticket <b>${t.codigo}</b> — ${t.asunto} — fue marcado como <b>${estado}</b> por ${nombreDe(u)}.</p>` }).catch(() => {}); }
    auditar({ req, accion: 'EDITAR', modulo: 'tickets', entidad: 'ticket', entidad_id: t.id, detalle: `Ticket ${t.codigo} → ${estado}` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[tickets cambiarEstado]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Mantenedor: motivos + config ──────────────────────────────────────────── */
const motivosAdmin = async (req, res) => { try { const [rows] = await pool.query('SELECT * FROM ti_motivos ORDER BY orden, nombre'); res.json({ success: true, data: rows, error: null }); } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error' }); } };
const guardarMotivo = async (req, res) => {
  try {
    const b = req.body || {}; const nombre = norm(b.nombre); if (!nombre) return res.status(400).json({ success: false, data: null, error: 'Falta el nombre' });
    const sla = parseInt(b.sla_horas) || 24, orden = parseInt(b.orden) || 0, activo = b.activo === false ? 0 : 1;
    if (req.params.id) await pool.query('UPDATE ti_motivos SET nombre=?, sla_horas=?, orden=?, activo=? WHERE id=?', [nombre, sla, orden, activo, req.params.id]);
    else await pool.query('INSERT INTO ti_motivos (nombre, sla_horas, orden, activo) VALUES (?,?,?,?)', [nombre, sla, orden, activo]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const eliminarMotivo = async (req, res) => { try { await pool.query('UPDATE ti_motivos SET activo=0 WHERE id=?', [req.params.id]); res.json({ success: true, data: { ok: true }, error: null }); } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error' }); } };
const getConfigEp = async (req, res) => { try { res.json({ success: true, data: await getConfig(), error: null }); } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error' }); } };
const setConfig = async (req, res) => {
  try { const b = req.body || {};
    await pool.query('UPDATE ti_config SET escal_horas=?, correo_nuevo=?, correo_escal=?, correo_cierre=? WHERE id=1',
      [parseInt(b.escal_horas) || 48, b.correo_nuevo ? 1 : 0, b.correo_escal ? 1 : 0, b.correo_cierre ? 1 : 0]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Tick de escalamiento (SLA de primera respuesta vencido) ───────────────── */
let _esc = false;
async function tickEscalar() {
  if (_esc) return; _esc = true;
  try {
    const [vencidos] = await pool.query("SELECT * FROM ti_tickets WHERE estado='ABIERTO' AND escalado=0 AND primera_respuesta_at IS NULL AND sla_vence IS NOT NULL AND sla_vence < NOW()");
    if (vencidos.length) {
      const cfg = await getConfig();
      const pool_ti = await poolTI();
      for (const t of vencidos) {
        await pool.query('UPDATE ti_tickets SET escalado=1 WHERE id=?', [t.id]);
        const ids = pool_ti.map(x => x.id_usuario).filter(Boolean);
        if (ids.length) notificar(ids, { tipo: 'TICKET_TI', titulo: '⏰ Ticket sin respuesta (escalado)', mensaje: `${t.codigo} — ${t.asunto} superó su SLA sin respuesta`, href: '/soporte/tickets-ti/?id=' + t.id, prioridad: 'alta', sonar: 1, son_tipo: 'alarma' });
        if (cfg.correo_escal) { const to = pool_ti.map(x => x.email).filter(Boolean); if (to.length) enviarCorreo({ to, subject: `⏰ Ticket escalado ${t.codigo} — sin respuesta`, html: `<p>El ticket <b>${t.codigo}</b> — ${t.asunto} — superó su SLA de primera respuesta sin ser atendido. Prioridad ${t.prioridad}.</p>` }).catch(() => {}); }
        console.log(`[tickets SLA] ${t.codigo} escalado`);
      }
    }
  } catch (e) { console.error('[tickets tickEscalar]', e.message); }
  finally { _esc = false; }
}
setInterval(tickEscalar, 30 * 60 * 1000);
setTimeout(tickEscalar, 25 * 1000);

module.exports = { motivos, crear, listar, obtener, comentar, cambiarEstado, motivosAdmin, guardarMotivo, eliminarMotivo, getConfig: getConfigEp, setConfig, tickEscalar };
