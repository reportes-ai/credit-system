'use strict';
/* ════════════════════════════════════════════════════════════════
   BACKUPS / SUPLENCIAS — un titular es respaldado por un suplente.
   3 categorías independientes: Funciones (atribuciones), Alertas
   (campana) y Correos. Al activar/desactivar una categoría se avisa
   por correo al titular y al suplente. El enforcement vive en
   shared/backups.js (alertas/correos) y shared/middleware/permisos.js
   (funciones). Todo arranca DESACTIVADO.
   ════════════════════════════════════════════════════════════════ */
const pool = require('../../../../shared/config/database');
const { enviarCorreo, envolverHTML } = require('../../../../shared/mailer');

const CATS = [
  { key: 'b_funciones', label: 'Funciones (atribuciones)' },
  { key: 'b_alertas', label: 'Alertas (campana)' },
  { key: 'b_correos', label: 'Correos' },
];

/* ── Migración + seed de defaults (suplente de la misma área, desactivado) ── */
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS usuario_backups (
      id_titular  INT PRIMARY KEY,
      id_suplente INT DEFAULT NULL,
      b_funciones TINYINT(1) NOT NULL DEFAULT 0,
      b_alertas   TINYINT(1) NOT NULL DEFAULT 0,
      b_correos   TINYINT(1) NOT NULL DEFAULT 0,
      updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_suplente (id_suplente)
    )`);
    // Registrar el mantenedor en el menú (funcionalidad) si no existe
    const [[ex]] = await pool.query("SELECT 1 ok FROM funcionalidades WHERE codigo='mantenedores_backups' LIMIT 1");
    if (!ex) await pool.query(
      `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
       VALUES (30001, 'Backups del Sistema', 'mantenedores_backups', '/mantenedores/backups/', 'bi-people')`);
    // Cuentas protegidas (BG-ADMIN): nunca participan en backups — limpiar lo ya sembrado.
    await pool.query("DELETE FROM usuario_backups WHERE id_titular IN (SELECT id_usuario FROM usuarios WHERE protegido=1)").catch(() => {});
    await pool.query("UPDATE usuario_backups SET id_suplente=NULL, b_funciones=0, b_alertas=0, b_correos=0 WHERE id_suplente IN (SELECT id_usuario FROM usuarios WHERE protegido=1)").catch(() => {});
    await sembrarDefaults();
    console.log('[backups] tabla OK');
  } catch (e) { console.error('[backups migration]', e.message); }
})();

// Crea una fila por usuario vigente que aún no la tenga, con un suplente de la misma área (desactivado).
async function sembrarDefaults() {
  try {
    const [users] = await pool.query(
      "SELECT id_usuario, id_perfil FROM usuarios WHERE estado='activo' AND COALESCE(protegido,0)=0 ORDER BY id_perfil, id_usuario");
    const [yatiene] = await pool.query('SELECT id_titular FROM usuario_backups');
    const con = new Set(yatiene.map(r => r.id_titular));
    const porPerfil = {};
    users.forEach(u => { (porPerfil[u.id_perfil] = porPerfil[u.id_perfil] || []).push(u.id_usuario); });
    for (const u of users) {
      if (con.has(u.id_usuario)) continue;
      const peers = (porPerfil[u.id_perfil] || []).filter(id => id !== u.id_usuario);
      const suplente = peers.length ? peers[0] : null;
      await pool.query(
        'INSERT IGNORE INTO usuario_backups (id_titular, id_suplente, b_funciones, b_alertas, b_correos) VALUES (?,?,0,0,0)',
        [u.id_usuario, suplente]);
    }
  } catch (e) { console.error('[backups sembrarDefaults]', e.message); }
}

// Etiquetas de las categorías tal como van en el correo al suplente.
const CAT_MAIL = { b_alertas: 'Alertas', b_funciones: 'Funciones (atribuciones)', b_correos: 'Recepción Correos del Business Suite' };

const nombreDe = async (id) => {
  try { const [[u]] = await pool.query('SELECT nombre, apellido, email FROM usuarios WHERE id_usuario=?', [id]); return u || null; }
  catch (_) { return null; }
};
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Un SOLO correo al suplente al guardar: avisa qué Back Up se le designó (o se le suspendió).
async function avisarSuplente({ suplente, titularNombre, autorNombre, activeCats, activado }) {
  if (!suplente || !suplente.email) return;
  const ns = `${suplente.nombre || ''} ${suplente.apellido || ''}`.trim();
  let cuerpo;
  if (activado) {
    cuerpo = `
      <p style="font-size:15px;color:#1e293b">Estimado ${esc(ns)}:</p>
      <p style="font-size:15px;color:#334155">Por instrucciones de <strong>${esc(autorNombre)}</strong> se ha procedido a activar la funcionalidad de Back Up de <strong>${esc(titularNombre)}</strong>, por lo que las siguientes funcionalidades serán redirigidas a ti:</p>
      <ul style="font-size:15px;color:#334155;margin:6px 0 6px 18px;padding:0">${activeCats.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`;
  } else {
    cuerpo = `
      <p style="font-size:15px;color:#1e293b">Estimado ${esc(ns)}:</p>
      <p style="font-size:15px;color:#334155">Por instrucciones de <strong>${esc(autorNombre)}</strong> se ha suspendido la funcionalidad de Back Up de <strong>${esc(titularNombre)}</strong>. Ya no recibirás las funcionalidades que estaban redirigidas a ti.</p>`;
  }
  const asunto = activado ? 'Back Up Designado Activado' : 'Back Up Designado Suspendido';
  try { await enviarCorreo({ to: suplente.email, subject: asunto, html: envolverHTML(cuerpo) }); } catch (_) {}
}

/* ── Endpoints ── */
const esAdmin = req => req.usuario && req.usuario.perfil_nombre === 'Administrador';

const listar = async (req, res) => {
  try {
    const [filas] = await pool.query(
      `SELECT u.id_usuario AS id_titular,
              TRIM(CONCAT(u.nombre,' ',COALESCE(u.apellido,''))) AS nombre,
              u.id_perfil, p.nombre AS perfil,
              b.id_suplente, b.b_funciones, b.b_alertas, b.b_correos,
              TRIM(CONCAT(s.nombre,' ',COALESCE(s.apellido,''))) AS suplente_nombre
         FROM usuarios u
         JOIN perfiles p ON p.id_perfil = u.id_perfil
         LEFT JOIN usuario_backups b ON b.id_titular = u.id_usuario
         LEFT JOIN usuarios s ON s.id_usuario = b.id_suplente
        WHERE u.estado='activo' AND COALESCE(u.protegido,0)=0
        ORDER BY p.nombre, nombre`);
    const [usuarios] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT(u.nombre,' ',COALESCE(u.apellido,''))) AS nombre, u.id_perfil, p.nombre AS perfil
         FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
        WHERE u.estado='activo' AND COALESCE(u.protegido,0)=0 ORDER BY nombre`);
    res.json({ success: true, data: { filas, usuarios }, error: null });
  } catch (e) { console.error('[backups listar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const guardar = async (req, res) => {
  try {
    if (!esAdmin(req)) return res.status(403).json({ success: false, data: null, error: 'Solo Administrador puede configurar backups' });
    const idTit = parseInt(req.params.id_titular);
    if (!idTit) return res.status(400).json({ success: false, data: null, error: 'Titular inválido' });
    let { id_suplente, b_funciones, b_alertas, b_correos } = req.body || {};
    id_suplente = id_suplente ? parseInt(id_suplente) : null;
    const nv = { b_funciones: b_funciones ? 1 : 0, b_alertas: b_alertas ? 1 : 0, b_correos: b_correos ? 1 : 0 };
    if (id_suplente === idTit) return res.status(400).json({ success: false, data: null, error: 'El suplente no puede ser el mismo titular' });
    if (!id_suplente && (nv.b_funciones || nv.b_alertas || nv.b_correos))
      return res.status(400).json({ success: false, data: null, error: 'Asigna un suplente antes de activar un respaldo' });

    const [[prev]] = await pool.query('SELECT * FROM usuario_backups WHERE id_titular=?', [idTit]);
    const old = prev || { id_suplente: null, b_funciones: 0, b_alertas: 0, b_correos: 0 };

    await pool.query(
      `INSERT INTO usuario_backups (id_titular, id_suplente, b_funciones, b_alertas, b_correos) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE id_suplente=VALUES(id_suplente), b_funciones=VALUES(b_funciones), b_alertas=VALUES(b_alertas), b_correos=VALUES(b_correos)`,
      [idTit, id_suplente, nv.b_funciones, nv.b_alertas, nv.b_correos]);

    // Invalida el caché de permisos (las funciones heredadas cambian)
    try { require('../../../../shared/middleware/permisos').limpiarCachePermisos(); } catch (_) {}

    // Un solo correo al suplente, al guardar, si hubo algún cambio de categoría.
    let cambio = false;
    for (const cat of CATS) {
      const antes = old.id_suplente === id_suplente ? old[cat.key] : 0;  // si cambió el suplente, lo previo ya no aplica
      if (nv[cat.key] !== antes) cambio = true;
    }
    if (cambio && id_suplente) {
      const titular = await nombreDe(idTit);
      const suplente = await nombreDe(id_suplente);
      const activeCats = ['b_alertas', 'b_funciones', 'b_correos'].filter(k => nv[k] === 1).map(k => CAT_MAIL[k]);
      const autorNombre = `${(req.usuario.nombre || '')} ${(req.usuario.apellido || '')}`.trim() || 'la Administración';
      const titularNombre = titular ? `${titular.nombre || ''} ${titular.apellido || ''}`.trim() : '';
      await avisarSuplente({ suplente, titularNombre, autorNombre, activeCats, activado: activeCats.length > 0 });
    }
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[backups guardar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { listar, guardar };
