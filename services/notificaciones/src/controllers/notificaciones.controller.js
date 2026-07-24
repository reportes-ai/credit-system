'use strict';
const pool = require('../../../../shared/config/database');

let webpush = null;
try { webpush = require('web-push'); }
catch (e) { console.error('[notif] web-push no instalado — solo notificaciones in-app'); }

/* ── Migración ───────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('notificaciones', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_config (
        clave VARCHAR(50) PRIMARY KEY,
        valor TEXT NOT NULL
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_suscripciones (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario INT NOT NULL,
        endpoint   VARCHAR(500) NOT NULL,
        claves     TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_endpoint (endpoint(255)),
        INDEX idx_usuario (id_usuario)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notificaciones (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario INT NOT NULL,
        tipo       VARCHAR(40) DEFAULT NULL,
        titulo     VARCHAR(200) NOT NULL,
        mensaje    TEXT,
        href       VARCHAR(300) DEFAULT NULL,
        leida      TINYINT(1) NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_usuario_leida (id_usuario, leida),
        INDEX idx_created (created_at)
      )
    `);
    // Avisos en Línea (Soporte): mensaje broadcast a todos los conectados
    await pool.query(`
      CREATE TABLE IF NOT EXISTS avisos_linea (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        mensaje      TEXT NOT NULL,
        sonido       VARCHAR(20) NOT NULL DEFAULT 'anuncio',
        retardo_seg  INT NOT NULL DEFAULT 0,
        duracion_seg INT NOT NULL DEFAULT 20,
        id_usuario   INT DEFAULT NULL,
        autor        VARCHAR(120) DEFAULT NULL,
        created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_created (created_at)
      )
    `);
    // Card en Soporte + permiso para administradores (asignable a otros perfiles en Usuarios)
    await pool.query(`INSERT IGNORE INTO funcionalidades (id_funcionalidad, id_modulo, nombre, codigo, href, icono)
                      VALUES (4960001, 500001, 'Avisos en Línea', 'avisos_linea', '/soporte/avisos/', 'bi-megaphone')`);
    for (const idPerfil of [1, 210001]) {
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT ?, 4960001, 1 FROM DUAL
                        WHERE NOT EXISTS (SELECT 1 FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=4960001)`,
                       [idPerfil, idPerfil]).catch(() => {});
    }
    console.log('[notif] tablas OK');
  } catch (e) { console.error('[notif migration]', e.message); }
});

/* ── VAPID: se genera una vez y queda en BD ─────────────────────── */
let VAPID = null;
async function initVapid() {
  if (!webpush) return;
  try {
    const [rows] = await pool.query('SELECT clave, valor FROM push_config');
    const cfg = {};
    rows.forEach(r => cfg[r.clave] = r.valor);
    if (!cfg.vapid_public || !cfg.vapid_private) {
      const keys = webpush.generateVAPIDKeys();
      await pool.query('INSERT IGNORE INTO push_config (clave, valor) VALUES (?,?),(?,?)',
        ['vapid_public', keys.publicKey, 'vapid_private', keys.privateKey]);
      cfg.vapid_public = keys.publicKey;
      cfg.vapid_private = keys.privateKey;
      console.log('[notif] claves VAPID generadas');
    }
    webpush.setVapidDetails('mailto:soporte@autofacilchile.cl', cfg.vapid_public, cfg.vapid_private);
    VAPID = { publicKey: cfg.vapid_public };
    console.log('✓ Notificaciones push listas');
  } catch (e) { console.error('[notif vapid]', e.message); }
}
setTimeout(initVapid, 3000);

/* ── Núcleo: notificar a una lista de usuarios ───────────────────
   Inserta la notificación in-app y envía web push a sus dispositivos. */
async function notificar(idUsuarios, { tipo, titulo, mensaje, href, prioridad, sonar, son_tipo, son_cada, son_max, clave } = {}) {
  let ids = [...new Set((idUsuarios || []).filter(Boolean))];
  if (!ids.length) return;
  // Suplencias: agrega a los suplentes activos (categoría Alertas) de cada destinatario.
  try { ids = await require('../../../../shared/backups').expandirAlerta(ids); } catch (_) {}
  // Sonido/prioridad opcionales (compatibles hacia atrás): si no se pasan, usan los
  // defaults de la campana (sonar=1, campana, normal).
  const prio = prioridad === 'alta' ? 'alta' : 'normal';
  const son  = sonar === 0 || sonar === false ? 0 : 1;
  const sTipo = son_tipo || 'campana';
  const sCada = Math.max(5, parseInt(son_cada) || 30);
  const sMax  = Math.max(1, parseInt(son_max) || 5);
  // clave: agrupa avisos del mismo evento (p.ej. un pool); permite anularlos de golpe
  // para el resto cuando alguien lo toma (DELETE ... WHERE clave = ?).
  try {
    for (const id of ids) {
      await pool.query(
        `INSERT INTO notificaciones (id_usuario, tipo, titulo, mensaje, href, prioridad, sonar, son_cada, son_max, son_tipo, clave)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, tipo || null, titulo, mensaje || null, href || null, prio, son, sCada, sMax, sTipo, clave || null]
      );
    }
  } catch (e) { console.error('[notif insert]', e.message); }

  if (!webpush || !VAPID) return;
  try {
    const [subs] = await pool.query(
      'SELECT id, endpoint, claves FROM push_suscripciones WHERE id_usuario IN (?)', [ids]
    );
    const payload = JSON.stringify({ titulo, mensaje, href });
    for (const s of subs) {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: JSON.parse(s.claves) }, payload);
      } catch (e) {
        // Suscripción muerta (navegador desinstalado/permiso revocado) → limpiar
        if (e.statusCode === 404 || e.statusCode === 410)
          await pool.query('DELETE FROM push_suscripciones WHERE id = ?', [s.id]).catch(() => {});
      }
    }
  } catch (e) { console.error('[notif push]', e.message); }
}

/* ── Endpoints ───────────────────────────────────────────────────── */
const getVapidKey = async (req, res) => {
  // Carrera de arranque: si piden la clave antes del init diferido (3s post-boot),
  // inicializar a demanda en vez de responder 503 (gatillaba la alerta de errores).
  if (!VAPID) { try { await initVapid(); } catch (_) {} }
  if (!VAPID) return res.json({ success: false, data: null, error: 'Push no disponible' });
  res.json({ success: true, data: { publicKey: VAPID.publicKey }, error: null });
};

const subscribe = async (req, res) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys) return res.status(400).json({ success: false, data: null, error: 'Suscripción inválida' });
    await pool.query(
      `INSERT INTO push_suscripciones (id_usuario, endpoint, claves) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE id_usuario = VALUES(id_usuario), claves = VALUES(claves)`,
      [req.usuario.id_usuario, endpoint, JSON.stringify(keys)]
    );
    res.status(201).json({ success: true, data: { ok: true }, error: null });
  } catch (e) {
    console.error('[notif subscribe]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

const getMias = async (req, res) => {
  try {
    const id = req.usuario.id_usuario;
    const [rows] = await pool.query(
      'SELECT * FROM notificaciones WHERE id_usuario = ? ORDER BY created_at DESC LIMIT 30', [id]
    );
    const [[{ noLeidas }]] = await pool.query(
      'SELECT COUNT(*) AS noLeidas FROM notificaciones WHERE id_usuario = ? AND leida = 0', [id]
    );
    res.json({ success: true, data: { rows, noLeidas }, error: null });
  } catch (e) {
    console.error('[notif getMias]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

const marcarLeidas = async (req, res) => {
  try {
    await pool.query('UPDATE notificaciones SET leida = 1 WHERE id_usuario = ? AND leida = 0',
      [req.usuario.id_usuario]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

const borrarUna = async (req, res) => {
  try {
    await pool.query('DELETE FROM notificaciones WHERE id = ? AND id_usuario = ?',
      [req.params.id, req.usuario.id_usuario]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

const borrarTodas = async (req, res) => {
  try {
    await pool.query('DELETE FROM notificaciones WHERE id_usuario = ?', [req.usuario.id_usuario]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Avisos en Línea (Soporte): broadcast a todos los conectados ── */
const SONIDOS_AVISO = ['campana', 'dingdong', 'alarma', 'aplausos', 'anuncio'];

const enviarAviso = async (req, res) => {
  try {
    const mensaje = String(req.body?.mensaje || '').trim();
    if (!mensaje) return res.status(400).json({ success: false, data: null, error: 'El mensaje es obligatorio' });
    if (mensaje.length > 500) return res.status(400).json({ success: false, data: null, error: 'Máximo 500 caracteres' });
    const sonido  = SONIDOS_AVISO.includes(req.body?.sonido) ? req.body.sonido : 'anuncio';
    const retardo = Math.min(120, Math.max(0, parseInt(req.body?.retardo_seg) || 0));
    const duracion = Math.min(300, Math.max(5, parseInt(req.body?.duracion_seg) || 20));
    const autor = `${req.usuario?.nombre || ''} ${req.usuario?.apellido || ''}`.trim() || null;
    const [r] = await pool.query(
      'INSERT INTO avisos_linea (mensaje, sonido, retardo_seg, duracion_seg, id_usuario, autor) VALUES (?,?,?,?,?,?)',
      [mensaje, sonido, retardo, duracion, req.usuario.id_usuario, autor]
    );
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) {
    console.error('[aviso-linea enviar]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

// Avisos "vigentes" = de los últimos 10 minutos; el cliente descarta los ya mostrados.
const avisosVigentes = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, mensaje, sonido, retardo_seg, duracion_seg, autor, created_at
       FROM avisos_linea WHERE created_at >= NOW() - INTERVAL 10 MINUTE
       ORDER BY id DESC LIMIT 5`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

const avisosHistorial = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, mensaje, sonido, retardo_seg, duracion_seg, autor, created_at FROM avisos_linea ORDER BY id DESC LIMIT 30');
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { notificar, getVapidKey, subscribe, getMias, marcarLeidas, borrarUna, borrarTodas,
                   enviarAviso, avisosVigentes, avisosHistorial };
