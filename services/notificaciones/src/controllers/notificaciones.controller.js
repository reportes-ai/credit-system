'use strict';
const pool = require('../../../../shared/config/database');

let webpush = null;
try { webpush = require('web-push'); }
catch (e) { console.error('[notif] web-push no instalado — solo notificaciones in-app'); }

/* ── Migración ───────────────────────────────────────────────────── */
(async () => {
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
    console.log('[notif] tablas OK');
  } catch (e) { console.error('[notif migration]', e.message); }
})();

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
async function notificar(idUsuarios, { tipo, titulo, mensaje, href }) {
  const ids = [...new Set((idUsuarios || []).filter(Boolean))];
  if (!ids.length) return;
  try {
    for (const id of ids) {
      await pool.query(
        'INSERT INTO notificaciones (id_usuario, tipo, titulo, mensaje, href) VALUES (?,?,?,?,?)',
        [id, tipo || null, titulo, mensaje || null, href || null]
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
const getVapidKey = (req, res) => {
  if (!VAPID) return res.status(503).json({ success: false, data: null, error: 'Push no disponible aún' });
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

module.exports = { notificar, getVapidKey, subscribe, getMias, marcarLeidas };
