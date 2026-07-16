'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Recursos Humanos — Solicitudes de Vacaciones y de Certificado de Antigüedad.
   Flujo: el empleado solicita → RRHH (permiso rh_aprobar) aprueba/rechaza/emite.
   ──────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');

/* ── Migración ─────────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('rrhh', async () => {
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
      ['Certificado de Antigüedad',   'rh_antiguedad',  '/recursos-humanos/antiguedad/', 'bi-award',       MOD_SOPORTE],
      ['Aprobar/Gestionar RRHH',      'rh_aprobar',     null,                            null,             MOD_SOPORTE],
    ];
    // Migración: si ya se sembró como módulo Home (v77.49), reubicarlo en Soporte y apagar el módulo suelto.
    await pool.query("UPDATE funcionalidades SET id_modulo=500001, href='/soporte/recursos-humanos/' WHERE codigo='rh_ver'");
    await pool.query("UPDATE funcionalidades SET id_modulo=500001 WHERE codigo IN ('rh_vacaciones','rh_antiguedad','rh_aprobar')");
    await pool.query("UPDATE funcionalidades SET nombre='Certificado de Antigüedad' WHERE codigo='rh_antiguedad'"); // v78.6: renombrado
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

  /* v78.0 — Certificado de Antigüedad self-service + Cumpleaños */
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_config (
        clave  VARCHAR(50) PRIMARY KEY,
        valor  TEXT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    const defaults = [
      ['cert_min_meses', '7'],
      ['cert_cooldown_dias', '15'],
      ['cert_cuerpo', 'Auto Fácil SpA, RUT 76.916.907-K, certifica que {don} <b>{nombre}</b>, cédula de identidad N° <b>{rut}</b>, presta servicios en nuestra empresa desde el <b>{fecha_ingreso}</b> a la fecha, desempeñándose actualmente en el cargo de <b>{cargo}</b>, con contrato de trabajo indefinido, acumulando una antigüedad laboral de <b>{antiguedad}</b>.'],
      ['cert_cierre', 'Se extiende el presente certificado a solicitud {interesado}, para los fines que estime conveniente, en Santiago de Chile con fecha {fecha_emision}.'],
      ['cumple_popup_activo', '1'],
      ['cumple_campana_activo', '1'],
      ['cumple_musica', '1'],
      ['cumple_titulo', '🎉 FELIZ CUMPLEAÑOS {nombre} 🎂'],
      ['cumple_linea1', 'Que tengas un día hermoso y muy especial'],
      ['cumple_linea2', 'Te desean tus compañeros de AutoFácil'],
      ['cumple_aviso_titulo', '🎂 ¡Hoy está de cumpleaños {nombre}!'],
      ['cumple_aviso_msg', 'No olvides saludar{lo} y desearle un gran día.'],
      ['cumple_aviso_tarde', '🎂 Recuerda que {nombre} estuvo de cumpleaños el {dia}. ¡No olvides saludar{lo}!'],
      ['cumple_dias_tope', '3'],
      ['cumple_banner_dur', '9'],
      ['cumple_banner_sonido', 'none'],
    ];
    for (const [k, v] of defaults) await pool.query('INSERT IGNORE INTO rh_config (clave, valor) VALUES (?,?)', [k, v]);
  } catch (e) { console.error('[rh_config migration]', e.message); }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_certificados (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        id_usuario    INT          NOT NULL,
        nombre        VARCHAR(200) NULL,
        rut           VARCHAR(20)  NULL,
        cargo         VARCHAR(120) NULL,
        fecha_ingreso DATE         NULL,
        codigo        VARCHAR(40)  NULL,
        emitido_por   INT          NULL,
        emitido_nombre VARCHAR(200) NULL,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_usuario (id_usuario, created_at)
      )`);
  } catch (e) { console.error('[rh_certificados migration]', e.message); }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rh_cumple_avisados (
        fecha      DATE NOT NULL,
        id_usuario INT  NOT NULL,
        PRIMARY KEY (fecha, id_usuario)
      )`);
  } catch (e) { console.error('[rh_cumple_avisados migration]', e.message); }
  try {
    // Mantenedor "Saludos y Certificados RRHH" dentro de Mantenedores
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' LIMIT 1");
    if (mod) {
      const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_rrhh_saludos' LIMIT 1");
      let idf = ex && ex.id_funcionalidad;
      if (!idf) {
        const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [mod.id_modulo, 'Saludos y Certificados RRHH', 'mant_rrhh_saludos', '/mantenedores/rrhh-saludos/', 'bi-balloon-heart']);
        idf = r.insertId;
      }
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    }
  } catch (e) { console.error('[rrhh mant saludos]', e.message); }
});

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
    let vista = req.query.vista || 'mias';
    if ((vista === 'bandeja' || vista === 'historicas') && !rrhh) vista = 'mias';
    const params = []; let where = '';
    if (vista === 'mias') { where = 'WHERE id_usuario=?'; params.push(u.id_usuario); }
    else if (vista === 'bandeja') where = "WHERE estado='PENDIENTE'";
    else if (vista === 'historicas') where = "WHERE estado<>'PENDIENTE'";
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
    // Cuenta corriente: la aprobación descuenta los días hábiles del saldo
    if (estado === 'APROBADA') try { await require('./vac-cuenta.controller').registrarTomado(s); } catch (_) {}
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
    let vista = req.query.vista || 'mias';
    if ((vista === 'bandeja' || vista === 'historicas') && !rrhh) vista = 'mias';
    const params = []; let where = '';
    if (vista === 'mias') { where = 'WHERE id_usuario=?'; params.push(u.id_usuario); }
    else if (vista === 'bandeja') where = "WHERE estado='PENDIENTE'";
    else if (vista === 'historicas') where = "WHERE estado<>'PENDIENTE'";
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

/* ════════════ CONFIG RRHH (rh_config) ════════════ */
async function getConfig() {
  const [rows] = await pool.query('SELECT clave, valor FROM rh_config LIMIT 100');
  const cfg = {}; rows.forEach(r => cfg[r.clave] = r.valor);
  return cfg;
}
const tpl = (t, vars) => String(t || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));

// Fecha de HOY en Chile (el server corre en UTC en Render)
function hoyChile() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p; // YYYY-MM-DD
}
// mysql2 devuelve DATE como objeto Date → normalizar SIEMPRE a 'YYYY-MM-DD' local
function isoFecha(f) {
  if (f instanceof Date) return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
  return String(f || '').slice(0, 10);
}
function mesesAntiguedad(fechaIngreso, hasta) {
  const a = new Date(isoFecha(fechaIngreso) + 'T00:00:00');
  const b = new Date((hasta || hoyChile()) + 'T00:00:00');
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m--;
  return Math.max(0, m);
}
function antiguedadTexto(meses) {
  const y = Math.floor(meses / 12), m = meses % 12;
  const py = y === 1 ? '1 año' : y + ' años', pm = m === 1 ? '1 mes' : m + ' meses';
  return y && m ? `${py} y ${pm}` : (y ? py : pm);
}
const fechaLargaCL = f => new Date(isoFecha(f) + 'T12:00:00').toLocaleDateString('es-CL', { day: 'numeric', month: 'long', year: 'numeric' });

const getConfigApi = async (req, res) => {
  try { res.json({ success: true, data: await getConfig(), error: null }); }
  catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const setConfigApi = async (req, res) => {
  try {
    const b = req.body || {};
    const PERMITIDAS = ['cert_min_meses', 'cert_cooldown_dias', 'cert_cuerpo', 'cert_cierre', 'cumple_popup_activo', 'cumple_campana_activo', 'cumple_musica', 'cumple_titulo', 'cumple_linea1', 'cumple_linea2', 'cumple_aviso_titulo', 'cumple_aviso_msg', 'cumple_aviso_tarde', 'cumple_dias_tope', 'cumple_banner_dur', 'cumple_banner_sonido'];
    for (const [k, v] of Object.entries(b)) {
      if (!PERMITIDAS.includes(k)) continue;
      await pool.query('INSERT INTO rh_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', [k, String(v == null ? '' : v)]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'rrhh', entidad: 'config', detalle: 'Actualizó saludos/certificados RRHH: ' + Object.keys(b).join(', ') });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ════════════ CERTIFICADO DE ANTIGÜEDAD (self-service, QR verificable) ════════════ */
async function estadoCertUsuario(idUsuario, cfg) {
  const [[u]] = await pool.query("SELECT id_usuario, CONCAT_WS(' ', nombre, apellido, apellido_materno) nombre, rut, cargo, sexo, fecha_ingreso FROM usuarios WHERE id_usuario=? LIMIT 1", [idUsuario]);
  if (!u) return { puede: false, motivo: 'Usuario no encontrado' };
  if (!u.fecha_ingreso) return { puede: false, usuario: u, motivo: 'SIN_FECHA', mensaje: 'RRHH aún no registra tu fecha de ingreso. Solicítalo abajo.' };
  const minMeses = parseInt(cfg.cert_min_meses || '7', 10);
  const meses = mesesAntiguedad(u.fecha_ingreso);
  if (meses < minMeses) return { puede: false, usuario: u, meses, motivo: 'CONTRATO_FIJO', mensaje: `Llevas menos de ${minMeses} meses (contrato a plazo fijo): tu certificado debe emitirlo RRHH. Solicítalo abajo.` };
  const cooldown = parseInt(cfg.cert_cooldown_dias || '15', 10);
  const [[ult]] = await pool.query('SELECT created_at FROM rh_certificados WHERE id_usuario=? ORDER BY created_at DESC LIMIT 1', [idUsuario]);
  if (ult) {
    const dias = Math.floor((Date.now() - new Date(ult.created_at).getTime()) / 86400000);
    if (dias < cooldown) return { puede: false, usuario: u, meses, motivo: 'COOLDOWN', mensaje: `Ya emitiste un certificado hace ${dias} día(s). Podrás emitir otro en ${cooldown - dias} día(s).` };
  }
  return { puede: true, usuario: u, meses };
}

const certEstado = async (req, res) => {
  try {
    const u = req.usuario || {}; const cfg = await getConfig();
    let objetivo = u.id_usuario;
    if (req.query.id_usuario && String(req.query.id_usuario) !== String(u.id_usuario)) {
      if (!(await esRRHH(u.id_usuario))) return res.status(403).json({ success: false, data: null, error: 'Solo RRHH/Admin puede consultar a otros' });
      objetivo = parseInt(req.query.id_usuario, 10);
    }
    const st = await estadoCertUsuario(objetivo, cfg);
    res.json({ success: true, data: { ...st, es_rrhh: await esRRHH(u.id_usuario) }, error: null });
  } catch (e) { console.error('[rrhh certEstado]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const certEmitir = async (req, res) => {
  try {
    const u = req.usuario || {}; const b = req.body || {}; const cfg = await getConfig();
    let objetivo = u.id_usuario, tercero = false;
    if (b.id_usuario && String(b.id_usuario) !== String(u.id_usuario)) {
      if (!(await esRRHH(u.id_usuario))) return res.status(403).json({ success: false, data: null, error: 'Solo RRHH/Admin emite para otros' });
      objetivo = parseInt(b.id_usuario, 10); tercero = true;
    }
    const st = await estadoCertUsuario(objetivo, cfg);
    // RRHH/Admin emitiendo para un tercero salta el cooldown y el mínimo de meses (es la autoridad emisora)
    if (!st.puede && !(tercero && st.usuario && st.usuario.fecha_ingreso)) {
      return res.status(409).json({ success: false, data: st, error: st.mensaje || 'No es posible emitir el certificado' });
    }
    const emp = st.usuario;
    const meses = mesesAntiguedad(emp.fecha_ingreso);
    const hoy = hoyChile();
    const esF = emp.sexo === 'F';
    const RUT = require('../../../../api-gateway/public/js/rut-core'); // motor único de RUT
    const vars = {
      nombre: emp.nombre, rut: emp.rut ? RUT.formatear(emp.rut) : '—', cargo: emp.cargo || (esF ? 'Colaboradora' : 'Colaborador'),
      don: esF ? 'doña' : 'don', interesado: esF ? 'de la interesada' : 'del interesado',
      fecha_ingreso: fechaLargaCL(emp.fecha_ingreso), antiguedad: antiguedadTexto(meses), fecha_emision: fechaLargaCL(hoy),
    };
    const [r] = await pool.query('INSERT INTO rh_certificados (id_usuario, nombre, rut, cargo, fecha_ingreso, emitido_por, emitido_nombre) VALUES (?,?,?,?,?,?,?)',
      [emp.id_usuario, emp.nombre, emp.rut || null, emp.cargo || null, emp.fecha_ingreso, u.id_usuario || null, nombreDe(u)]);
    const { registrarVerificable } = require('../../../../shared/verificacion');
    // Cargo del firmante (quien emite) para la Firma Electrónica Simple
    let cargoFirmante = null;
    try { const [[uf]] = await pool.query('SELECT cargo FROM usuarios WHERE id_usuario=? LIMIT 1', [u.id_usuario]); cargoFirmante = uf && uf.cargo; } catch (_) {}
    const ipReq = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null;
    const codigo = await registrarVerificable({
      tipo: 'CERT_ANTIGUEDAD', ref_tabla: 'rh_certificados', ref_id: r.insertId,
      rut: emp.rut || null, nombre: emp.nombre,
      datos: { cargo: vars.cargo, fecha_ingreso: isoFecha(emp.fecha_ingreso), antiguedad: vars.antiguedad },
      emitido_por: nombreDe(u),
      firmante: { id: u.id_usuario, nombre: nombreDe(u), cargo: cargoFirmante || u.perfil_nombre || null, ip: ipReq },
    });
    await pool.query('UPDATE rh_certificados SET codigo=? WHERE id=?', [codigo, r.insertId]);
    auditar({ req, accion: 'CREAR', modulo: 'rrhh', entidad: 'certificado_antiguedad', entidad_id: r.insertId, detalle: `Certificado de antigüedad de ${emp.nombre} (${vars.antiguedad}) — folio ${codigo}` });
    res.status(201).json({
      success: true, error: null,
      data: { codigo, fecha_emision: hoy, nombre: emp.nombre, rut: emp.rut, cargo: vars.cargo,
              fecha_ingreso: isoFecha(emp.fecha_ingreso), antiguedad: vars.antiguedad,
              cuerpo_html: tpl(cfg.cert_cuerpo, vars), cierre_html: tpl(cfg.cert_cierre, vars),
              firmante: nombreDe(u), firmante_cargo: cargoFirmante || u.perfil_nombre || null,
              autogenerado: !tercero, solicitante: emp.nombre },
    });
  } catch (e) { console.error('[rrhh certEmitir]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// Lista mínima de empleados para el selector de RRHH/Admin
const listarEmpleados = async (req, res) => {
  try {
    const u = req.usuario || {};
    if (!(await esRRHH(u.id_usuario))) return res.status(403).json({ success: false, data: null, error: 'Solo RRHH/Admin' });
    const [rows] = await pool.query("SELECT id_usuario, CONCAT_WS(' ', nombre, apellido, apellido_materno) nombre, cargo, fecha_ingreso FROM usuarios WHERE estado='activo' ORDER BY nombre LIMIT 500");
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ════════════ CUMPLEAÑOS ════════════ */
/* Cumpleaños dentro de la ventana [hoy - tope, hoy]: si cayó sábado/domingo/feriado
   y la persona no se conectó, se saluda igual la próxima vez, con tope de N días. */
async function cumplesEnVentana(tope, soloId) {
  const hoy = hoyChile();
  const fechas = []; // [{iso, dias}]
  for (let d = 0; d <= tope; d++) {
    const f = new Date(hoy + 'T12:00:00'); f.setDate(f.getDate() - d);
    fechas.push({ iso: isoFecha(f), dias: d });
  }
  const params = []; let extra = '';
  if (soloId) { extra = ' AND id_usuario=?'; params.push(soloId); }
  const [rows] = await pool.query(
    `SELECT id_usuario, CONCAT_WS(' ', nombre, apellido) nombre, nombre nombre_pila, sexo, fecha_nacimiento
       FROM usuarios WHERE fecha_nacimiento IS NOT NULL AND estado='activo'${extra} LIMIT 600`, params);
  const out = [];
  for (const r of rows) {
    const fn = isoFecha(r.fecha_nacimiento); // YYYY-MM-DD
    const hit = fechas.find(f => f.iso.slice(5) === fn.slice(5)); // match mes-día
    if (hit) out.push({ ...r, fecha_cumple: hit.iso, dias: hit.dias });
  }
  return out;
}
const diaSemanaCL = iso => new Date(iso + 'T12:00:00').toLocaleDateString('es-CL', { weekday: 'long' });

// ¿Estuvo/está de cumpleaños el usuario logueado? (para el popup global)
const cumpleEstado = async (req, res) => {
  try {
    const u = req.usuario || {}; const cfg = await getConfig();
    const tope = Math.max(0, parseInt(cfg.cumple_dias_tope || '3', 10));
    let hit = null;
    if (String(req.query.test || '') === '1' && (await esRRHH(u.id_usuario))) {
      hit = { nombre_pila: (u.nombre || '').trim() || 'Colaborador', fecha_cumple: hoyChile(), dias: 0 };
    } else if (cfg.cumple_popup_activo === '1') {
      const matches = await cumplesEnVentana(tope, u.id_usuario);
      hit = matches[0] || null;
    }
    if (!hit) return res.json({ success: true, data: { es_cumple: false }, error: null });
    res.json({ success: true, data: {
      es_cumple: true, fecha: hit.fecha_cumple, // el cliente dedupea por CUMPLEAÑOS, no por día
      titulo: tpl(cfg.cumple_titulo, { nombre: (hit.nombre_pila || '').toUpperCase() }),
      linea1: cfg.cumple_linea1 || '', linea2: cfg.cumple_linea2 || '',
      musica: cfg.cumple_musica === '1',
    }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: { es_cumple: false }, error: 'Error' }); }
};

/* Cumpleañeros de HOY (para el banner que ve cada compañero al conectarse).
   El aviso NO es campana: cumple-popup.js muestra el mismo banner push de los
   anuncios (afMostrarAnuncio), 1 vez al día por navegador. */
const cumpleHoy = async (req, res) => {
  try {
    const u = req.usuario || {}; const cfg = await getConfig();
    if (cfg.cumple_campana_activo !== '1') return res.json({ success: true, data: { avisos: [] }, error: null });
    const tope = Math.max(0, parseInt(cfg.cumple_dias_tope || '3', 10));
    const cumps = (await cumplesEnVentana(tope)).filter(c => c.id_usuario !== (u.id_usuario || 0));
    const avisos = cumps.map(c => {
      const vars = { nombre: c.nombre, lo: c.sexo === 'F' ? 'la' : 'lo', dia: diaSemanaCL(c.fecha_cumple) };
      const texto = c.dias === 0
        ? tpl(cfg.cumple_aviso_titulo, vars) + ' ' + tpl(cfg.cumple_aviso_msg, vars)
        : tpl(cfg.cumple_aviso_tarde, vars); // "Recuerda que {nombre} estuvo de cumpleaños el {dia}…"
      return { id: c.id_usuario, fecha: c.fecha_cumple, texto }; // dedup por cumpleaños, no por día
    });
    const opts = { dur: Math.min(120, Math.max(2, parseInt(cfg.cumple_banner_dur || '9', 10))), sonido: cfg.cumple_banner_sonido || 'none' };
    res.json({ success: true, data: { avisos, opts }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: { avisos: [] }, error: 'Error' }); }
};

const pendientes = async (req, res) => {
  try {
    const u = req.usuario || {}; const rrhh = await esRRHH(u.id_usuario);
    let vac = 0, ant = 0;
    if (rrhh) {
      const [[a]] = await pool.query("SELECT COUNT(*) c FROM rh_vacaciones WHERE estado='PENDIENTE'");
      const [[b]] = await pool.query("SELECT COUNT(*) c FROM rh_antiguedad WHERE estado='PENDIENTE'");
      vac = a.c; ant = b.c;
    }
    res.json({ success: true, data: { es_rrhh: rrhh, vacaciones: vac, antiguedad: ant, count: vac + ant }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: { count: 0 }, error: 'Error' }); }
};

module.exports = { crearVacaciones, listarVacaciones, resolverVacaciones, crearAntiguedad, listarAntiguedad, resolverAntiguedad, pendientes,
  certEstado, certEmitir, listarEmpleados, cumpleEstado, cumpleHoy, getConfigApi, setConfigApi };
