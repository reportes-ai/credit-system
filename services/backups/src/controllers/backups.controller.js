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
    await sembrarDefaults();
    console.log('[backups] tabla OK');
  } catch (e) { console.error('[backups migration]', e.message); }
})();

// Crea una fila por usuario vigente que aún no la tenga, con un suplente de la misma área (desactivado).
async function sembrarDefaults() {
  try {
    const [users] = await pool.query(
      "SELECT id_usuario, id_perfil FROM usuarios WHERE estado='activo' ORDER BY id_perfil, id_usuario");
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

/* ── Funcionalidades a las que accede un usuario (para el correo) ── */
async function funcionalidadesDe(idUsuario) {
  try {
    const [[u]] = await pool.query(
      'SELECT p.nombre perfil FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil WHERE u.id_usuario=?', [idUsuario]);
    if (u && u.perfil === 'Administrador') return ['(Todas las funciones — perfil Administrador)'];
    const [rows] = await pool.query(
      `SELECT DISTINCT f.nombre FROM funcionalidades f
         JOIN permisos_perfil pp ON pp.id_funcionalidad=f.id_funcionalidad AND pp.habilitado=1
         JOIN usuarios u ON u.id_perfil=pp.id_perfil
        WHERE u.id_usuario=? AND f.nombre IS NOT NULL AND f.nombre<>''
       UNION
       SELECT DISTINCT f.nombre FROM funcionalidades f
         JOIN permisos_usuario pu ON pu.id_funcionalidad=f.id_funcionalidad AND pu.habilitado=1
        WHERE pu.id_usuario=? AND f.nombre IS NOT NULL AND f.nombre<>''
       ORDER BY 1`, [idUsuario, idUsuario]);
    return rows.map(r => r.nombre);
  } catch (_) { return []; }
}

const nombreDe = async (id) => {
  try { const [[u]] = await pool.query('SELECT nombre, apellido, email FROM usuarios WHERE id_usuario=?', [id]); return u || null; }
  catch (_) { return null; }
};
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Avisa por correo al titular y al suplente del cambio de una categoría.
async function avisarCambio({ titular, suplente, catLabel, activado, funcs }) {
  if (!titular || !suplente) return;
  const nt = `${titular.nombre || ''} ${titular.apellido || ''}`.trim();
  const ns = `${suplente.nombre || ''} ${suplente.apellido || ''}`.trim();
  const verbo = activado ? 'activó' : 'desactivó';
  const listaFuncs = (funcs && funcs.length)
    ? `<div style="margin:12px 0 4px;font-weight:700;color:#0f172a">Funcionalidades involucradas:</div>
       <ul style="margin:0 0 8px 18px;padding:0;color:#334155;font-size:14px">${funcs.map(f => `<li>${esc(f)}</li>`).join('')}</ul>`
    : '';
  const cuerpoSup = `
    <p style="font-size:15px;color:#1e293b">Hola ${esc(ns)},</p>
    <p style="font-size:15px;color:#334155">Se <strong>${verbo}</strong> el respaldo de <strong>${esc(catLabel)}</strong> de <strong>${esc(nt)}</strong> hacia ti.</p>
    <p style="font-size:15px;color:#334155">${activado
      ? `A partir de ahora ${catLabel.includes('Funciones') ? 'tienes acceso a sus atribuciones' : catLabel.includes('Alertas') ? 'recibirás sus alertas en la campana' : 'recibirás copia de sus correos'} mientras el respaldo esté activo.`
      : `Ya no ${catLabel.includes('Funciones') ? 'tienes sus atribuciones' : catLabel.includes('Alertas') ? 'recibirás sus alertas' : 'recibirás copia de sus correos'}.`}</p>
    ${activado ? listaFuncs : ''}`;
  const cuerpoTit = `
    <p style="font-size:15px;color:#1e293b">Hola ${esc(nt)},</p>
    <p style="font-size:15px;color:#334155">Se <strong>${verbo}</strong> tu respaldo de <strong>${esc(catLabel)}</strong> hacia <strong>${esc(ns)}</strong>.</p>
    <p style="font-size:15px;color:#334155">${activado
      ? `${ns} ${catLabel.includes('Funciones') ? 'podrá usar tus atribuciones' : catLabel.includes('Alertas') ? 'recibirá tus alertas' : 'recibirá copia de tus correos'} mientras esté activo.`
      : 'El respaldo quedó suspendido.'}</p>
    ${activado ? listaFuncs : ''}`;
  const asunto = `Respaldo de ${catLabel} ${activado ? 'activado' : 'suspendido'} — AutoFácil`;
  try { if (suplente.email) await enviarCorreo({ to: suplente.email, subject: asunto, html: envolverHTML(cuerpoSup) }); } catch (_) {}
  try { if (titular.email) await enviarCorreo({ to: titular.email, subject: asunto, html: envolverHTML(cuerpoTit) }); } catch (_) {}
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
        WHERE u.estado='activo'
        ORDER BY p.nombre, nombre`);
    const [usuarios] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT(u.nombre,' ',COALESCE(u.apellido,''))) AS nombre, u.id_perfil, p.nombre AS perfil
         FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
        WHERE u.estado='activo' ORDER BY nombre`);
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

    // Avisos por correo de los cambios de categoría
    const titular = await nombreDe(idTit);
    const suplente = id_suplente ? await nombreDe(id_suplente) : null;
    const funcs = (nv.b_funciones && suplente) ? await funcionalidadesDe(idTit) : [];
    for (const cat of CATS) {
      const antes = old.id_suplente === id_suplente ? old[cat.key] : 0;  // si cambió el suplente, lo previo ya no aplica
      if (nv[cat.key] !== antes) {
        await avisarCambio({ titular, suplente, catLabel: cat.label, activado: nv[cat.key] === 1, funcs: cat.key === 'b_funciones' ? funcs : null });
      }
    }
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[backups guardar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { listar, guardar };
