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
require('../../../../shared/migrate').enFila('backups', async () => {
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
    // Periodos de backup (para la pestaña BackUps de Auditoría): desde/hasta de cada vigencia.
    await pool.query(`CREATE TABLE IF NOT EXISTS backup_periodos (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      id_titular   INT NOT NULL,
      id_suplente  INT DEFAULT NULL,
      categorias   VARCHAR(120) DEFAULT NULL,
      desde        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      hasta        DATETIME DEFAULT NULL,
      activado_por VARCHAR(200) DEFAULT NULL,
      INDEX idx_titular (id_titular), INDEX idx_abierto (hasta)
    )`);
    /* Back Up PROGRAMADO por vacaciones (Pato, 08-09-2026): al aprobarse una solicitud
       de vacaciones se agenda que el suplente del titular asuma TODAS las funciones
       (funciones + alertas + correos) desde el primer día hasta el último; el motor
       backups-vacaciones lo activa y lo desactiva solo, con correo en ambos hitos, y
       al cerrar restaura las categorías que el titular tenía antes (prev_json). */
    await pool.query(`CREATE TABLE IF NOT EXISTS backup_programados (
      id           BIGINT AUTO_INCREMENT PRIMARY KEY,
      id_titular   INT NOT NULL,
      id_suplente  INT DEFAULT NULL,
      desde        DATE NOT NULL,
      hasta        DATE NOT NULL,
      origen       VARCHAR(20) NOT NULL DEFAULT 'VACACIONES',
      ref_id       INT DEFAULT NULL,
      estado       VARCHAR(12) NOT NULL DEFAULT 'PROGRAMADO',   -- PROGRAMADO | ACTIVO | CERRADO | CANCELADO | SIN_SUPLENTE
      prev_json    VARCHAR(300) DEFAULT NULL,
      activado_at  DATETIME DEFAULT NULL,
      cerrado_at   DATETIME DEFAULT NULL,
      created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_estado (estado, desde, hasta), INDEX idx_titular (id_titular), UNIQUE KEY uq_origen (origen, ref_id)
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
});

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
  try { const [[u]] = await pool.query('SELECT nombre, apellido, email, sexo FROM usuarios WHERE id_usuario=?', [id]); return u || null; }
  catch (_) { return null; }
};
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Un SOLO correo al suplente al guardar: avisa qué Back Up se le designó (o se le suspendió).
async function avisarSuplente({ suplente, titular, titularNombre, autorNombre, activeCats, activado, motivo = '' }) {
  if (!suplente || !suplente.email) return;
  const porQue = motivo ? ` (${esc(motivo)})` : '';
  const ns = `${suplente.nombre || ''} ${suplente.apellido || ''}`.trim();
  const trato = require('../../../../shared/genero').estimado(suplente.sexo);
  let cuerpo;
  if (activado) {
    cuerpo = `
      <p style="font-size:15px;color:#1e293b">${trato} ${esc(ns)}:</p>
      <p style="font-size:15px;color:#334155">Por instrucciones de <strong>${esc(autorNombre)}</strong>${porQue} se ha procedido a activar la funcionalidad de Back Up de <strong>${esc(titularNombre)}</strong>, por lo que las siguientes funcionalidades serán redirigidas a ti:</p>
      <ul style="font-size:15px;color:#334155;margin:6px 0 6px 18px;padding:0">${activeCats.map(c => `<li>${esc(c)}</li>`).join('')}</ul>`;
  } else {
    cuerpo = `
      <p style="font-size:15px;color:#1e293b">${trato} ${esc(ns)}:</p>
      <p style="font-size:15px;color:#334155">Por instrucciones de <strong>${esc(autorNombre)}</strong>${porQue} se ha suspendido la funcionalidad de Back Up de <strong>${esc(titularNombre)}</strong>. Ya no recibirás las funcionalidades que estaban redirigidas a ti.</p>`;
  }
  const asunto = activado ? 'Back Up Designado Activado' : 'Back Up Designado Desactivado';
  // Copia al titular: sabe quién lo cubre y cuándo termina (Pato, 08-09-2026).
  const cc = titular && titular.email && titular.email !== suplente.email ? titular.email : undefined;
  try { await enviarCorreo({ to: suplente.email, cc, subject: asunto, html: envolverHTML(cuerpo) }); } catch (_) {}
}

/* ── MOTOR ÚNICO: aplicar un estado de backup a un titular ─────────────────────
   Escribe usuario_backups, invalida permisos, abre/cierra el período (Auditoría →
   BackUps) y manda UN correo al suplente con copia al titular cuando cambia algo.
   Lo usan el mantenedor (Administrador) y el motor de vacaciones. */
async function aplicarBackup(idTit, { id_suplente, b_funciones, b_alertas, b_correos }, autorNombre, { motivo = '' } = {}) {
  const nv = { b_funciones: b_funciones ? 1 : 0, b_alertas: b_alertas ? 1 : 0, b_correos: b_correos ? 1 : 0 };
  const [[prev]] = await pool.query('SELECT * FROM usuario_backups WHERE id_titular=?', [idTit]);
  const old = prev || { id_suplente: null, b_funciones: 0, b_alertas: 0, b_correos: 0 };
  await pool.query(
    `INSERT INTO usuario_backups (id_titular, id_suplente, b_funciones, b_alertas, b_correos) VALUES (?,?,?,?,?)
     ON DUPLICATE KEY UPDATE id_suplente=VALUES(id_suplente), b_funciones=VALUES(b_funciones), b_alertas=VALUES(b_alertas), b_correos=VALUES(b_correos)`,
    [idTit, id_suplente || null, nv.b_funciones, nv.b_alertas, nv.b_correos]);
  try { require('../../../../shared/middleware/permisos').limpiarCachePermisos(); } catch (_) {}
  const wasActive = !!(old.id_suplente && (old.b_funciones || old.b_alertas || old.b_correos));
  const nowActive = !!(id_suplente && (nv.b_funciones || nv.b_alertas || nv.b_correos));
  const activeCats = ['b_alertas', 'b_funciones', 'b_correos'].filter(k => nv[k] === 1).map(k => CAT_MAIL[k]);
  const catsCsv = activeCats.join(', ');
  try {
    if (!wasActive && nowActive) {
      await pool.query('INSERT INTO backup_periodos (id_titular, id_suplente, categorias, activado_por) VALUES (?,?,?,?)', [idTit, id_suplente, catsCsv, autorNombre]);
    } else if (wasActive && !nowActive) {
      await pool.query('UPDATE backup_periodos SET hasta=NOW() WHERE id_titular=? AND hasta IS NULL', [idTit]);
    } else if (wasActive && nowActive) {
      if (old.id_suplente !== id_suplente) {
        await pool.query('UPDATE backup_periodos SET hasta=NOW() WHERE id_titular=? AND hasta IS NULL', [idTit]);
        await pool.query('INSERT INTO backup_periodos (id_titular, id_suplente, categorias, activado_por) VALUES (?,?,?,?)', [idTit, id_suplente, catsCsv, autorNombre]);
      } else {
        await pool.query('UPDATE backup_periodos SET categorias=? WHERE id_titular=? AND hasta IS NULL', [catsCsv, idTit]);
      }
    }
  } catch (_) {}
  let cambio = false;
  for (const cat of CATS) {
    const antes = old.id_suplente === id_suplente ? old[cat.key] : 0;
    if (nv[cat.key] !== antes) cambio = true;
  }
  const idSupMail = id_suplente || old.id_suplente;
  if (cambio && idSupMail) {
    const titular = await nombreDe(idTit);
    const suplente = await nombreDe(idSupMail);
    const titularNombre = titular ? `${titular.nombre || ''} ${titular.apellido || ''}`.trim() : '';
    await avisarSuplente({ suplente, titular, titularNombre, autorNombre, activeCats, activado: nowActive, motivo });
  }
  return { old, nv, wasActive, nowActive };
}

/* ── Programación por VACACIONES ───────────────────────────────────────────────
   programarPorVacaciones: al aprobar la solicitud. Sin suplente definido queda
   SIN_SUPLENTE (se avisa al titular para que lo defina en "Mi Back Up"). */
const ORIGEN_TXT = { VACACIONES: 'vacaciones', LICENCIA: 'licencia médica' };
/* Genérico: VACACIONES (al aprobar la solicitud) y LICENCIA médica (al ingresarla RRHH,
   08-09-2026). ref_id = id de rh_vacaciones / rh_ausencias. */
async function programarPorAusencia({ id_usuario, ref_id, desde, hasta, origen = 'VACACIONES' }) {
  try {
    const [[b]] = await pool.query('SELECT id_suplente FROM usuario_backups WHERE id_titular=?', [id_usuario]);
    const idSup = b && b.id_suplente ? Number(b.id_suplente) : null;
    await pool.query(
      `INSERT INTO backup_programados (id_titular, id_suplente, desde, hasta, origen, ref_id, estado)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE id_suplente=VALUES(id_suplente), desde=VALUES(desde), hasta=VALUES(hasta), estado=VALUES(estado)`,
      [id_usuario, idSup, desde, hasta, origen, ref_id, idSup ? 'PROGRAMADO' : 'SIN_SUPLENTE']);
    if (!idSup) {
      try {
        const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
        const que = ORIGEN_TXT[origen] || String(origen).toLowerCase();
        const dest = [id_usuario];
        // Con licencia médica la persona no está: se avisa también a su supervisor.
        if (origen === 'LICENCIA') { const [[su]] = await pool.query('SELECT id_supervisor FROM usuarios WHERE id_usuario=?', [id_usuario]); if (su && su.id_supervisor) dest.push(su.id_supervisor); }
        notificar(dest, { tipo: 'RRHH', prioridad: 'alta', titulo: `Sin Back Up definido (${que})`,
          mensaje: `${que === 'vacaciones' ? 'Vacaciones' : 'Licencia médica'} del ${desde} al ${hasta} sin suplente definido: nadie asumirá las funciones. Se define en el menú del usuario → Mi Back Up (o el Administrador en Mantenedores → Backups).`, href: '/recursos-humanos/mi-backup/' });
      } catch (_) {}
    }
    // Ya empezó (aprobación/ingreso tardío) → activar de inmediato
    await procesarProgramados();
  } catch (e) { console.error('[backups programarPorAusencia]', e.message); }
}
const programarPorVacaciones = ({ id_usuario, id_solicitud, desde, hasta }) => programarPorAusencia({ id_usuario, ref_id: id_solicitud, desde, hasta, origen: 'VACACIONES' });

/* Motor: activa lo que empieza hoy o ya empezó; cierra lo que terminó ayer. */
async function procesarProgramados() {
  const { hoyISO } = require('../../../../shared/fecha-chile');
  const hoy = hoyISO();
  // 1) Programados sin suplente que ya lo definieron → toman el suplente actual
  await pool.query(`UPDATE backup_programados bp JOIN usuario_backups ub ON ub.id_titular = bp.id_titular
                       SET bp.id_suplente = ub.id_suplente, bp.estado = 'PROGRAMADO'
                     WHERE bp.estado='SIN_SUPLENTE' AND ub.id_suplente IS NOT NULL AND bp.hasta >= ?`, [hoy]).catch(() => {});
  // 2) Activar
  const [porActivar] = await pool.query(
    `SELECT * FROM backup_programados WHERE estado='PROGRAMADO' AND desde <= ? AND hasta >= ? AND id_suplente IS NOT NULL`, [hoy, hoy]);
  for (const bp of porActivar) {
    try {
      const [[prev]] = await pool.query('SELECT id_suplente, b_funciones, b_alertas, b_correos FROM usuario_backups WHERE id_titular=?', [bp.id_titular]);
      await pool.query("UPDATE backup_programados SET estado='ACTIVO', activado_at=NOW(), prev_json=? WHERE id=?", [JSON.stringify(prev || null), bp.id]);
      const que = ORIGEN_TXT[bp.origen] || String(bp.origen || '').toLowerCase();
      await aplicarBackup(bp.id_titular, { id_suplente: bp.id_suplente, b_funciones: 1, b_alertas: 1, b_correos: 1 }, `el Sistema (${que})`,
        { motivo: `${que} del ${fmtF(bp.desde)} al ${fmtF(bp.hasta)}` });
      console.log('[backups-vacaciones] activado', bp.id, 'titular', bp.id_titular, '→ suplente', bp.id_suplente);
    } catch (e) { console.error('[backups-vacaciones activar]', bp.id, e.message); }
  }
  // 3) Cerrar (el día siguiente al último día de vacaciones)
  const [porCerrar] = await pool.query(`SELECT * FROM backup_programados WHERE estado='ACTIVO' AND hasta < ?`, [hoy]);
  for (const bp of porCerrar) {
    try {
      let prev = null; try { prev = bp.prev_json ? JSON.parse(bp.prev_json) : null; } catch (_) {}
      const restaurar = prev && prev.id_suplente ? prev : { id_suplente: bp.id_suplente, b_funciones: 0, b_alertas: 0, b_correos: 0 };
      // Si ANTES ya estaba activo por otra razón, se respeta; si no, se apaga todo.
      const que = ORIGEN_TXT[bp.origen] || String(bp.origen || '').toLowerCase();
      await aplicarBackup(bp.id_titular, restaurar, `el Sistema (fin de ${que})`, { motivo: `término de ${que === 'vacaciones' ? 'las vacaciones' : 'la ' + que} el ${fmtF(bp.hasta)}` });
      await pool.query("UPDATE backup_programados SET estado='CERRADO', cerrado_at=NOW() WHERE id=?", [bp.id]);
      console.log('[backups-vacaciones] cerrado', bp.id, 'titular', bp.id_titular);
    } catch (e) { console.error('[backups-vacaciones cerrar]', bp.id, e.message); }
  }
  // 4) Programados que vencieron sin activarse (sin suplente) → cancelados
  await pool.query("UPDATE backup_programados SET estado='CANCELADO', cerrado_at=NOW() WHERE estado IN ('PROGRAMADO','SIN_SUPLENTE') AND hasta < ?", [hoy]).catch(() => {});
}
const fmtF = d => String(d instanceof Date ? d.toISOString() : d).slice(0, 10).split('-').reverse().join('-');
require('../../../../shared/scheduler').programar('backups-vacaciones', procesarProgramados, 30 * 60 * 1000, { arranqueMs: 90 * 1000 });

/* ── Endpoints ── */
const esAdmin = req => req.usuario && req.usuario.perfil_nombre === 'Administrador';

/* GET /api/backups/mio — el propio usuario: su suplente, los que lo tienen a él y sus programaciones */
const mio = async (req, res) => {
  try {
    const id = req.usuario.id_usuario;
    const [[b]] = await pool.query(
      `SELECT b.*, TRIM(CONCAT(s.nombre,' ',COALESCE(s.apellido,''))) suplente_nombre, s.email suplente_email
         FROM usuario_backups b LEFT JOIN usuarios s ON s.id_usuario=b.id_suplente WHERE b.id_titular=?`, [id]);
    const [usuarios] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT(u.nombre,' ',COALESCE(u.apellido,''))) AS nombre, p.nombre AS perfil
         FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
        WHERE u.estado='activo' AND COALESCE(u.protegido,0)=0 AND COALESCE(u.externo,0)=0 AND u.id_usuario<>? ORDER BY nombre`, [id]);
    const [respaldo_de] = await pool.query(
      `SELECT TRIM(CONCAT(t.nombre,' ',COALESCE(t.apellido,''))) titular, b.b_funciones, b.b_alertas, b.b_correos
         FROM usuario_backups b JOIN usuarios t ON t.id_usuario=b.id_titular WHERE b.id_suplente=? AND t.estado='activo' ORDER BY titular`, [id]);
    const [programados] = await pool.query(
      `SELECT bp.id, DATE_FORMAT(bp.desde,'%Y-%m-%d') desde, DATE_FORMAT(bp.hasta,'%Y-%m-%d') hasta, bp.estado, bp.origen,
              TRIM(CONCAT(s.nombre,' ',COALESCE(s.apellido,''))) suplente_nombre
         FROM backup_programados bp LEFT JOIN usuarios s ON s.id_usuario=bp.id_suplente
        WHERE bp.id_titular=? AND bp.hasta >= CURDATE() - INTERVAL 60 DAY ORDER BY bp.desde DESC`, [id]);
    res.json({ success: true, data: { backup: b || null, usuarios, respaldo_de, programados }, error: null });
  } catch (e) { console.error('[backups mio]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* PUT /api/backups/mio { id_suplente } — el usuario elige SU suplente (no activa nada:
   las categorías las enciende el mantenedor o, automáticamente, las vacaciones) */
const guardarMio = async (req, res) => {
  try {
    const id = req.usuario.id_usuario;
    const idSup = req.body && req.body.id_suplente ? parseInt(req.body.id_suplente) : null;
    if (idSup === id) return res.status(400).json({ success: false, data: null, error: 'Tu suplente no puedes ser tú mismo' });
    if (idSup) {
      const [[ok]] = await pool.query("SELECT 1 x FROM usuarios WHERE id_usuario=? AND estado='activo' AND COALESCE(protegido,0)=0 AND COALESCE(externo,0)=0", [idSup]);
      if (!ok) return res.status(400).json({ success: false, data: null, error: 'Suplente inválido' });
    }
    const [[prev]] = await pool.query('SELECT * FROM usuario_backups WHERE id_titular=?', [id]);
    const cats = prev || { b_funciones: 0, b_alertas: 0, b_correos: 0 };
    const autor = `${req.usuario.nombre || ''} ${req.usuario.apellido || ''}`.trim();
    await aplicarBackup(id, { id_suplente: idSup, b_funciones: cats.b_funciones, b_alertas: cats.b_alertas, b_correos: cats.b_correos }, autor);
    // Programaciones futuras sin activar toman el suplente nuevo
    await pool.query("UPDATE backup_programados SET id_suplente=?, estado=IF(? IS NULL,'SIN_SUPLENTE','PROGRAMADO') WHERE id_titular=? AND estado IN ('PROGRAMADO','SIN_SUPLENTE')", [idSup, idSup, id]).catch(() => {});
    require('../../../../shared/audit').auditar({ req, accion: 'EDITAR', modulo: 'backups', entidad: 'usuario_backups', entidad_id: id,
      detalle: `Definió su Back Up: ${idSup ? 'usuario #' + idSup : 'sin suplente'}` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[backups guardarMio]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

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

    const autorNombre = `${(req.usuario.nombre || '')} ${(req.usuario.apellido || '')}`.trim() || 'la Administración';
    await aplicarBackup(idTit, { id_suplente, ...nv }, autorNombre);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { console.error('[backups guardar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { listar, guardar, mio, guardarMio, programarPorVacaciones, programarPorAusencia, procesarProgramados, aplicarBackup };
