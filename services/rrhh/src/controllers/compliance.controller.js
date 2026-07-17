'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CANAL DE COMPLIANCE — canal de denuncias interno.
   Cubre Ley Karin 21.643 (acoso laboral/sexual y violencia en el trabajo:
   canal obligatorio, investigación en 30 días hábiles) y Ley 20.393
   (delitos económicos: fraude, cohecho, conflicto de interés).
   · Cualquiera denuncia, identificado o ANÓNIMO (no se guarda el usuario).
   · Cada denuncia recibe un CÓDIGO DE SEGUIMIENTO para consultar su estado
     sin revelar identidad.
   · Solo los gestores (permiso compliance_gestionar) ven y tramitan; correo
     inmediato al recibirse una y alegato semanal por las vencidas.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const crypto = require('crypto');
const { tieneFunc } = require('../../../../shared/middleware/permisos');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

const TIPOS = ['ACOSO LABORAL', 'ACOSO SEXUAL', 'VIOLENCIA EN EL TRABAJO', 'FRAUDE O IRREGULARIDAD', 'CONFLICTO DE INTERÉS', 'DISCRIMINACIÓN', 'OTRO'];
const KARIN = ['ACOSO LABORAL', 'ACOSO SEXUAL', 'VIOLENCIA EN EL TRABAJO'];

require('../../../../shared/migrate').enFila('rrhh-compliance', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_denuncias (
    id INT AUTO_INCREMENT PRIMARY KEY,
    codigo VARCHAR(12) NOT NULL UNIQUE,
    tipo VARCHAR(40) NOT NULL,
    anonima TINYINT(1) DEFAULT 0,
    id_denunciante INT NULL,
    denunciado VARCHAR(200) NULL,
    relato TEXT NOT NULL,
    estado VARCHAR(20) DEFAULT 'RECIBIDA',
    fecha_limite DATE NULL,
    resolucion TEXT NULL,
    resuelta_por INT NULL,
    resuelta_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_estado (estado)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS rh_denuncias_seguimiento (
    id INT AUTO_INCREMENT PRIMARY KEY,
    id_denuncia INT NOT NULL,
    comentario TEXT NOT NULL,
    autor VARCHAR(160) NULL,
    visible_denunciante TINYINT(1) DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_den (id_denuncia)
  )`);
  const [[modRRHH]] = await pool.query(`SELECT id_modulo FROM modulos WHERE ruta='/recursos-humanos/' LIMIT 1`);
  if (modRRHH) {
    const [[f]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='compliance' LIMIT 1`);
    if (!f) {
      const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
        VALUES (?, 'Canal de Compliance', 'compliance', '/recursos-humanos/compliance/', 'bi-shield-exclamation')`, [modRRHH.id_modulo]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT p.id_perfil, ?, 1 FROM perfiles p`, [r.insertId]);
    }
    const [[fg]] = await pool.query(`SELECT id_funcionalidad FROM funcionalidades WHERE codigo='compliance_gestionar' LIMIT 1`);
    if (!fg) {
      const [r] = await pool.query(`INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
        VALUES (?, 'Compliance — gestionar denuncias', 'compliance_gestionar', NULL, NULL)`, [modRRHH.id_modulo]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1, ?, 1)`, [r.insertId]);
    }
  }
});

const esGestor = req => tieneFunc(req.usuario.id_usuario, 'compliance_gestionar').catch(() => false);

/* +N días hábiles L-V (plazo legal de investigación) */
function sumarHabiles(desde, n) {
  const d = new Date(desde + 'T12:00:00'); let c = 0;
  while (c < n) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) c++; }
  return d.toISOString().slice(0, 10);
}

async function gestores() {
  const [rr] = await pool.query(
    `SELECT DISTINCT u.id_usuario, u.email FROM usuarios u
      JOIN permisos_perfil pp ON pp.id_perfil=u.id_perfil AND pp.habilitado=1
      JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
     WHERE f.codigo='compliance_gestionar' AND u.estado='activo'`);
  return rr;
}

/* ── Denunciar (cualquiera logueado; anónima = no se guarda el usuario) ────── */
exports.crear = async (req, res) => {
  try {
    const b = req.body || {};
    if (!TIPOS.includes(b.tipo)) return fail(res, 'Tipo de denuncia inválido', 400);
    if (String(b.relato || '').trim().length < 30) return fail(res, 'Describe los hechos con más detalle (mínimo 30 caracteres)', 400);
    const anonima = b.anonima ? 1 : 0;
    const codigo = crypto.randomBytes(4).toString('hex').toUpperCase();
    const hoy = new Date().toISOString().slice(0, 10);
    const limite = sumarHabiles(hoy, 30); // Ley Karin: investigación en 30 días hábiles (se aplica a todas como estándar)
    await pool.query(
      `INSERT INTO rh_denuncias (codigo, tipo, anonima, id_denunciante, denunciado, relato, fecha_limite) VALUES (?,?,?,?,?,?,?)`,
      [codigo, b.tipo, anonima, anonima ? null : req.usuario.id_usuario,
       String(b.denunciado || '').slice(0, 200) || null, String(b.relato).slice(0, 10000), limite]);
    // aviso a los gestores (sin el relato: la confidencialidad se mantiene en el canal)
    try {
      const gs = await gestores();
      if (gs.length) {
        notificar(gs.map(g => g.id_usuario), {
          tipo: 'RRHH', prioridad: 'alta', titulo: '🛡️ Nueva denuncia en el Canal de Compliance',
          mensaje: `Tipo: ${b.tipo}${KARIN.includes(b.tipo) ? ' (Ley Karin: plazo 30 días hábiles)' : ''} — revísala en el canal`,
          href: '/recursos-humanos/compliance/', clave: `compl_${codigo}` });
        const { enviarCorreo, envolverHTML } = require('../../../../shared/mailer');
        const to = gs.map(g => g.email).filter(Boolean);
        if (to.length) await enviarCorreo({ to, subject: `🛡️ Nueva denuncia Compliance — ${b.tipo}`,
          html: envolverHTML ? envolverHTML(`<p>Se recibió una nueva denuncia <b>${b.tipo}</b>${anonima ? ' (anónima)' : ''}.</p><p>Plazo de investigación: <b>${limite.split('-').reverse().join('-')}</b>${KARIN.includes(b.tipo) ? ' (30 días hábiles, Ley Karin 21.643)' : ''}.</p><p>Gestiónala en el <a href="https://app.autofacilchile.cl/recursos-humanos/compliance/">Canal de Compliance</a>. El detalle solo se ve dentro del canal.</p>`) : '' });
      }
    } catch (e) { console.error('[compliance aviso]', e.message); }
    ok(res, { codigo, fecha_limite: limite });
  } catch (e) { fail(res, e.message); }
};

/* ── Seguimiento por código (denunciante, sin revelar identidad) ───────────── */
exports.seguimiento = async (req, res) => {
  try {
    const codigo = String(req.params.codigo || '').trim().toUpperCase();
    const [[d]] = await pool.query(`SELECT codigo, tipo, estado, DATE_FORMAT(created_at,'%Y-%m-%d') fecha,
      DATE_FORMAT(fecha_limite,'%Y-%m-%d') fecha_limite, resolucion FROM rh_denuncias WHERE codigo=?`, [codigo]);
    if (!d) return fail(res, 'Código no encontrado', 404);
    const [coms] = await pool.query(
      `SELECT comentario, DATE_FORMAT(created_at,'%Y-%m-%d') fecha FROM rh_denuncias_seguimiento
        WHERE id_denuncia=(SELECT id FROM rh_denuncias WHERE codigo=?) AND visible_denunciante=1 ORDER BY id`, [codigo]);
    // la resolución solo se muestra al denunciante cuando está resuelta
    if (!['RESUELTA', 'DESESTIMADA'].includes(d.estado)) d.resolucion = null;
    ok(res, { denuncia: d, comentarios: coms });
  } catch (e) { fail(res, e.message); }
};

/* ── Gestión (solo compliance_gestionar) ───────────────────────────────────── */
exports.lista = async (req, res) => {
  try {
    if (!await esGestor(req)) return fail(res, 'Solo los gestores del canal pueden ver las denuncias', 403);
    const [dens] = await pool.query(
      `SELECT d.*, TRIM(CONCAT_WS(' ', u.nombre, u.apellido)) denunciante
         FROM rh_denuncias d LEFT JOIN usuarios u ON u.id_usuario=d.id_denunciante
        ORDER BY d.estado IN ('RECIBIDA','EN INVESTIGACIÓN') DESC, d.created_at DESC LIMIT 500`);
    const ids = dens.map(d => d.id);
    const [coms] = ids.length ? await pool.query(`SELECT * FROM rh_denuncias_seguimiento WHERE id_denuncia IN (?) ORDER BY id`, [ids]) : [[]];
    const hoy = new Date().toISOString().slice(0, 10);
    ok(res, { denuncias: dens.map(d => ({ ...d,
      vencida: ['RECIBIDA', 'EN INVESTIGACIÓN'].includes(d.estado) && String(d.fecha_limite).slice(0, 10) < hoy,
      comentarios: coms.filter(c => c.id_denuncia === d.id) })), tipos: TIPOS });
  } catch (e) { fail(res, e.message); }
};

exports.gestionar = async (req, res) => {
  try {
    if (!await esGestor(req)) return fail(res, 'Solo los gestores del canal', 403);
    const b = req.body || {};
    const [[d]] = await pool.query(`SELECT * FROM rh_denuncias WHERE id=?`, [parseInt(req.params.id)]);
    if (!d) return fail(res, 'Denuncia no encontrada', 404);
    const autor = `${req.usuario.nombre || ''} ${req.usuario.apellido || ''}`.trim();
    if (String(b.comentario || '').trim())
      await pool.query(`INSERT INTO rh_denuncias_seguimiento (id_denuncia, comentario, autor, visible_denunciante) VALUES (?,?,?,?)`,
        [d.id, String(b.comentario).slice(0, 4000), autor, b.visible_denunciante ? 1 : 0]);
    if (b.estado && ['RECIBIDA', 'EN INVESTIGACIÓN', 'RESUELTA', 'DESESTIMADA'].includes(b.estado)) {
      const cierra = ['RESUELTA', 'DESESTIMADA'].includes(b.estado);
      if (cierra && !String(b.resolucion || d.resolucion || '').trim()) return fail(res, 'Para cerrar la denuncia registra la resolución', 400);
      await pool.query(`UPDATE rh_denuncias SET estado=?, resolucion=COALESCE(?, resolucion),
        resuelta_por=IF(?, ?, resuelta_por), resuelta_at=IF(?, NOW(), resuelta_at) WHERE id=?`,
        [b.estado, String(b.resolucion || '').slice(0, 4000) || null, cierra, req.usuario.id_usuario, cierra, d.id]);
    }
    require('../../../../shared/audit').auditar({ req, accion: 'GESTIONAR', modulo: 'compliance', entidad: 'denuncia', entidad_id: d.id,
      detalle: `${d.codigo}: ${b.estado || 'comentario'}` });
    ok(res, { ok: true });
  } catch (e) { fail(res, e.message); }
};

/* Alegato semanal: denuncias abiertas con plazo vencido */
const _w = require('../../../../api-gateway/public/js/rrhh-core').semanaISO; // motor único (la clave cambia de formato una vez; solo dedup semanal)
async function alegarVencidas() {
  try {
    const hoy = new Date().toISOString().slice(0, 10);
    const [[v]] = await pool.query(`SELECT COUNT(*) n FROM rh_denuncias WHERE estado IN ('RECIBIDA','EN INVESTIGACIÓN') AND fecha_limite < ?`, [hoy]);
    if (!v.n) return;
    const clave = 'compl_venc_' + _w(new Date());
    const [[ya]] = await pool.query('SELECT 1 ok FROM notificaciones WHERE clave=? LIMIT 1', [clave]);
    if (ya) return;
    const gs = await gestores();
    if (gs.length) notificar(gs.map(g => g.id_usuario), {
      tipo: 'RRHH', prioridad: 'alta', titulo: '🛡️ Denuncias de compliance con plazo vencido',
      mensaje: `${v.n} denuncia(s) abiertas superaron los 30 días hábiles de investigación — resolver a la brevedad`,
      href: '/recursos-humanos/compliance/', clave });
  } catch (e) { console.error('[alegato compliance]', e.message); }
}
setTimeout(alegarVencidas, 200 * 1000);
setInterval(alegarVencidas, 24 * 60 * 60 * 1000);
