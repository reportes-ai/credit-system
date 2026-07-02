'use strict';
/* ═════════════════════════════════════════════════════════════════════════════
   MI DÍA — panel de bienvenida con los pendientes reales del usuario, agrupados
   y con link directo a resolver. Los widgets son PARAMÉTRICOS por perfil
   (mantenedor Mi Día): cada perfil ve el subconjunto que se le configure. Cada
   widget tiene un recolector robusto (try/catch → 0) y, si es de "pool", exige
   además el permiso real (doble filtro). Incluye Google Calendar del usuario.
   ════════════════════════════════════════════════════════════════════════════ */
const pool = require('../../../../shared/config/database');
const G = require('./google-calendar');

let _tieneFunc = null;
function tieneFunc(id, ...codigos) {
  try { _tieneFunc = _tieneFunc || require('../../../../shared/middleware/permisos').tieneFunc; return _tieneFunc(id, ...codigos); }
  catch { return Promise.resolve(true); }
}

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const keyEj = s => norm(s).split(' ').filter(Boolean).sort().join(' ');
function mesChile() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit' }).format(new Date());
  return p.slice(0, 7);
}
async function nombreEjecutivo(u) {
  // El nombre con que se guarda al ejecutivo en creditos = "Nombre Apellido"
  return `${u.nombre || ''} ${u.apellido || ''}`.trim();
}
const uno = async (sql, params = []) => { try { const [[r]] = await pool.query(sql, params); return Number(r.n) || 0; } catch (e) { return 0; } };

/* ── Catálogo de widgets ──────────────────────────────────────────────────────
   scope 'pool'     → mismo dato para todos; requiere `func` de permiso.
   scope 'personal' → filtrado por el usuario (id o nombre de ejecutivo).
   perfiles         → defaults (a qué perfiles se enciende si no hay config manual). */
const WIDGETS = [
  { codigo: 'cartas_revisar', nombre: 'Cartas por revisar', icono: 'bi-file-earmark-text', color: '#0141A2', href: '/aprobaciones/',
    scope: 'pool', permiso: ['aprobar_carta', 'ver_aprobaciones'], perfiles: [1, 2, 5, 90008, 90011],
    get: () => uno("SELECT COUNT(*) n FROM cartas_aprobacion WHERE status='PENDIENTE'") },
  { codigo: 'cartas_vigentes', nombre: 'Cartas aprobadas por otorgar/desistir', icono: 'bi-hourglass-split', color: '#7c3aed', href: '/aprobaciones/',
    scope: 'pool', permiso: ['ver_aprobaciones'], perfiles: [1, 2, 4, 6, 90008],
    get: () => uno("SELECT COUNT(*) n FROM cartas_aprobacion WHERE status='APROBADA' AND COALESCE(otorgado,0)=0 AND desistido_por IS NULL") },
  { codigo: 'creditos_pendientes', nombre: 'Créditos pendientes de decisión', icono: 'bi-clipboard-data', color: '#0891b2', href: '/creditos/',
    scope: 'pool', permiso: ['ver_creditos', 'aprobar_carta'], perfiles: [1, 2, 5, 90011],
    get: () => uno("SELECT COUNT(*) n FROM creditos WHERE estado_credito='PENDIENTE'") },
  { codigo: 'fundantes_validar', nombre: 'Fundantes por validar', icono: 'bi-folder-check', color: '#c2410c', href: '/fundantes/',
    scope: 'pool', permiso: ['fundantes_validar', 'ver_fundantes'], perfiles: [1, 2, 6, 90008],
    get: () => uno("SELECT COUNT(*) n FROM fundantes_brokerage WHERE UPPER(COALESCE(estado,''))='PENDIENTE'") },
  { codigo: 'fundantes_rechazados', nombre: 'Mis fundantes rechazados', icono: 'bi-folder-x', color: '#dc2626', href: '/fundantes/',
    scope: 'personal', perfiles: [4],
    get: (u) => uno(`SELECT COUNT(*) n FROM fundantes_brokerage WHERE UPPER(COALESCE(estado,''))='RECHAZADO' AND id_subido_por=?`, [u.id_usuario]) },
  { codigo: 'visitas_hoy', nombre: 'Mis visitas de hoy', icono: 'bi-geo-alt', color: '#16a34a', href: '/dealers-visitas/',
    scope: 'personal', perfiles: [4, 3, 90010],
    get: (u) => uno("SELECT COUNT(*) n FROM visitas_dealers WHERE DATE(fecha_programada)=CURDATE() AND id_usuario=? AND UPPER(COALESCE(estado,''))<>'REALIZADA'", [u.id_usuario]) },
  { codigo: 'rh_pendientes', nombre: 'Solicitudes RRHH por resolver', icono: 'bi-people', color: '#0d9488', href: '/recursos-humanos/vacaciones/',
    scope: 'pool', permiso: ['rh_aprobar'], perfiles: [1, 120001, 90008],
    get: async () => (await uno("SELECT COUNT(*) n FROM rh_vacaciones WHERE estado='PENDIENTE'")) + (await uno("SELECT COUNT(*) n FROM rh_antiguedad WHERE estado='PENDIENTE'")) },
  { codigo: 'tickets_atender', nombre: 'Tickets TI por atender', icono: 'bi-life-preserver', color: '#b45309', href: '/tickets/',
    scope: 'pool', permiso: ['ti_atender'], perfiles: [1],
    get: () => uno("SELECT COUNT(*) n FROM ti_tickets WHERE estado IN ('ABIERTO','EN_PROCESO')") },
  { codigo: 'mis_tickets', nombre: 'Mis tickets TI abiertos', icono: 'bi-chat-left-dots', color: '#64748b', href: '/tickets/',
    scope: 'personal', perfiles: [1, 2, 3, 4, 5, 6],
    get: (u) => uno("SELECT COUNT(*) n FROM ti_tickets WHERE creado_por=? AND estado IN ('ABIERTO','EN_PROCESO','RESUELTO')", [u.id_usuario]) },
  { codigo: 'odp_cuotas', nombre: 'ODP de cuotas por resolver', icono: 'bi-cash-stack', color: '#0369a1', href: '/tesoreria/',
    scope: 'pool', permiso: ['tesoreria', 'odp_resolver'], perfiles: [1, 30001, 90007],
    get: () => uno("SELECT COUNT(*) n FROM ordenes_pago_cuotas WHERE estado='EMITIDA'") },
  { codigo: 'odp_proveedores', nombre: 'Órdenes de pago sin pagar', icono: 'bi-receipt', color: '#4338ca', href: '/ordenes-pago/',
    scope: 'pool', permiso: ['ordenes_pago'], perfiles: [1, 30001, 90007],
    get: () => uno("SELECT COUNT(*) n FROM ordenes_pago WHERE estado='EMITIDA'") },
  { codigo: 'digitacion', nombre: 'Créditos con datos faltantes', icono: 'bi-pencil-square', color: '#a16207', href: '/carga-masiva/digitacion/cola',
    scope: 'pool', permiso: ['digitacion_faltantes', 'carga_masiva'], perfiles: [1, 6, 90008],
    get: () => uno("SELECT COUNT(*) n FROM creditos WHERE estado_credito='OTORGADO' AND (plazo IS NULL OR plazo=0 OR tascli_real IS NULL OR tascli_real=0 OR monto_financiado IS NULL OR monto_financiado=0)") },
  { codigo: 'mis_colocaciones', nombre: 'Mis colocaciones del mes', icono: 'bi-graph-up-arrow', color: '#15803d', href: '/dashboard/', destacado: true,
    scope: 'personal', perfiles: [4, 3, 90010],
    get: async (u) => {
      const nom = await nombreEjecutivo(u);
      const [rows] = await pool.query("SELECT ejecutivo, COUNT(*) n FROM creditos WHERE mes=? AND UPPER(COALESCE(estado_credito,''))='OTORGADO' AND ejecutivo<>'' GROUP BY ejecutivo", [mesChile() + '-01']);
      const r = rows.find(x => keyEj(x.ejecutivo) === keyEj(nom));
      return r ? Number(r.n) : 0;
    } },
];
const WIDGET_MAP = Object.fromEntries(WIDGETS.map(w => [w.codigo, w]));

/* ── Migración: config por perfil ─────────────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mi_dia_config (
        id_perfil INT NOT NULL,
        codigo    VARCHAR(40) NOT NULL,
        activo    TINYINT(1) NOT NULL DEFAULT 1,
        orden     INT NOT NULL DEFAULT 0,
        PRIMARY KEY (id_perfil, codigo)
      )`);
    // Siembra defaults del catálogo (solo si el perfil no tiene NINGUNA fila aún)
    const [existentes] = await pool.query('SELECT DISTINCT id_perfil FROM mi_dia_config');
    const yaConfig = new Set(existentes.map(r => r.id_perfil));
    const porPerfil = {};
    WIDGETS.forEach(w => (w.perfiles || []).forEach(p => { (porPerfil[p] = porPerfil[p] || []).push(w.codigo); }));
    for (const [idp, codigos] of Object.entries(porPerfil)) {
      if (yaConfig.has(Number(idp))) continue;
      let orden = 0;
      for (const c of codigos) await pool.query('INSERT IGNORE INTO mi_dia_config (id_perfil, codigo, activo, orden) VALUES (?,?,1,?)', [idp, c, orden++]);
    }
    // Módulo "Mi Día" (card en Home, orden 0 = primero) + funcionalidad de acceso
    // VISIBLE PARA TODOS LOS PERFILES (es el panel personal de cada usuario).
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (440001, 'Mi Día', 'Panel personal de bienvenida: tus pendientes del día, tus colocaciones y tu agenda de Google Calendar', 'bi-sunrise', '/mi-dia/', 0, 'activo')`);
    const [[exf]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mi_dia' LIMIT 1");
    let idMiDia = exf && exf.id_funcionalidad;
    if (!idMiDia) { const [r] = await pool.query("INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (440001,'Mi Día','mi_dia','/mi-dia/','bi-sunrise')"); idMiDia = r.insertId; }
    // Permiso para todos los perfiles activos
    const [perfilesAll] = await pool.query('SELECT id_perfil FROM perfiles');
    for (const p of perfilesAll) {
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [p.id_perfil, idMiDia]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [p.id_perfil, idMiDia]);
    }
    // Mantenedor de configuración (solo Admin por defecto)
    const [[m]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' LIMIT 1");
    if (m) {
      const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_mi_dia' LIMIT 1");
      let idf = ex && ex.id_funcionalidad;
      if (!idf) { const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)', [m.id_modulo, 'Panel Mi Día', 'mant_mi_dia', '/mantenedores/mi-dia/', 'bi-sunrise']); idf = r.insertId; }
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    }
  } catch (e) { console.error('[mi-dia migration]', e.message); }
})();

/* ── Saludo según hora Chile ─────────────────────────────────────────────── */
function saludo() {
  const h = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Santiago', hour: '2-digit', hour12: false }).format(new Date()), 10);
  if (h < 12) return 'Buenos días';
  if (h < 20) return 'Buenas tardes';
  return 'Buenas noches';
}

/* ── GET /api/mi-dia ─────────────────────────────────────────────────────── */
const panel = async (req, res) => {
  try {
    const u = req.usuario || {};
    const idPerfil = u.id_perfil;
    // Widgets configurados para el perfil (activos), ordenados
    let cfg = [];
    try { const [rows] = await pool.query('SELECT codigo, orden FROM mi_dia_config WHERE id_perfil=? AND activo=1 ORDER BY orden', [idPerfil]); cfg = rows; } catch (_) {}
    const codigos = cfg.map(r => r.codigo).filter(c => WIDGET_MAP[c]);
    const esAdmin = norm(u.perfil_nombre) === 'ADMINISTRADOR';

    const widgets = [];
    for (const codigo of codigos) {
      const w = WIDGET_MAP[codigo];
      // Widgets de pool exigen el permiso real (Admin pasa). Personales van directo.
      if (w.scope === 'pool' && !esAdmin && w.permiso && w.permiso.length) {
        const ok = await tieneFunc(u.id_usuario, ...w.permiso);
        if (!ok) continue;
      }
      let n = 0;
      try { n = await w.get(u); } catch (_) { n = 0; }
      widgets.push({ codigo, nombre: w.nombre, icono: w.icono, color: w.color, href: w.href, destacado: !!w.destacado, n });
    }

    // Google Calendar del usuario
    let calendario = { disponible: G.configurado(), conectado: false, eventos: [] };
    if (G.configurado()) {
      const est = await G.estado(u.id_usuario);
      calendario.conectado = est.conectado;
      calendario.email = est.email;
      if (est.conectado) { const ev = await G.eventosHoy(u.id_usuario); calendario.eventos = ev || []; }
    }

    res.json({ success: true, data: {
      saludo: saludo(), nombre: (u.nombre || '').trim(),
      fecha: new Intl.DateTimeFormat('es-CL', { timeZone: 'America/Santiago', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()),
      widgets, calendario,
    }, error: null });
  } catch (e) { console.error('[mi-dia panel]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Mantenedor: catálogo + config por perfil ────────────────────────────── */
const catalogo = async (req, res) => {
  try {
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles ORDER BY nombre');
    const [rows] = await pool.query('SELECT id_perfil, codigo, activo FROM mi_dia_config');
    const cfg = {};
    rows.forEach(r => { (cfg[r.id_perfil] = cfg[r.id_perfil] || {})[r.codigo] = !!r.activo; });
    res.json({ success: true, data: {
      widgets: WIDGETS.map(w => ({ codigo: w.codigo, nombre: w.nombre, icono: w.icono, scope: w.scope })),
      perfiles, config: cfg,
    }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const guardarConfig = async (req, res) => {
  try {
    const { id_perfil, activos } = req.body || {};
    if (!id_perfil || !Array.isArray(activos)) return res.status(400).json({ success: false, data: null, error: 'Falta id_perfil o activos[]' });
    const validos = activos.filter(c => WIDGET_MAP[c]);
    await pool.query('DELETE FROM mi_dia_config WHERE id_perfil=?', [id_perfil]);
    let orden = 0;
    for (const c of validos) await pool.query('INSERT INTO mi_dia_config (id_perfil, codigo, activo, orden) VALUES (?,?,1,?)', [id_perfil, c, orden++]);
    require('../../../../shared/audit').auditar({ req, accion: 'EDITAR', modulo: 'mi-dia', entidad: 'config', entidad_id: id_perfil, detalle: `Widgets Mi Día del perfil ${id_perfil}: ${validos.join(', ') || '(ninguno)'}` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Google OAuth ────────────────────────────────────────────────────────── */
const googleConnect = async (req, res) => {
  try {
    if (!G.configurado()) return res.status(503).json({ success: false, data: null, error: 'Google Calendar no está configurado en el servidor' });
    res.json({ success: true, data: { url: G.authUrl(req.usuario.id_usuario) }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const googleCallback = async (req, res) => {
  const cerrar = (msg, ok) => res.send(`<!doctype html><meta charset="utf-8"><body style="font-family:Segoe UI,system-ui,sans-serif;text-align:center;padding:60px;color:#1e293b"><div style="font-size:52px">${ok ? '✅' : '⚠️'}</div><h2>${msg}</h2><p style="color:#64748b">Puedes cerrar esta ventana.</p><script>setTimeout(()=>{window.close()},1500)</script></body>`);
  try {
    if (req.query.error) return cerrar('No se autorizó el acceso a Google Calendar', false);
    await G.guardarDesdeCallback(req.query.code, req.query.state);
    cerrar('¡Google Calendar conectado!', true);
  } catch (e) { console.error('[google callback]', e.message); cerrar('No se pudo conectar Google Calendar', false); }
};
const googleStatus = async (req, res) => {
  try { res.json({ success: true, data: await G.estado(req.usuario.id_usuario), error: null }); }
  catch (e) { res.status(500).json({ success: false, data: null, error: 'Error' }); }
};
const googleDisconnect = async (req, res) => {
  try { await G.desconectar(req.usuario.id_usuario); res.json({ success: true, data: { ok: true }, error: null }); }
  catch (e) { res.status(500).json({ success: false, data: null, error: 'Error' }); }
};

module.exports = { panel, catalogo, guardarConfig, googleConnect, googleCallback, googleStatus, googleDisconnect };
