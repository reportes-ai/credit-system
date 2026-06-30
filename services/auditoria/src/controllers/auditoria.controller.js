'use strict';
const pool = require('../../../../shared/config/database');
const XLSX = require('xlsx');

/* ── Registro del módulo en el menú (idempotente). Solo Administrador. ──────── */
(async () => {
  try {
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (360001, 'Auditoría', 'Bitácora de logins y movimientos del sistema', 'bi-clipboard-data', '/auditoria/', 103, 'activo')`);
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='auditoria_ver' LIMIT 1");
    let idFunc = ex && ex.id_funcionalidad;
    if (!idFunc) {
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
         VALUES (360001, 'Auditoría', 'auditoria_ver', '/auditoria/', 'bi-clipboard-data')`);
      idFunc = r.insertId;
    }
    const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idFunc]);
    if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idFunc]);
    console.log('[auditoria] módulo registrado');
  } catch (e) { console.error('[auditoria migration]', e.message); }
})();

/* ── Construcción de filtros WHERE (compartido entre listar y exportar) ─────── */
function whereMovimientos(qy) {
  const where = [], vals = [];
  if (qy.desde)  { where.push('fecha >= ?'); vals.push(qy.desde + ' 00:00:00'); }
  if (qy.hasta)  { where.push('fecha <= ?'); vals.push(qy.hasta + ' 23:59:59'); }
  if (qy.usuario) {
    if (/^\d+$/.test(qy.usuario)) { where.push('id_usuario = ?'); vals.push(parseInt(qy.usuario)); }
    else if (qy.usuario === 'Sistema') { where.push("(usuario = 'Sistema' OR id_usuario IS NULL)"); }
    else { where.push('usuario LIKE ?'); vals.push('%' + qy.usuario + '%'); }
  }
  if (qy.accion) { where.push('accion = ?'); vals.push(qy.accion); }
  if (qy.modulo) { where.push('modulo = ?'); vals.push(qy.modulo); }
  if (qy.q) {
    where.push('(detalle LIKE ? OR rut LIKE ? OR usuario LIKE ? OR entidad_id LIKE ?)');
    const like = '%' + qy.q + '%'; vals.push(like, like, like, like);
  }
  return { whereStr: where.length ? 'WHERE ' + where.join(' AND ') : '', vals };
}
function whereLogins(qy) {
  const where = [], vals = [];
  if (qy.desde) { where.push('login_at >= ?'); vals.push(qy.desde + ' 00:00:00'); }
  if (qy.hasta) { where.push('login_at <= ?'); vals.push(qy.hasta + ' 23:59:59'); }
  if (qy.usuario) {
    if (/^\d+$/.test(qy.usuario)) { where.push('id_usuario = ?'); vals.push(parseInt(qy.usuario)); }
    else { where.push('nombre LIKE ?'); vals.push('%' + qy.usuario + '%'); }
  }
  return { whereStr: where.length ? 'WHERE ' + where.join(' AND ') : '', vals };
}

/* ── GET /api/auditoria-mov/movimientos ────────────────────────────────────── */
const getMovimientos = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(10, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;
    const { whereStr, vals } = whereMovimientos(req.query);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM auditoria_movimientos ${whereStr}`, vals);
    const [rows] = await pool.query(
      `SELECT id, fecha, id_usuario, usuario, perfil, modulo, accion, entidad, entidad_id, detalle, rut, ip, id_titular, titular_nombre
       FROM auditoria_movimientos ${whereStr} ORDER BY fecha DESC, id DESC LIMIT ? OFFSET ?`,
      [...vals, limit, offset]);
    res.json({ success: true, data: { rows, total, page, limit, pages: Math.ceil(total / limit) }, error: null });
  } catch (e) { console.error('[auditoria movimientos]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /api/auditoria-mov/logins ─────────────────────────────────────────── */
const getLogins = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(500, Math.max(10, parseInt(req.query.limit) || 100));
    const offset = (page - 1) * limit;
    const { whereStr, vals } = whereLogins(req.query);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM sesiones_usuario ${whereStr}`, vals);
    const [rows] = await pool.query(
      `SELECT id, id_usuario, nombre, perfil, login_at, last_seen, logout_at,
              TIMESTAMPDIFF(MINUTE, login_at, COALESCE(logout_at, last_seen)) AS minutos
       FROM sesiones_usuario ${whereStr} ORDER BY login_at DESC LIMIT ? OFFSET ?`,
      [...vals, limit, offset]);
    res.json({ success: true, data: { rows, total, page, limit, pages: Math.ceil(total / limit) }, error: null });
  } catch (e) { console.error('[auditoria logins]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /api/auditoria-mov/filtros — opciones para los selects ────────────── */
const getFiltros = async (req, res) => {
  try {
    const [acciones] = await pool.query('SELECT DISTINCT accion FROM auditoria_movimientos ORDER BY accion');
    const [modulos]  = await pool.query("SELECT DISTINCT modulo FROM auditoria_movimientos WHERE modulo IS NOT NULL AND modulo<>'' ORDER BY modulo");
    const [us1] = await pool.query('SELECT DISTINCT id_usuario, usuario AS nombre FROM auditoria_movimientos WHERE id_usuario IS NOT NULL');
    const [us2] = await pool.query('SELECT DISTINCT id_usuario, nombre FROM sesiones_usuario WHERE id_usuario IS NOT NULL');
    const [[sis]] = await pool.query("SELECT COUNT(*) c FROM auditoria_movimientos WHERE id_usuario IS NULL");
    const um = new Map();
    [...us1, ...us2].forEach(u => { if (u.id_usuario && !um.has(u.id_usuario)) um.set(u.id_usuario, u.nombre); });
    const usuarios = [...um].map(([id, nombre]) => ({ id, nombre })).sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || '')));
    if (sis.c > 0) usuarios.unshift({ id: 'Sistema', nombre: 'Sistema' });
    res.json({ success: true, data: { acciones: acciones.map(a => a.accion), modulos: modulos.map(m => m.modulo), usuarios }, error: null });
  } catch (e) { console.error('[auditoria filtros]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Export a Excel ────────────────────────────────────────────────────────── */
// La BD ya almacena la hora en horario Chile; el driver la etiqueta como UTC.
// Formateamos en UTC para mostrar el valor literal (= hora Chile real), sin doble desfase.
const fmt = d => { if (!d) return ''; const x = new Date(d); return isNaN(x) ? '' : x.toLocaleString('es-CL', { hour12: false, timeZone: 'America/Santiago' }); };
function enviarXlsx(res, hoja, filas, archivo) {
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, hoja);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${archivo}"`);
  res.send(buf);
}

const exportMovimientos = async (req, res) => {
  try {
    const { whereStr, vals } = whereMovimientos(req.query);
    const [rows] = await pool.query(
      `SELECT fecha, usuario, perfil, modulo, accion, entidad, entidad_id, detalle, rut, ip
       FROM auditoria_movimientos ${whereStr} ORDER BY fecha DESC, id DESC LIMIT 50000`, vals);
    const filas = rows.map(r => ({
      Fecha: fmt(r.fecha), Usuario: r.usuario || '', Perfil: r.perfil || '', Módulo: r.modulo || '',
      Acción: r.accion || '', Entidad: r.entidad || '', ID: r.entidad_id || '',
      Detalle: r.detalle || '', RUT: r.rut || '', IP: r.ip || '',
    }));
    enviarXlsx(res, 'Movimientos', filas.length ? filas : [{ Fecha: '', Usuario: '', Detalle: 'Sin registros' }], `auditoria_movimientos_${Date.now()}.xlsx`);
  } catch (e) { console.error('[auditoria export mov]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const exportLogins = async (req, res) => {
  try {
    const { whereStr, vals } = whereLogins(req.query);
    const [rows] = await pool.query(
      `SELECT nombre, perfil, login_at, logout_at, last_seen,
              TIMESTAMPDIFF(MINUTE, login_at, COALESCE(logout_at, last_seen)) AS minutos
       FROM sesiones_usuario ${whereStr} ORDER BY login_at DESC LIMIT 50000`, vals);
    const filas = rows.map(r => ({
      Usuario: r.nombre || '', Perfil: r.perfil || '', Ingreso: fmt(r.login_at),
      Salida: r.logout_at ? fmt(r.logout_at) : '(sesión abierta / sin logout)',
      'Última actividad': fmt(r.last_seen), 'Minutos conectado': r.minutos != null ? r.minutos : '',
    }));
    enviarXlsx(res, 'Logins', filas.length ? filas : [{ Usuario: '', Ingreso: '', Salida: 'Sin registros' }], `auditoria_logins_${Date.now()}.xlsx`);
  } catch (e) { console.error('[auditoria export logins]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /api/auditoria-mov/backups — periodos de vigencia de cada backup ──── */
const getBackups = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT bp.id, bp.id_titular, bp.id_suplente, bp.categorias, bp.desde, bp.hasta, bp.activado_por,
              TRIM(CONCAT(t.nombre,' ',COALESCE(t.apellido,''))) AS titular,
              TRIM(CONCAT(s.nombre,' ',COALESCE(s.apellido,''))) AS suplente
         FROM backup_periodos bp
         LEFT JOIN usuarios t ON t.id_usuario = bp.id_titular
         LEFT JOIN usuarios s ON s.id_usuario = bp.id_suplente
        ORDER BY (bp.hasta IS NULL) DESC, bp.desde DESC
        LIMIT 1000`);
    res.json({ success: true, data: { rows }, error: null });
  } catch (e) {
    // Si la tabla aún no existe (módulo backups no inicializado), devuelve vacío.
    res.json({ success: true, data: { rows: [] }, error: null });
  }
};

/* ── GET /api/auditoria-mov/dealers — bitácora de dealers (separada de internos) ──
   Mezcla 3 fuentes: accesos (ar_auth_logs), acciones en el portal
   (portal_dealer_log) y preguntas a la IA (portal_ia_uso). Cada fuente es
   tolerante a fallos (si su tabla no existe aún, se omite). */
const accesoLabel = t => ({ login: 'Ingreso (clave)', acceso: 'Ingreso (link)', ws: 'Conexión chat', recuperar: 'Solicitó recuperar clave', reset: 'Cambió su clave' }[t] || t || 'Acceso');
const accionLabel = a => ({ ver_operacion: 'Vio operación', ver_cartolas: 'Vio cartolas' }[a] || a || 'Acción');

const getBitacoraDealers = async (req, res) => {
  try {
    const qy = req.query;
    const desde = qy.desde ? qy.desde + ' 00:00:00' : null;
    const hasta = qy.hasta ? qy.hasta + ' 23:59:59' : null;
    const cond = (col) => {
      const w = [], v = [];
      if (desde) { w.push(`${col} >= ?`); v.push(desde); }
      if (hasta) { w.push(`${col} <= ?`); v.push(hasta); }
      return { w: w.length ? 'WHERE ' + w.join(' AND ') : '', v };
    };
    const eventos = [];
    try {
      const c = cond('l.created_at');
      const [rows] = await pool.query(
        `SELECT l.created_at AS fecha, l.tipo AS accion, l.resultado, l.ip,
                COALESCE(cu.nombre, l.email) AS dealer, l.email
         FROM ar_auth_logs l LEFT JOIN ar_dealer_cuentas cu ON cu.id = l.id_cuenta
         ${c.w} ORDER BY l.id DESC LIMIT 2000`, c.v);
      rows.forEach(r => eventos.push({ categoria: 'Acceso', fecha: r.fecha, dealer: r.dealer || r.email || '—', accion: accesoLabel(r.accion), detalle: r.resultado === 'FAIL' ? 'Intento fallido' : '', resultado: r.resultado || 'OK', ip: r.ip || '' }));
    } catch (_) {}
    try {
      const c = cond('l.created_at');
      const [rows] = await pool.query(
        `SELECT l.created_at AS fecha, l.accion, l.detalle, l.ip, cu.nombre AS dealer
         FROM portal_dealer_log l LEFT JOIN ar_dealer_cuentas cu ON cu.id = l.id_cuenta
         ${c.w} ORDER BY l.id DESC LIMIT 2000`, c.v);
      rows.forEach(r => eventos.push({ categoria: 'Acción', fecha: r.fecha, dealer: r.dealer || '—', accion: accionLabel(r.accion), detalle: r.detalle || '', resultado: 'OK', ip: r.ip || '' }));
    } catch (_) {}
    try {
      const c = cond('u.ts');
      const [rows] = await pool.query(
        `SELECT u.ts AS fecha, u.pregunta, cu.nombre AS dealer
         FROM portal_ia_uso u LEFT JOIN ar_dealer_cuentas cu ON cu.id = u.id_cuenta
         ${c.w} ORDER BY u.id DESC LIMIT 2000`, c.v);
      rows.forEach(r => eventos.push({ categoria: 'Asistente IA', fecha: r.fecha, dealer: r.dealer || '—', accion: 'Pregunta', detalle: r.pregunta || '', resultado: 'OK', ip: '' }));
    } catch (_) {}

    let merged = eventos.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    if (qy.categoria) merged = merged.filter(e => e.categoria === qy.categoria);
    if (qy.q) {
      const k = String(qy.q).toLowerCase();
      merged = merged.filter(e => [e.dealer, e.accion, e.detalle].join(' ').toLowerCase().includes(k));
    }
    const total = merged.length;
    const page  = Math.max(1, parseInt(qy.page) || 1);
    const limit = Math.min(500, Math.max(10, parseInt(qy.limit) || 100));
    const rows  = merged.slice((page - 1) * limit, (page - 1) * limit + limit);
    res.json({ success: true, data: { rows, total, page, limit, pages: Math.ceil(total / limit) }, error: null });
  } catch (e) { console.error('[auditoria dealers]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getMovimientos, getLogins, getFiltros, exportMovimientos, exportLogins, getBackups, getBitacoraDealers };
