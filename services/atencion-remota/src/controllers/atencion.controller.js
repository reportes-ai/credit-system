'use strict';
/**
 * Atención Remota — mesa de atención digital de dealers.
 * Chat en tiempo real (hasta 3 conversaciones en paralelo por ejecutivo),
 * videoconferencia WebRTC (audio/video/compartir pantalla) y envío de
 * documentos escaneados. Los dealers ingresan con cuenta propia (portal).
 *
 * Este archivo: migraciones (IIFE), endpoints REST y helpers de servicio que
 * usa el servidor WebSocket (ws.js). El transporte en tiempo real vive en ws.js;
 * acá vive la persistencia y la autenticación.
 */
const pool   = require('../../../../shared/config/database');
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { JWT_SECRET, JWT_EXPIRES } = require('../../../../shared/middleware/auth');
const { auditar } = require('../../../../shared/audit');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');

const normRut = r => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();
const errSrv  = (res, e, tag) => { console.error(`[${tag}]`, e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); };

/* ── Migraciones ─────────────────────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ar_dealer_cuentas (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      id_dealer     INT NULL,
      rut           VARCHAR(12) NULL,
      nombre        VARCHAR(200) NULL,
      email         VARCHAR(150) NOT NULL UNIQUE,
      password_hash VARCHAR(100) NOT NULL,
      activo        TINYINT(1) DEFAULT 1,
      ultimo_acceso DATETIME NULL,
      creado_por    INT NULL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ar_conversaciones (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      id_dealer        INT NULL,
      id_cuenta        INT NULL,
      dealer_rut       VARCHAR(12) NULL,
      dealer_nombre    VARCHAR(200) NULL,
      id_ejecutivo     INT NULL,
      ejecutivo_nombre VARCHAR(200) NULL,
      estado           VARCHAR(12) DEFAULT 'ESPERA',
      canal            VARCHAR(12) DEFAULT 'CHAT',
      asunto           VARCHAR(200) NULL,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      asignada_at      DATETIME NULL,
      cerrada_at       DATETIME NULL,
      INDEX idx_estado (estado),
      INDEX idx_ejecutivo (id_ejecutivo)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ar_mensajes (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      id_conversacion INT NOT NULL,
      emisor          VARCHAR(10) NOT NULL,
      id_usuario      INT NULL,
      autor_nombre    VARCHAR(200) NULL,
      cuerpo          TEXT NULL,
      tipo            VARCHAR(10) DEFAULT 'TEXTO',
      id_adjunto      INT NULL,
      leido           TINYINT(1) DEFAULT 0,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_conv (id_conversacion)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ar_adjuntos (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      id_conversacion INT NOT NULL,
      nombre          VARCHAR(255),
      mime            VARCHAR(100),
      tamano          INT,
      data            LONGBLOB,
      subido_por      VARCHAR(10),
      subido_id       INT NULL,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_conv (id_conversacion)
    )`);

    await pool.query(`CREATE TABLE IF NOT EXISTS ar_config (
      id              INT PRIMARY KEY,
      max_chats       INT DEFAULT 3,
      mensaje_bienvenida TEXT,
      horario_inicio  VARCHAR(5) NULL,
      horario_fin     VARCHAR(5) NULL,
      stun_urls       TEXT,
      turn_url        VARCHAR(255) NULL,
      turn_username   VARCHAR(100) NULL,
      turn_credential VARCHAR(100) NULL,
      updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);

    // Fila única de configuración (id=1). TURN público gratuito (Open Relay) por
    // defecto para que el video funcione tras NAT sin instalar nada; el admin lo
    // reemplaza por el suyo en el mantenedor.
    const [[cfg]] = await pool.query('SELECT id FROM ar_config WHERE id=1');
    if (!cfg) {
      await pool.query(
        `INSERT INTO ar_config (id, max_chats, mensaje_bienvenida, stun_urls, turn_url, turn_username, turn_credential)
         VALUES (1, 3, ?, ?, ?, 'openrelayproject', 'openrelayproject')`,
        ['Bienvenido a la atención digital de AutoFácil. Un ejecutivo te atenderá en breve.',
         'stun:stun.l.google.com:19302 stun:stun1.l.google.com:19302',
         'turn:openrelay.metered.ca:80 turn:openrelay.metered.ca:443']);
    }

    // Registro del módulo (card del front) + funcionalidades (anti-hardcode).
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/atencion-remota/' LIMIT 1");
    let idMod = mod && mod.id_modulo;
    if (!idMod) {
      const [r] = await pool.query(
        `INSERT INTO modulos (nombre, descripcion, icono, ruta, orden, estado)
         VALUES ('Atención Remota','Atención digital de dealers: chat, video y documentos en línea','bi-headset','/atencion-remota/',32,'activo')`);
      idMod = r.insertId;
    }
    for (const f of [
      { nombre: 'Atención Remota', codigo: 'atencion_remota', href: '/atencion-remota/', icono: 'bi-headset' },
      { nombre: 'Configuración Atención Remota', codigo: 'atencion_remota_config', href: null, icono: 'bi-sliders' },
    ]) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [f.codigo]);
      let idf = ex && ex.id_funcionalidad;
      if (!idf) {
        const [r] = await pool.query(
          `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)`,
          [idMod, f.nombre, f.codigo, f.href, f.icono]);
        idf = r.insertId;
      }
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    }

    // Respuestas rápidas del chat (mantenedor paramétrico).
    await pool.query(`CREATE TABLE IF NOT EXISTS ar_respuestas_rapidas (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      titulo     VARCHAR(80) NOT NULL,
      texto      TEXT NOT NULL,
      orden      INT DEFAULT 0,
      activo     TINYINT(1) DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    const [[{ nr }]] = await pool.query('SELECT COUNT(*) nr FROM ar_respuestas_rapidas');
    if (!nr) {
      const seed = [
        ['Saludo', 'Hola, gracias por contactarte con AutoFácil. ¿En qué te puedo ayudar?'],
        ['Pedir RUT', '¿Me confirmas el RUT del cliente para revisar la operación?'],
        ['Pedir documento', 'Por favor envíame una foto o PDF del documento por este mismo chat.'],
        ['Un momento', 'Dame un momento mientras reviso la información, por favor.'],
        ['Despedida', '¡Gracias por preferir AutoFácil! Que tengas un excelente día.'],
      ];
      let o = 1;
      for (const [t, x] of seed) await pool.query('INSERT INTO ar_respuestas_rapidas (titulo, texto, orden) VALUES (?,?,?)', [t, x, o++]);
    }
    const [[mm]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo' LIMIT 1");
    if (mm) {
      const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_respuestas_rapidas' LIMIT 1");
      let idf = ex && ex.id_funcionalidad;
      if (!idf) {
        const [r] = await pool.query(
          `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
           VALUES (?, 'Respuestas Rápidas del Chat', 'mant_respuestas_rapidas', '/mantenedores/respuestas-rapidas/', 'bi-chat-quote')`, [mm.id_modulo]);
        idf = r.insertId;
      }
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    }

    // Solicitudes de cuenta de dealer (autoregistro desde el portal).
    await pool.query(`CREATE TABLE IF NOT EXISTS ar_solicitudes_cuenta (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      rut          VARCHAR(20),
      razon_social VARCHAR(200),
      direccion    VARCHAR(300),
      telefono     VARCHAR(40),
      contacto     VARCHAR(150),
      email        VARCHAR(150),
      estado       VARCHAR(12) DEFAULT 'PENDIENTE',
      nota         VARCHAR(300) NULL,
      procesada_by INT NULL,
      procesada_at DATETIME NULL,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_estado (estado)
    )`);

    // Interlocutor (persona del dealer con quien se chatea) por conversación.
    await pool.query('ALTER TABLE ar_conversaciones ADD COLUMN IF NOT EXISTS interlocutor VARCHAR(150) NULL');

    console.log('[atencion-remota] módulo y esquema listos');
  } catch (e) { console.error('[atencion-remota migration]', e.message); }
})();

/* ── ICE servers (WebRTC) desde configuración paramétrica ─────────────────── */
function buildIce(cfg) {
  const list = [];
  String(cfg.stun_urls || '').split(/[\s,]+/).filter(Boolean).forEach(u => list.push({ urls: u }));
  const turns = String(cfg.turn_url || '').split(/[\s,]+/).filter(Boolean);
  if (turns.length) {
    const e = { urls: turns };
    if (cfg.turn_username)   e.username   = cfg.turn_username;
    if (cfg.turn_credential) e.credential = cfg.turn_credential;
    list.push(e);
  }
  if (!list.length) list.push({ urls: 'stun:stun.l.google.com:19302' });
  return list;
}
async function getCfg() {
  const [[cfg]] = await pool.query('SELECT * FROM ar_config WHERE id=1');
  return cfg || { max_chats: 3, stun_urls: 'stun:stun.l.google.com:19302' };
}

/* ── Helpers de servicio (los usa ws.js) ─────────────────────────────────── */
async function crearConversacion({ id_dealer, id_cuenta, rut, nombre, asunto, canal }) {
  const [r] = await pool.query(
    `INSERT INTO ar_conversaciones (id_dealer, id_cuenta, dealer_rut, dealer_nombre, asunto, canal, estado)
     VALUES (?,?,?,?,?,?,'ESPERA')`,
    [id_dealer || null, id_cuenta || null, rut || null, nombre || null, asunto || null, canal || 'CHAT']);
  const [[conv]] = await pool.query('SELECT * FROM ar_conversaciones WHERE id=?', [r.insertId]);
  return conv;
}
async function getConversacion(id) {
  const [[c]] = await pool.query('SELECT * FROM ar_conversaciones WHERE id=?', [id]);
  return c || null;
}
async function asignarConversacion(id, id_ejecutivo, ejecutivo_nombre) {
  await pool.query(
    `UPDATE ar_conversaciones SET id_ejecutivo=?, ejecutivo_nombre=?, estado='ACTIVA', asignada_at=NOW()
     WHERE id=? AND estado='ESPERA'`, [id_ejecutivo, ejecutivo_nombre, id]);
  return getConversacion(id);
}
async function cerrarConversacion(id) {
  await pool.query("UPDATE ar_conversaciones SET estado='CERRADA', cerrada_at=NOW() WHERE id=?", [id]);
  return getConversacion(id);
}
async function persistMensaje({ id_conversacion, emisor, id_usuario, autor_nombre, cuerpo, tipo, id_adjunto }) {
  const [r] = await pool.query(
    `INSERT INTO ar_mensajes (id_conversacion, emisor, id_usuario, autor_nombre, cuerpo, tipo, id_adjunto)
     VALUES (?,?,?,?,?,?,?)`,
    [id_conversacion, emisor, id_usuario || null, autor_nombre || null, cuerpo || null, tipo || 'TEXTO', id_adjunto || null]);
  const [[m]] = await pool.query('SELECT * FROM ar_mensajes WHERE id=?', [r.insertId]);
  return m;
}
async function colaEspera() {
  const [rows] = await pool.query(
    "SELECT * FROM ar_conversaciones WHERE estado='ESPERA' ORDER BY created_at ASC");
  return rows;
}
async function activasDe(id_ejecutivo) {
  const [rows] = await pool.query(
    "SELECT * FROM ar_conversaciones WHERE estado='ACTIVA' AND id_ejecutivo=? ORDER BY asignada_at ASC", [id_ejecutivo]);
  return rows;
}
async function contarActivas(id_ejecutivo) {
  const [[{ n }]] = await pool.query(
    "SELECT COUNT(*) n FROM ar_conversaciones WHERE estado='ACTIVA' AND id_ejecutivo=?", [id_ejecutivo]);
  return n;
}

/* ── Middlewares de auth ─────────────────────────────────────────────────── */
const rawToken = (req) => {
  const h = req.headers.authorization;
  return (h && h.startsWith('Bearer ')) ? h.split(' ')[1] : req.query.token;
};
const verifyDealer = (req, res, next) => {
  try {
    const d = jwt.verify(rawToken(req), JWT_SECRET);
    if (d.tipo !== 'dealer') throw new Error('no-dealer');
    req.dealer = d; next();
  } catch { res.status(401).json({ success: false, data: null, error: 'Token inválido o expirado' }); }
};
const verifyAny = (req, res, next) => {
  try {
    const d = jwt.verify(rawToken(req), JWT_SECRET);
    req.auth = d; req.esDealer = d.tipo === 'dealer'; next();
  } catch { res.status(401).json({ success: false, data: null, error: 'Token inválido o expirado' }); }
};

/* ── REST: dealer (cuentas + login + conversaciones) ─────────────────────── */
const dealerLogin = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ success: false, data: null, error: 'Email y contraseña requeridos' });
    const [[c]] = await pool.query('SELECT * FROM ar_dealer_cuentas WHERE email=? AND activo=1', [String(email).toLowerCase().trim()]);
    if (!c) return res.status(401).json({ success: false, data: null, error: 'Credenciales inválidas' });
    const ok = await bcrypt.compare(password, c.password_hash);
    if (!ok) return res.status(401).json({ success: false, data: null, error: 'Credenciales inválidas' });
    await pool.query('UPDATE ar_dealer_cuentas SET ultimo_acceso=NOW() WHERE id=?', [c.id]);
    const payload = { tipo: 'dealer', id_cuenta: c.id, id_dealer: c.id_dealer, rut: c.rut, nombre: c.nombre, email: c.email };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    const cfg = await getCfg().catch(() => ({}));
    res.json({ success: true, data: { token, dealer: { id_dealer: c.id_dealer, rut: c.rut, nombre: c.nombre, email: c.email }, bienvenida: cfg.mensaje_bienvenida || '' }, error: null });
  } catch (e) { errSrv(res, e, 'dealerLogin'); }
};

const listarCuentas = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT c.id, c.id_dealer, c.rut, c.nombre, c.email, c.activo, c.ultimo_acceso, c.created_at,
              d.nombre_indexa AS dealer_nombre
       FROM ar_dealer_cuentas c LEFT JOIN dealers d ON d.id_dealer=c.id_dealer
       ORDER BY c.created_at DESC`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { errSrv(res, e, 'listarCuentas'); }
};

const crearCuenta = async (req, res) => {
  try {
    let { id_dealer, email, password, nombre, rut } = req.body || {};
    email = String(email || '').toLowerCase().trim();
    if (!email || !password) return res.status(400).json({ success: false, data: null, error: 'Email y contraseña requeridos' });
    if (String(password).length < 6) return res.status(400).json({ success: false, data: null, error: 'La contraseña debe tener al menos 6 caracteres' });
    if (id_dealer) {
      const [[d]] = await pool.query('SELECT rut, nombre_indexa, nombre_razon FROM dealers WHERE id_dealer=?', [id_dealer]);
      if (d) { rut = rut || d.rut; nombre = nombre || d.nombre_razon || d.nombre_indexa; }
    }
    const [[dup]] = await pool.query('SELECT id FROM ar_dealer_cuentas WHERE email=?', [email]);
    if (dup) return res.status(409).json({ success: false, data: null, error: 'Ya existe una cuenta con ese email' });
    const hash = await bcrypt.hash(String(password), 10);
    const [r] = await pool.query(
      `INSERT INTO ar_dealer_cuentas (id_dealer, rut, nombre, email, password_hash, creado_por)
       VALUES (?,?,?,?,?,?)`,
      [id_dealer || null, rut || null, nombre || null, email, hash, req.usuario.id_usuario]);
    auditar({ req, accion: 'CREAR', modulo: 'atencion-remota', entidad: 'dealer_cuenta', entidad_id: r.insertId, detalle: `Creó cuenta de portal para dealer ${nombre || email}`, rut });
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { errSrv(res, e, 'crearCuenta'); }
};

const actualizarCuenta = async (req, res) => {
  try {
    const { activo, password } = req.body || {};
    if (password !== undefined && password !== null && password !== '') {
      if (String(password).length < 6) return res.status(400).json({ success: false, data: null, error: 'La contraseña debe tener al menos 6 caracteres' });
      const hash = await bcrypt.hash(String(password), 10);
      await pool.query('UPDATE ar_dealer_cuentas SET password_hash=? WHERE id=?', [hash, req.params.id]);
    }
    if (activo !== undefined) await pool.query('UPDATE ar_dealer_cuentas SET activo=? WHERE id=?', [activo ? 1 : 0, req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'atencion-remota', entidad: 'dealer_cuenta', entidad_id: req.params.id, detalle: `Actualizó cuenta de portal #${req.params.id}${password ? ' (reset clave)' : ''}` });
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) { errSrv(res, e, 'actualizarCuenta'); }
};

/* ── REST: ejecutivo (cola, conversaciones, historial) ───────────────────── */
const getCola = async (req, res) => {
  try {
    const cfg = await getCfg();
    const espera = await colaEspera();
    const activas = await activasDe(req.usuario.id_usuario);
    res.json({ success: true, data: { espera, activas, max_chats: cfg.max_chats }, error: null });
  } catch (e) { errSrv(res, e, 'getCola'); }
};

const getMensajes = async (req, res) => {
  try {
    // verifyAny: un dealer sólo ve su conversación; un ejecutivo ve cualquiera.
    const conv = await getConversacion(req.params.id);
    if (!conv) return res.status(404).json({ success: false, data: null, error: 'Conversación no encontrada' });
    if (req.esDealer && conv.id_cuenta !== req.auth.id_cuenta)
      return res.status(403).json({ success: false, data: null, error: 'Sin acceso a esta conversación' });
    const [rows] = await pool.query('SELECT * FROM ar_mensajes WHERE id_conversacion=? ORDER BY id ASC', [req.params.id]);
    res.json({ success: true, data: { conversacion: conv, mensajes: rows }, error: null });
  } catch (e) { errSrv(res, e, 'getMensajes'); }
};

/* ── REST: ICE config (cualquiera autenticado, user o dealer) ────────────── */
const getIce = async (req, res) => {
  try { res.json({ success: true, data: { iceServers: buildIce(await getCfg()) }, error: null }); }
  catch (e) { errSrv(res, e, 'getIce'); }
};

/* ── REST: configuración del módulo (mantenedor) ─────────────────────────── */
const getConfig = async (req, res) => {
  try { res.json({ success: true, data: await getCfg(), error: null }); }
  catch (e) { errSrv(res, e, 'getConfig'); }
};
const putConfig = async (req, res) => {
  try {
    const b = req.body || {};
    await pool.query(
      `UPDATE ar_config SET max_chats=?, mensaje_bienvenida=?, horario_inicio=?, horario_fin=?,
        stun_urls=?, turn_url=?, turn_username=?, turn_credential=? WHERE id=1`,
      [parseInt(b.max_chats) || 3, b.mensaje_bienvenida || null, b.horario_inicio || null, b.horario_fin || null,
       b.stun_urls || null, b.turn_url || null, b.turn_username || null, b.turn_credential || null]);
    auditar({ req, accion: 'EDITAR', modulo: 'atencion-remota', entidad: 'config', detalle: `Actualizó configuración de Atención Remota (máx ${b.max_chats} chats)` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { errSrv(res, e, 'putConfig'); }
};

/* ── REST: adjuntos (documentos escaneados) ──────────────────────────────── */
const subirAdjunto = async (req, res) => {
  try {
    const conv = await getConversacion(req.params.id);
    if (!conv) return res.status(404).json({ success: false, data: null, error: 'Conversación no encontrada' });
    if (req.esDealer && conv.id_cuenta !== req.auth.id_cuenta)
      return res.status(403).json({ success: false, data: null, error: 'Sin acceso a esta conversación' });
    const { nombre, mime, data_base64 } = req.body || {};
    if (!data_base64) return res.status(400).json({ success: false, data: null, error: 'Archivo requerido' });
    const buf = Buffer.from(String(data_base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) return res.status(400).json({ success: false, data: null, error: 'Archivo vacío' });
    if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ success: false, data: null, error: 'Máximo 8 MB por archivo' });
    const quien = req.esDealer ? 'DEALER' : 'EJECUTIVO';
    const quienId = req.esDealer ? req.auth.id_cuenta : req.auth.id_usuario;
    const [r] = await pool.query(
      `INSERT INTO ar_adjuntos (id_conversacion, nombre, mime, tamano, data, subido_por, subido_id)
       VALUES (?,?,?,?,?,?,?)`,
      [conv.id, nombre || 'documento', mime || 'application/octet-stream', buf.length, buf, quien, quienId]);
    const m = await persistMensaje({
      id_conversacion: conv.id, emisor: quien,
      id_usuario: req.esDealer ? null : req.auth.id_usuario,
      autor_nombre: req.esDealer ? (req.auth.nombre || 'Dealer') : (req.auth.nombre || 'Ejecutivo'),
      cuerpo: nombre || 'documento', tipo: 'ARCHIVO', id_adjunto: r.insertId });
    try { require('../ws').relayMensaje(conv.id, m); } catch (_) {}
    res.status(201).json({ success: true, data: { id_adjunto: r.insertId, mensaje: m }, error: null });
  } catch (e) { errSrv(res, e, 'subirAdjunto'); }
};

const descargarAdjunto = async (req, res) => {
  try {
    const [[a]] = await pool.query('SELECT * FROM ar_adjuntos WHERE id=?', [req.params.id]);
    if (!a) return res.status(404).json({ success: false, data: null, error: 'Adjunto no encontrado' });
    if (req.esDealer) {
      const conv = await getConversacion(a.id_conversacion);
      if (!conv || conv.id_cuenta !== req.auth.id_cuenta)
        return res.status(403).json({ success: false, data: null, error: 'Sin acceso' });
    }
    res.setHeader('Content-Type', a.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(a.nombre || 'documento')}"`);
    res.send(a.data);
  } catch (e) { errSrv(res, e, 'descargarAdjunto'); }
};

/* ── REST: respuestas rápidas del chat ───────────────────────────────────── */
const listarRespuestas = async (req, res) => {
  try { const [rows] = await pool.query('SELECT id, titulo, texto FROM ar_respuestas_rapidas WHERE activo=1 ORDER BY orden, id'); res.json({ success:true, data:rows, error:null }); }
  catch (e) { errSrv(res, e, 'listarRespuestas'); }
};
const listarRespuestasAdmin = async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM ar_respuestas_rapidas ORDER BY orden, id'); res.json({ success:true, data:rows, error:null }); }
  catch (e) { errSrv(res, e, 'listarRespuestasAdmin'); }
};
const crearRespuesta = async (req, res) => {
  try {
    const { titulo, texto, orden } = req.body || {};
    if (!titulo || !texto) return res.status(400).json({ success:false, data:null, error:'Título y texto requeridos' });
    const [r] = await pool.query('INSERT INTO ar_respuestas_rapidas (titulo, texto, orden) VALUES (?,?,?)', [String(titulo).slice(0,80), texto, parseInt(orden)||0]);
    auditar({ req, accion:'CREAR', modulo:'atencion-remota', entidad:'respuesta_rapida', entidad_id:r.insertId, detalle:`Creó respuesta rápida "${titulo}"` });
    res.status(201).json({ success:true, data:{ id:r.insertId }, error:null });
  } catch (e) { errSrv(res, e, 'crearRespuesta'); }
};
const actualizarRespuesta = async (req, res) => {
  try {
    const { titulo, texto, orden, activo } = req.body || {};
    await pool.query('UPDATE ar_respuestas_rapidas SET titulo=?, texto=?, orden=?, activo=? WHERE id=?',
      [String(titulo||'').slice(0,80), texto||'', parseInt(orden)||0, activo?1:0, req.params.id]);
    auditar({ req, accion:'EDITAR', modulo:'atencion-remota', entidad:'respuesta_rapida', entidad_id:req.params.id, detalle:`Editó respuesta rápida "${titulo}"` });
    res.json({ success:true, data:{ id:req.params.id }, error:null });
  } catch (e) { errSrv(res, e, 'actualizarRespuesta'); }
};
const eliminarRespuesta = async (req, res) => {
  try {
    await pool.query('DELETE FROM ar_respuestas_rapidas WHERE id=?', [req.params.id]);
    auditar({ req, accion:'ELIMINAR', modulo:'atencion-remota', entidad:'respuesta_rapida', entidad_id:req.params.id, detalle:`Eliminó respuesta rápida #${req.params.id}` });
    res.json({ success:true, data:{ ok:true }, error:null });
  } catch (e) { errSrv(res, e, 'eliminarRespuesta'); }
};

/* ── REST: solicitudes de cuenta (autoregistro del dealer) ───────────────── */
const solicitarCuenta = async (req, res) => {
  try {
    let { rut, razon_social, direccion, telefono, contacto, email } = req.body || {};
    rut = String(rut || '').trim();
    razon_social = String(razon_social || '').trim();
    email = String(email || '').toLowerCase().trim();
    if (!rut || !razon_social || !email)
      return res.status(400).json({ success:false, data:null, error:'RUT, Razón Social y Email son obligatorios' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      return res.status(400).json({ success:false, data:null, error:'Email inválido' });
    const [[ctaDup]] = await pool.query('SELECT id FROM ar_dealer_cuentas WHERE email=?', [email]);
    if (ctaDup) return res.status(409).json({ success:false, data:null, error:'Ya existe una cuenta con ese email. Intenta iniciar sesión.' });
    const [[solDup]] = await pool.query("SELECT id FROM ar_solicitudes_cuenta WHERE email=? AND estado='PENDIENTE'", [email]);
    if (solDup) return res.status(409).json({ success:false, data:null, error:'Ya tienes una solicitud pendiente con ese email.' });
    const [r] = await pool.query(
      `INSERT INTO ar_solicitudes_cuenta (rut, razon_social, direccion, telefono, contacto, email)
       VALUES (?,?,?,?,?,?)`,
      [rut, razon_social, direccion || null, telefono || null, contacto || null, email]);
    // Avisar a Administradores y ejecutivos con acceso a Atención Remota.
    try {
      const [us] = await pool.query(
        `SELECT DISTINCT u.id_usuario FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
         LEFT JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil
         LEFT JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad AND f.codigo='atencion_remota'
         WHERE u.estado='activo' AND (p.nombre='Administrador' OR (pp.habilitado=1 AND f.codigo='atencion_remota'))`);
      await notificar(us.map(x => x.id_usuario), {
        tipo:'atencion', titulo:'Nueva solicitud de cuenta dealer',
        mensaje:`${razon_social} (${rut}) solicitó acceso al portal`,
        href:'/atencion-remota/?tab=solicitudes', prioridad:'media', clave:'ar_sol_' + r.insertId });
    } catch (_) {}
    res.status(201).json({ success:true, data:{ id:r.insertId }, error:null });
  } catch (e) { errSrv(res, e, 'solicitarCuenta'); }
};

const listarSolicitudes = async (req, res) => {
  try {
    const estado = (req.query.estado || 'PENDIENTE').toUpperCase();
    const [rows] = await pool.query('SELECT * FROM ar_solicitudes_cuenta WHERE estado=? ORDER BY created_at DESC', [estado]);
    res.json({ success:true, data:rows, error:null });
  } catch (e) { errSrv(res, e, 'listarSolicitudes'); }
};

const aprobarSolicitud = async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 6)
      return res.status(400).json({ success:false, data:null, error:'Define una contraseña para la cuenta (mínimo 6)' });
    const [[s]] = await pool.query('SELECT * FROM ar_solicitudes_cuenta WHERE id=?', [req.params.id]);
    if (!s) return res.status(404).json({ success:false, data:null, error:'Solicitud no encontrada' });
    if (s.estado !== 'PENDIENTE') return res.status(400).json({ success:false, data:null, error:'La solicitud ya fue procesada' });
    const [[ctaDup]] = await pool.query('SELECT id FROM ar_dealer_cuentas WHERE email=?', [s.email]);
    if (ctaDup) return res.status(409).json({ success:false, data:null, error:'Ya existe una cuenta con ese email' });
    let id_dealer = null;
    try {
      const [[d]] = await pool.query(
        "SELECT id_dealer FROM dealers WHERE REPLACE(REPLACE(REPLACE(UPPER(rut),'.',''),'-',''),' ','')=? LIMIT 1", [normRut(s.rut)]);
      if (d) id_dealer = d.id_dealer;
    } catch (_) {}
    const hash = await bcrypt.hash(String(password), 10);
    const [c] = await pool.query(
      `INSERT INTO ar_dealer_cuentas (id_dealer, rut, nombre, email, password_hash, creado_por)
       VALUES (?,?,?,?,?,?)`,
      [id_dealer, s.rut, s.razon_social, s.email, hash, req.usuario.id_usuario]);
    await pool.query("UPDATE ar_solicitudes_cuenta SET estado='APROBADA', procesada_by=?, procesada_at=NOW() WHERE id=?",
      [req.usuario.id_usuario, req.params.id]);
    auditar({ req, accion:'APROBAR', modulo:'atencion-remota', entidad:'solicitud_cuenta', entidad_id:req.params.id,
      detalle:`Aprobó la solicitud de ${s.razon_social} (${s.rut}) y creó la cuenta ${s.email}`, rut:s.rut });
    res.json({ success:true, data:{ id_cuenta:c.insertId, email:s.email }, error:null });
  } catch (e) { errSrv(res, e, 'aprobarSolicitud'); }
};

const rechazarSolicitud = async (req, res) => {
  try {
    const [[s]] = await pool.query('SELECT estado FROM ar_solicitudes_cuenta WHERE id=?', [req.params.id]);
    if (!s) return res.status(404).json({ success:false, data:null, error:'Solicitud no encontrada' });
    await pool.query("UPDATE ar_solicitudes_cuenta SET estado='RECHAZADA', nota=?, procesada_by=?, procesada_at=NOW() WHERE id=?",
      [String(req.body?.nota || '').slice(0, 300) || null, req.usuario.id_usuario, req.params.id]);
    auditar({ req, accion:'RECHAZAR', modulo:'atencion-remota', entidad:'solicitud_cuenta', entidad_id:req.params.id,
      detalle:`Rechazó la solicitud de cuenta #${req.params.id}` });
    res.json({ success:true, data:{ ok:true }, error:null });
  } catch (e) { errSrv(res, e, 'rechazarSolicitud'); }
};

/* ── REST: interlocutor de la conversación + historial por dealer ────────── */
const setInterlocutor = async (req, res) => {
  try {
    const nombre = String(req.body?.nombre || '').trim().slice(0, 150);
    await pool.query('UPDATE ar_conversaciones SET interlocutor=? WHERE id=?', [nombre || null, req.params.id]);
    auditar({ req, accion:'EDITAR', modulo:'atencion-remota', entidad:'conversacion', entidad_id:req.params.id,
      detalle:`Asignó interlocutor "${nombre}" a la conversación #${req.params.id}` });
    res.json({ success:true, data:{ nombre }, error:null });
  } catch (e) { errSrv(res, e, 'setInterlocutor'); }
};

// Historial de interlocutores del dealer (por cuenta) con N° de conversaciones.
const interlocutoresDe = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT interlocutor AS nombre, COUNT(*) AS veces, MAX(created_at) AS ultima
       FROM ar_conversaciones
       WHERE id_cuenta=? AND interlocutor IS NOT NULL AND interlocutor <> ''
       GROUP BY interlocutor ORDER BY veces DESC, ultima DESC`, [req.params.idCuenta]);
    res.json({ success:true, data:rows, error:null });
  } catch (e) { errSrv(res, e, 'interlocutoresDe'); }
};

module.exports = {
  // middlewares
  verifyDealer, verifyAny,
  // dealer
  dealerLogin, listarCuentas, crearCuenta, actualizarCuenta,
  // ejecutivo
  getCola, getMensajes,
  // comunes
  getIce, getConfig, putConfig, subirAdjunto, descargarAdjunto,
  // respuestas rápidas
  listarRespuestas, listarRespuestasAdmin, crearRespuesta, actualizarRespuesta, eliminarRespuesta,
  // solicitudes de cuenta (autoregistro)
  solicitarCuenta, listarSolicitudes, aprobarSolicitud, rechazarSolicitud,
  // interlocutores
  setInterlocutor, interlocutoresDe,
  // service helpers (ws.js)
  buildIce, getCfg, crearConversacion, getConversacion, asignarConversacion,
  cerrarConversacion, persistMensaje, colaEspera, activasDe, contarActivas,
};
