'use strict';
/* ───────────────────────────────────────────────────────────────────
   Calendario de Visitas de Concesionarios + Bitácora de gestiones.

   - Configuración paramétrica: N° de visitas por día + días de la semana
     habilitados (visitas_config, singleton).
   - Agenda/calendario: visitas programadas a un dealer en una fecha,
     respetando los días habilitados y el tope diario POR USUARIO.
   - Gestión/bitácora: al realizar la visita el usuario registra el
     resultado (POSITIVO/NEGATIVO) + comentarios + seguimiento con fecha.
   - El usuario gestiona lo suyo; Supervisor/Gerentes (visitas_supervisar)
     revisan todas las gestiones y el calendario de todos, y configuran.
   ─────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { tieneFunc } = require('../../../../shared/middleware/permisos');

const DIAS_DEFAULT = '1,2,3,4,5'; // ISO: 1=Lun … 7=Dom

/* ─── Migración + seed de permisos ─────────────────────────────────── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitas_config (
        id          TINYINT      PRIMARY KEY DEFAULT 1,
        visitas_dia INT          NOT NULL DEFAULT 4,
        dias_semana VARCHAR(20)  NOT NULL DEFAULT '1,2,3,4,5',
        updated_at  DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        updated_by  VARCHAR(150) NULL
      )`);
    await pool.query(
      `INSERT IGNORE INTO visitas_config (id, visitas_dia, dias_semana) VALUES (1, 4, ?)`, [DIAS_DEFAULT]);
    // Parámetros del planificador de rutas
    await pool.query("ALTER TABLE visitas_config ADD COLUMN IF NOT EXISTS hora_inicio VARCHAR(5) DEFAULT '09:00'").catch(() => {});
    await pool.query("ALTER TABLE visitas_config ADD COLUMN IF NOT EXISTS hora_fin   VARCHAR(5) DEFAULT '18:00'").catch(() => {});
    await pool.query("ALTER TABLE visitas_config ADD COLUMN IF NOT EXISTS duracion_min INT     DEFAULT 45").catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitas_dealers (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        id_dealer        INT          NULL,
        rut_dealer       VARCHAR(20)  NULL,
        nombre_dealer    VARCHAR(200) NULL,
        comuna           VARCHAR(120) NULL,
        fecha_programada DATE         NOT NULL,
        id_usuario       INT          NULL,
        usuario_nombre   VARCHAR(200) NULL,
        estado           VARCHAR(20)  NOT NULL DEFAULT 'PROGRAMADA',
        resultado        VARCHAR(10)  NULL,
        comentarios      TEXT         NULL,
        fecha_realizada  DATETIME     NULL,
        seguimiento_fecha DATE        NULL,
        seguimiento_nota VARCHAR(400) NULL,
        created_at       DATETIME     DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_fecha (fecha_programada),
        INDEX idx_usuario (id_usuario),
        INDEX idx_dealer (id_dealer),
        INDEX idx_estado (estado),
        INDEX idx_seg (seguimiento_fecha)
      )`);

    // Permisos paramétricos
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' LIMIT 1");
    if (mod) {
      const ensure = async (nombre, codigo, filtroPerfiles) => {
        const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [codigo]);
        let idF = ex?.id_funcionalidad;
        if (!idF) {
          const [ins] = await pool.query(
            'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,?)',
            [mod.id_modulo, nombre, codigo, null]);
          idF = ins.insertId;
        }
        await pool.query(
          `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
             SELECT id_perfil, ?, 1 FROM perfiles WHERE ${filtroPerfiles}`, [idF]);
        return idF;
      };
      await ensure('Visitas de Dealers — gestionar', 'visitas_dealers',
        "nombre='Administrador' OR nombre LIKE 'Gerente%' OR nombre LIKE 'Supervisor%' OR nombre LIKE 'Ejecutivo%' OR nombre LIKE 'Comercial%'");
      await ensure('Visitas de Dealers — supervisar', 'visitas_supervisar',
        "nombre='Administrador' OR nombre LIKE 'Gerente%' OR nombre LIKE 'Supervisor%'");
    }
    /* ── Cartera de dealers: planes de asignación + asignaciones ──
       Un dealer solo puede tener UNA asignación ACTIVA (se valida en código). */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitas_planes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nombre VARCHAR(200) NOT NULL,
        fecha_inicio DATE NOT NULL,
        fecha_cierre DATE NOT NULL,
        params JSON NULL,
        estado VARCHAR(10) NOT NULL DEFAULT 'ACTIVO',    -- ACTIVO | CERRADO
        created_by INT NULL, created_nombre VARCHAR(150) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitas_asignaciones (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_dealer INT NOT NULL,
        rut_dealer VARCHAR(20) NULL,
        nombre_dealer VARCHAR(200) NULL,
        comuna VARCHAR(120) NULL,
        id_usuario INT NOT NULL,
        usuario_nombre VARCHAR(200) NULL,
        id_plan INT NULL,
        origen VARCHAR(12) NOT NULL DEFAULT 'INDIVIDUAL', -- MASIVA | INDIVIDUAL
        estado VARCHAR(10) NOT NULL DEFAULT 'ACTIVA',     -- ACTIVA | CERRADA
        created_by INT NULL, created_nombre VARCHAR(150) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        cerrada_at DATETIME NULL,
        INDEX idx_dealer (id_dealer, estado), INDEX idx_usuario (id_usuario, estado), INDEX idx_plan (id_plan)
      )`);
    await pool.query('ALTER TABLE visitas_dealers ADD COLUMN IF NOT EXISTS id_plan INT NULL').catch(() => {});
    await pool.query('ALTER TABLE visitas_dealers ADD COLUMN IF NOT EXISTS id_asignacion INT NULL').catch(() => {});
    console.log('✓ módulo visitas-dealers: tablas + permisos listos');
  } catch (e) { console.error('[visitas migration]', e.message); }
})();

/* ─── Helpers ──────────────────────────────────────────────────────── */
const ok  = (res, data) => res.json({ success: true, data, error: null });
const err = (res, code, msg) => res.status(code).json({ success: false, data: null, error: msg });
const isoDow = (ymd) => { const d = new Date(ymd + 'T12:00:00'); const n = d.getDay(); return n === 0 ? 7 : n; };
const nombreUsuario = u => [u?.nombre, u?.apellido].filter(Boolean).join(' ') || u?.email || 'Usuario';

// Extrae la comuna de la dirección normalizada por Google (geo_dir),
// formato típico CL: "Calle 123, 7550099 Las Condes, Región Metropolitana, Chile".
function comunaDeGeoDir(s) {
  if (!s) return '';
  let p = String(s).split(',').map(x => x.trim()).filter(Boolean)
    .filter(x => !/^chile$/i.test(x))
    .filter(x => !/regi[oó]n|metropolitana/i.test(x));
  if (p.length < 2) return ''; // solo calle, sin comuna fiable
  return p[p.length - 1].replace(/^\d{4,7}\s*/, '').trim(); // quita código postal
}
const comunaDe = d => d.comuna || d.comuna_parque || comunaDeGeoDir(d.geo_dir) || '';
const direccionDe = d => (d.geo_dir || d.direccion || d.direccion_parque || '').trim();

async function leerConfig() {
  const [[c]] = await pool.query('SELECT * FROM visitas_config WHERE id=1');
  const dias = String(c?.dias_semana || DIAS_DEFAULT).split(',').map(s => parseInt(s.trim())).filter(n => n >= 1 && n <= 7);
  return {
    visitas_dia: c?.visitas_dia || 4,
    dias_semana: dias,
    hora_inicio: c?.hora_inicio || '09:00',
    hora_fin: c?.hora_fin || '18:00',
    duracion_min: c?.duracion_min || 45,
  };
}

/* ─── GET /api/visitas/config ──────────────────────────────────────── */
const getConfig = async (req, res) => {
  try { ok(res, await leerConfig()); }
  catch (e) { console.error('[visitas getConfig]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── PUT /api/visitas/config (visitas_supervisar) ─────────────────── */
const putConfig = async (req, res) => {
  try {
    let { visitas_dia, dias_semana } = req.body || {};
    visitas_dia = parseInt(visitas_dia);
    if (!visitas_dia || visitas_dia < 1 || visitas_dia > 50) return err(res, 400, 'N° de visitas por día inválido (1-50).');
    const dias = (Array.isArray(dias_semana) ? dias_semana : String(dias_semana || '').split(','))
      .map(d => parseInt(d)).filter(n => n >= 1 && n <= 7);
    if (!dias.length) return err(res, 400, 'Debes habilitar al menos un día de la semana.');
    const hhmm = v => /^\d{1,2}:\d{2}$/.test(String(v || '')) ? v : null;
    const hi = hhmm(req.body.hora_inicio) || '09:00';
    const hf = hhmm(req.body.hora_fin) || '18:00';
    let dur = parseInt(req.body.duracion_min); if (!dur || dur < 5 || dur > 480) dur = 45;
    await pool.query(
      'UPDATE visitas_config SET visitas_dia=?, dias_semana=?, hora_inicio=?, hora_fin=?, duracion_min=?, updated_by=? WHERE id=1',
      [visitas_dia, [...new Set(dias)].sort((a, b) => a - b).join(','), hi, hf, dur, nombreUsuario(req.usuario)]);
    auditar({ req, accion: 'EDITAR', modulo: 'visitas', entidad: 'config', entidad_id: 1,
      detalle: `Config visitas: ${visitas_dia}/día · días ${dias.join(',')} · ${hi}-${hf} · ${dur}min` });
    ok(res, await leerConfig());
  } catch (e) { console.error('[visitas putConfig]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── GET /api/visitas/dealers — selector ──────────────────────────── */
const getDealers = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_dealer, rut,
              COALESCE(NULLIF(TRIM(nombre_indexa),''), NULLIF(TRIM(nombre_razon),''), rut) AS nombre,
              comuna, comuna_parque, geo_dir
         FROM dealers ORDER BY nombre LIMIT 5000`);
    ok(res, rows.map(d => ({ id_dealer: d.id_dealer, rut: d.rut, nombre: d.nombre, comuna: comunaDe(d) })));
  } catch (e) { console.error('[visitas getDealers]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── GET /api/visitas/planificador — dealers + coords + estado + última venta ─
   Devuelve TODOS los dealers; el frontend optimiza la ruta y filtra por estado.
   en_riesgo = activo y sin crédito cursado en los últimos 90 días. */
const planificador = async (req, res) => {
  try {
    const [dealers] = await pool.query(
      `SELECT id_dealer, rut, numero,
              COALESCE(NULLIF(TRIM(nombre_indexa),''), NULLIF(TRIM(nombre_razon),''), rut) AS nombre,
              comuna, comuna_parque, geo_dir, direccion, direccion_parque,
              lat, lng, activo, categoria_asignada, ccs_parque, tipo_ficha
         FROM dealers ORDER BY nombre`);
    // Última venta (crédito otorgado) por RUT de dealer
    let ult = [];
    try {
      [ult] = await pool.query(
        `SELECT rut_dealer, MAX(fecha_otorgado) AS ultima, COUNT(*) AS n
           FROM creditos WHERE rut_dealer IS NOT NULL AND fecha_otorgado IS NOT NULL
          GROUP BY rut_dealer`);
    } catch (_) { ult = []; }
    const norm = s => String(s || '').replace(/[.\-\s]/g, '').toUpperCase();
    const mUlt = new Map(); ult.forEach(r => mUlt.set(norm(r.rut_dealer), { ultima: r.ultima, n: r.n }));
    const lim90 = Date.now() - 90 * 86400000;
    const rows = dealers.map(d => {
      const u = mUlt.get(norm(d.rut));
      const ultima = u ? u.ultima : null;
      const en_riesgo = d.activo == 1 && (!ultima || new Date(ultima).getTime() < lim90);
      return {
        id_dealer: d.id_dealer, rut: d.rut, nombre: d.nombre, comuna: comunaDe(d), direccion: direccionDe(d),
        lat: d.lat != null ? Number(d.lat) : null, lng: d.lng != null ? Number(d.lng) : null,
        activo: d.activo, categoria: d.categoria_asignada || null,
        ccs_parque: d.ccs_parque || null, tipo_ficha: d.tipo_ficha || null,
        ultimo_credito: ultima, creditos_total: u ? u.n : 0, en_riesgo,
      };
    });
    ok(res, { rows, config: await leerConfig() });
  } catch (e) { console.error('[visitas planificador]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── GET /api/visitas?desde=&hasta=&estado=&resultado=&usuario=&scope= ─ */
const listar = async (req, res) => {
  try {
    const uid = req.usuario.id_usuario;
    const esRevisor = await tieneFunc(uid, 'visitas_supervisar');
    const { desde, hasta, estado, resultado, usuario } = req.query;
    const scopeTodos = esRevisor && String(req.query.scope || '') === 'todos';

    const where = [], pars = [];
    if (!esRevisor) { where.push('id_usuario = ?'); pars.push(uid); }
    else if (!scopeTodos && !usuario) { where.push('id_usuario = ?'); pars.push(uid); }   // por defecto el revisor ve lo suyo
    else if (usuario) { where.push('id_usuario = ?'); pars.push(parseInt(usuario) || 0); }
    if (desde) { where.push('fecha_programada >= ?'); pars.push(desde); }
    if (hasta) { where.push('fecha_programada <= ?'); pars.push(hasta); }
    if (estado) { where.push('estado = ?'); pars.push(estado); }
    if (resultado) { where.push('resultado = ?'); pars.push(resultado); }

    const [rows] = await pool.query(
      `SELECT * FROM visitas_dealers
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY fecha_programada DESC, id DESC LIMIT 2000`, pars);

    // Lista de usuarios con visitas (para el filtro del revisor)
    let usuarios = [];
    if (esRevisor) {
      const [u] = await pool.query(
        'SELECT DISTINCT id_usuario, usuario_nombre FROM visitas_dealers WHERE id_usuario IS NOT NULL ORDER BY usuario_nombre');
      usuarios = u;
    }
    ok(res, { rows, esRevisor, usuarios });
  } catch (e) { console.error('[visitas listar]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── POST /api/visitas (visitas_dealers) — agendar ────────────────── */
const crear = async (req, res) => {
  try {
    const { id_dealer, rut_dealer, nombre_dealer, comuna, fecha_programada } = req.body || {};
    if (!fecha_programada || !/^\d{4}-\d{2}-\d{2}$/.test(fecha_programada)) return err(res, 400, 'Fecha de visita inválida.');
    if (!nombre_dealer && !id_dealer && !rut_dealer) return err(res, 400, 'Debes seleccionar un concesionario.');

    const cfg = await leerConfig();
    if (!cfg.dias_semana.includes(isoDow(fecha_programada)))
      return err(res, 400, 'Ese día de la semana no está habilitado para visitas.');

    const uid = req.usuario.id_usuario;
    const [[cnt]] = await pool.query(
      'SELECT COUNT(*) AS n FROM visitas_dealers WHERE id_usuario=? AND fecha_programada=?', [uid, fecha_programada]);
    if (cnt.n >= cfg.visitas_dia)
      return err(res, 400, `Tope alcanzado: ya tienes ${cfg.visitas_dia} visita(s) ese día.`);

    const [r] = await pool.query(
      `INSERT INTO visitas_dealers
         (id_dealer, rut_dealer, nombre_dealer, comuna, fecha_programada, id_usuario, usuario_nombre, estado)
       VALUES (?,?,?,?,?,?,?, 'PROGRAMADA')`,
      [id_dealer || null, rut_dealer || null, nombre_dealer || null, comuna || null,
       fecha_programada, uid, nombreUsuario(req.usuario)]);
    auditar({ req, accion: 'CREAR', modulo: 'visitas', entidad: 'visita', entidad_id: r.insertId,
      detalle: `Visita agendada a ${nombre_dealer || rut_dealer || '—'} para ${fecha_programada}`, rut: rut_dealer });
    ok(res, { id: r.insertId });
  } catch (e) { console.error('[visitas crear]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── PUT /api/visitas/:id/gestion (visitas_dealers) — registrar ──── */
const gestionar = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { resultado, comentarios, seguimiento_fecha, seguimiento_nota } = req.body || {};
    if (!['POSITIVO', 'NEGATIVO'].includes(resultado)) return err(res, 400, 'Resultado debe ser POSITIVO o NEGATIVO.');
    if (seguimiento_fecha && !/^\d{4}-\d{2}-\d{2}$/.test(seguimiento_fecha)) return err(res, 400, 'Fecha de seguimiento inválida.');

    const [[v]] = await pool.query('SELECT id_usuario FROM visitas_dealers WHERE id=?', [id]);
    if (!v) return err(res, 404, 'Visita no encontrada.');
    const uid = req.usuario.id_usuario;
    if (v.id_usuario !== uid && !(await tieneFunc(uid, 'visitas_supervisar')))
      return err(res, 403, 'Solo puedes registrar tus propias visitas.');

    await pool.query(
      `UPDATE visitas_dealers
          SET estado='REALIZADA', resultado=?, comentarios=?, fecha_realizada=NOW(),
              seguimiento_fecha=?, seguimiento_nota=?
        WHERE id=?`,
      [resultado, comentarios || null, seguimiento_fecha || null, seguimiento_nota || null, id]);
    auditar({ req, accion: 'GESTION', modulo: 'visitas', entidad: 'visita', entidad_id: id,
      detalle: `Visita ${resultado}${seguimiento_fecha ? ' · seguimiento ' + seguimiento_fecha : ''}` });
    ok(res, { id });
  } catch (e) { console.error('[visitas gestionar]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── DELETE /api/visitas/:id ──────────────────────────────────────── */
const eliminar = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [[v]] = await pool.query('SELECT id_usuario, estado, nombre_dealer FROM visitas_dealers WHERE id=?', [id]);
    if (!v) return err(res, 404, 'Visita no encontrada.');
    const uid = req.usuario.id_usuario;
    const esRevisor = await tieneFunc(uid, 'visitas_supervisar');
    if (v.id_usuario !== uid && !esRevisor) return err(res, 403, 'Sin permiso para eliminar esta visita.');
    if (v.estado === 'REALIZADA' && !esRevisor) return err(res, 403, 'Una visita realizada solo la puede eliminar un supervisor.');
    await pool.query('DELETE FROM visitas_dealers WHERE id=?', [id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'visitas', entidad: 'visita', entidad_id: id,
      detalle: `Visita eliminada (${v.nombre_dealer || '—'})` });
    ok(res, { id });
  } catch (e) { console.error('[visitas eliminar]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ═══════════════════ ASIGNACIÓN DE CARTERA ═══════════════════ */
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');

/* ─── GET /api/visitas/ejecutivos — comerciales asignables (supervisar) ── */
const ejecutivos = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id_usuario, CONCAT(u.nombre,' ',u.apellido) nombre, p.nombre perfil
         FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
        WHERE u.estado='activo'
          AND (u.protegido IS NULL OR u.protegido=0)   -- fuera cuentas de sistema (BG-ADMIN)
          AND p.nombre LIKE '%Comercial%'              -- solo área comercial: Ejecutivo/Supervisor/Jefe/Gerente Comercial
        ORDER BY p.nombre, nombre`);
    ok(res, rows);
  } catch (e) { console.error('[visitas ejecutivos]', e); err(res, 500, 'Error interno del servidor'); }
};

/* Última visita REALIZADA por dealer (Map id_dealer → fecha) */
async function ultimaVisitaMap() {
  const [rows] = await pool.query(
    `SELECT id_dealer, MAX(COALESCE(fecha_realizada, fecha_programada)) ult
       FROM visitas_dealers WHERE estado='REALIZADA' AND id_dealer IS NOT NULL GROUP BY id_dealer`);
  return new Map(rows.map(r => [r.id_dealer, r.ult]));
}

/* Zonificación: comunas con muchos dealers se parten en 2/3/4 zonas
   geográficas (cuadrantes por lat/lng) para que los bloques queden
   equivalentes al resto de las comunas (~25 dealers por zona). */
const mediana = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
function zonificar(cands, objetivo = 25) {
  const porComuna = {};
  for (const d of cands) (porComuna[d.comuna] = porComuna[d.comuna] || []).push(d);
  const zonas = [];
  for (const [com, ds] of Object.entries(porComuna)) {
    const k = Math.min(4, Math.ceil(ds.length / objetivo));
    if (k <= 1) { ds.forEach(d => d.zona = com); zonas.push({ zona: com, n: ds.length }); continue; }
    const conGeo = ds.filter(d => d.lat != null && d.lng != null);
    const sinGeo = ds.filter(d => d.lat == null || d.lng == null);
    // partición balanceada recursiva: corta por el eje geográfico más ancho
    // en proporción al n° de zonas → grupos de tamaño similar y coherentes
    const partir = (arr, kk) => {
      if (kk <= 1 || arr.length <= 1) return [arr];
      const k1 = Math.floor(kk / 2), k2 = kk - k1;
      const span = eje => { const v = arr.map(d => +d[eje]); return Math.max(...v) - Math.min(...v); };
      const eje = span('lat') >= span('lng') ? 'lat' : 'lng';
      const sorted = [...arr].sort((a, b) => +a[eje] - +b[eje]);
      const corte = Math.round(sorted.length * k1 / kk);
      return [...partir(sorted.slice(0, corte), k1), ...partir(sorted.slice(corte), k2)];
    };
    const grupos = partir(conGeo, k);
    while (grupos.length < k) grupos.push([]);
    sinGeo.forEach((d, i) => grupos[i % k].push(d));   // sin coordenadas: repartidos
    grupos.forEach((g, i) => {
      const z = `${com} — Zona ${i + 1}`;
      g.forEach(d => d.zona = z);
      if (g.length) zonas.push({ zona: z, n: g.length });
    });
  }
  return zonas.sort((a, b) => a.zona.localeCompare(b.zona, 'es'));
}

/* Candidatos a asignar: sin asignación ACTIVA, filtro estado (todos por
   defecto) + comuna/zona + plazo en meses desde la última visita (0 = todos). */
async function candidatosCartera({ comunas = [], meses = 0, estado = 'todos' }) {
  const fAct = estado === 'activos' ? 'activo=1' : estado === 'inactivos' ? 'activo=0' : '1=1';
  const [dealers] = await pool.query(
    `SELECT id_dealer, rut,
            COALESCE(NULLIF(TRIM(nombre_indexa),''), NULLIF(TRIM(nombre_razon),''), rut) AS nombre,
            comuna, comuna_parque, geo_dir, lat, lng
       FROM dealers WHERE ${fAct}`);
  const [asig] = await pool.query("SELECT id_dealer FROM visitas_asignaciones WHERE estado='ACTIVA'");
  const ocupados = new Set(asig.map(a => a.id_dealer));
  const mUlt = await ultimaVisitaMap();
  const limite = meses > 0 ? Date.now() - meses * 30.44 * 86400000 : null;
  let cands = dealers
    .map(d => ({ id_dealer: d.id_dealer, rut: d.rut, nombre: d.nombre, comuna: comunaDe(d) || 'SIN COMUNA',
                 lat: d.lat, lng: d.lng, ultima_visita: mUlt.get(d.id_dealer) || null }))
    .filter(d => !ocupados.has(d.id_dealer))
    .filter(d => !limite || !d.ultima_visita || new Date(d.ultima_visita).getTime() < limite);
  const zonas = zonificar(cands);                      // asigna d.zona a cada candidato
  const setZona = new Set((comunas || []).map(c => String(c).trim().toUpperCase()).filter(Boolean));
  if (setZona.size) cands = cands.filter(d => setZona.has(String(d.zona).toUpperCase()));
  return { cands, zonas };
}

/* ─── GET /api/visitas/zonas?estado=&meses= — comunas/zonas con conteo ── */
const zonasCartera = async (req, res) => {
  try {
    const { zonas } = await candidatosCartera({
      meses: Math.max(0, parseInt(req.query.meses, 10) || 0),
      estado: ['activos', 'inactivos'].includes(req.query.estado) ? req.query.estado : 'todos' });
    ok(res, zonas);
  } catch (e) { console.error('[visitas zonas]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── POST /api/visitas/asignacion-masiva (visitas_supervisar) ──────
   body: { nombre, fecha_inicio, fecha_cierre, ejecutivos:[ids], comunas:[],
           meses_ultima_visita, visitas_dia, dias_semana:[], simular } ── */
const asignacionMasiva = async (req, res) => {
  try {
    const b = req.body || {};
    const ymd = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    if (!ymd(b.fecha_inicio) || !ymd(b.fecha_cierre)) return err(res, 400, 'Fechas de inicio y cierre del plan requeridas.');
    if (b.fecha_cierre < b.fecha_inicio) return err(res, 400, 'La fecha de cierre debe ser posterior al inicio.');
    const ejecIds = [...new Set((b.ejecutivos || []).map(Number).filter(n => n > 0))];
    if (!ejecIds.length) return err(res, 400, 'Selecciona al menos un ejecutivo.');
    const meses = Math.max(0, parseInt(b.meses_ultima_visita, 10) || 0);
    const estado = ['activos', 'inactivos'].includes(b.estado) ? b.estado : 'todos';

    const cfg = await leerConfig();
    const visDia = Math.min(50, Math.max(1, parseInt(b.visitas_dia, 10) || cfg.visitas_dia));
    const dias = (Array.isArray(b.dias_semana) && b.dias_semana.length ? b.dias_semana : cfg.dias_semana)
      .map(Number).filter(n => n >= 1 && n <= 7);

    // nombres de los ejecutivos
    const [us] = await pool.query(
      `SELECT id_usuario, CONCAT(nombre,' ',apellido) nombre FROM usuarios WHERE id_usuario IN (${ejecIds.map(() => '?').join(',')})`, ejecIds);
    const nomEjec = new Map(us.map(u => [u.id_usuario, u.nombre]));
    if (nomEjec.size !== ejecIds.length) return err(res, 400, 'Hay ejecutivos inexistentes.');

    const { cands: cand } = await candidatosCartera({ comunas: b.comunas, meses, estado });
    if (!cand.length) return err(res, 400, 'No hay dealers candidatos con esos filtros (¿ya están todos asignados?).');

    // Reparto por BLOQUES DE COMUNA/ZONA (coherencia geográfica): cada bloque
    // al ejecutivo con menos carga. Bloques más grandes que la cuota justa se
    // parten en trozos para que una zona gigante no se vaya entera a uno solo.
    const porComuna = {};
    for (const d of cand) (porComuna[d.zona] = porComuna[d.zona] || []).push(d);
    const cuota = Math.ceil(cand.length / ejecIds.length);
    const bloques = [];
    for (const [com, ds] of Object.entries(porComuna))
      for (let i = 0; i < ds.length; i += cuota) bloques.push([com, ds.slice(i, i + cuota)]);
    bloques.sort((a, b2) => b2[1].length - a[1].length);
    const carga = new Map(ejecIds.map(id => [id, []]));
    for (const [, ds] of bloques) {
      const idMin = [...carga.entries()].sort((a, b2) => a[1].length - b2[1].length)[0][0];
      carga.get(idMin).push(...ds);
    }

    // Fechas hábiles del plan
    const fechas = [];
    for (let t = new Date(b.fecha_inicio + 'T12:00:00'); ; t.setDate(t.getDate() + 1)) {
      const f = t.toISOString().slice(0, 10);
      if (f > b.fecha_cierre) break;
      if (dias.includes(isoDow(f))) fechas.push(f);
    }
    const capacidad = fechas.length * visDia;

    const resumen = [...carga.entries()].map(([id, ds]) => ({
      id_usuario: id, nombre: nomEjec.get(id), dealers: ds.length,
      agendables: Math.min(ds.length, capacidad), sin_agenda: Math.max(0, ds.length - capacidad),
      comunas: [...new Set(ds.map(d => d.zona))],
    }));
    if (b.simular) return ok(res, { simulacion: true, candidatos: cand.length, fechas_habiles: fechas.length,
      capacidad_por_ejecutivo: capacidad, por_ejecutivo: resumen });

    // ── Ejecutar: plan + asignaciones + agenda ──
    const [rp] = await pool.query(
      `INSERT INTO visitas_planes (nombre, fecha_inicio, fecha_cierre, params, created_by, created_nombre)
       VALUES (?,?,?,?,?,?)`,
      [(b.nombre || `Plan ${b.fecha_inicio}`).slice(0, 200), b.fecha_inicio, b.fecha_cierre,
       JSON.stringify({ comunas: b.comunas || [], meses_ultima_visita: meses, estado, visitas_dia: visDia, dias_semana: dias, ejecutivos: ejecIds }),
       req.usuario.id_usuario, nombreUsuario(req.usuario)]);
    const idPlan = rp.insertId;

    let asignadas = 0, agendadas = 0;
    for (const [idU, ds] of carga.entries()) {
      let slot = 0;
      for (const d of ds) {
        const [ra] = await pool.query(
          `INSERT INTO visitas_asignaciones (id_dealer, rut_dealer, nombre_dealer, comuna, id_usuario, usuario_nombre, id_plan, origen, created_by, created_nombre)
           VALUES (?,?,?,?,?,?,?, 'MASIVA', ?, ?)`,
          [d.id_dealer, d.rut, d.nombre, d.zona, idU, nomEjec.get(idU), idPlan, req.usuario.id_usuario, nombreUsuario(req.usuario)]);
        asignadas++;
        const fecha = fechas[Math.floor(slot / visDia)];
        if (fecha) {
          await pool.query(
            `INSERT INTO visitas_dealers (id_dealer, rut_dealer, nombre_dealer, comuna, fecha_programada, id_usuario, usuario_nombre, estado, id_plan, id_asignacion)
             VALUES (?,?,?,?,?,?,?, 'PROGRAMADA', ?, ?)`,
            [d.id_dealer, d.rut, d.nombre, d.zona, fecha, idU, nomEjec.get(idU), idPlan, ra.insertId]);
          agendadas++; slot++;
        }
      }
      notificar([idU], { tipo: 'visitas', titulo: '📋 Cartera de dealers asignada',
        mensaje: `Se te asignaron ${ds.length} dealers (plan «${b.nombre || b.fecha_inicio}»). Revisa tu calendario de visitas.`,
        href: '/dealers-visitas/' }).catch(() => {});
    }
    auditar({ req, accion: 'CREAR', modulo: 'visitas', entidad: 'plan', entidad_id: idPlan,
      detalle: `Asignación masiva «${b.nombre || ''}»: ${asignadas} dealers a ${ejecIds.length} ejecutivos (${agendadas} visitas agendadas)` });
    ok(res, { id_plan: idPlan, asignadas, agendadas, por_ejecutivo: resumen });
  } catch (e) { console.error('[visitas asignacionMasiva]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── GET /api/visitas/asignaciones ─────────────────────────────────── */
const listarAsignaciones = async (req, res) => {
  try {
    const uid = req.usuario.id_usuario;
    const esRevisor = await tieneFunc(uid, 'visitas_supervisar');
    const where = [], pars = [];
    if (!esRevisor) { where.push('a.id_usuario=?'); pars.push(uid); }
    else if (req.query.usuario) { where.push('a.id_usuario=?'); pars.push(parseInt(req.query.usuario) || 0); }
    if (req.query.plan) { where.push('a.id_plan=?'); pars.push(parseInt(req.query.plan) || 0); }
    where.push('a.estado=?'); pars.push(req.query.estado === 'CERRADA' ? 'CERRADA' : 'ACTIVA');
    const [rows] = await pool.query(
      `SELECT a.*, p.nombre plan_nombre, p.fecha_inicio, p.fecha_cierre
         FROM visitas_asignaciones a LEFT JOIN visitas_planes p ON p.id=a.id_plan
        WHERE ${where.join(' AND ')} ORDER BY a.usuario_nombre, a.comuna, a.nombre_dealer LIMIT 3000`, pars);
    const mUlt = await ultimaVisitaMap();
    rows.forEach(r => r.ultima_visita = mUlt.get(r.id_dealer) || null);
    ok(res, { rows, esRevisor });
  } catch (e) { console.error('[visitas listarAsignaciones]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── POST /api/visitas/asignaciones — individual (supervisar) ─────── */
const crearAsignacion = async (req, res) => {
  try {
    const { id_dealer, id_usuario } = req.body || {};
    if (!id_dealer || !id_usuario) return err(res, 400, 'Dealer y ejecutivo son obligatorios.');
    const [[ya]] = await pool.query(
      "SELECT usuario_nombre FROM visitas_asignaciones WHERE id_dealer=? AND estado='ACTIVA'", [id_dealer]);
    if (ya) return err(res, 400, `Ese dealer ya está asignado a ${ya.usuario_nombre}. Cierra esa asignación primero.`);
    const [[d]] = await pool.query(
      `SELECT id_dealer, rut, COALESCE(NULLIF(TRIM(nombre_indexa),''), NULLIF(TRIM(nombre_razon),''), rut) nombre,
              comuna, comuna_parque, geo_dir FROM dealers WHERE id_dealer=?`, [id_dealer]);
    if (!d) return err(res, 404, 'Dealer no existe.');
    const [[u]] = await pool.query("SELECT CONCAT(nombre,' ',apellido) nombre FROM usuarios WHERE id_usuario=?", [id_usuario]);
    if (!u) return err(res, 404, 'Ejecutivo no existe.');
    const [r] = await pool.query(
      `INSERT INTO visitas_asignaciones (id_dealer, rut_dealer, nombre_dealer, comuna, id_usuario, usuario_nombre, origen, created_by, created_nombre)
       VALUES (?,?,?,?,?,?, 'INDIVIDUAL', ?, ?)`,
      [d.id_dealer, d.rut, d.nombre, comunaDe(d) || null, id_usuario, u.nombre, req.usuario.id_usuario, nombreUsuario(req.usuario)]);
    notificar([id_usuario], { tipo: 'visitas', titulo: '📋 Dealer asignado a tu cartera',
      mensaje: `Se te asignó ${d.nombre}. Agéndalo en tu calendario de visitas.`, href: '/dealers-visitas/' }).catch(() => {});
    auditar({ req, accion: 'CREAR', modulo: 'visitas', entidad: 'asignacion', entidad_id: r.insertId,
      detalle: `Asignó ${d.nombre} a ${u.nombre}`, rut: d.rut });
    ok(res, { id: r.insertId });
  } catch (e) { console.error('[visitas crearAsignacion]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── DELETE /api/visitas/asignaciones/:id — cerrar (supervisar) ────── */
const cerrarAsignacion = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [[a]] = await pool.query("SELECT * FROM visitas_asignaciones WHERE id=? AND estado='ACTIVA'", [id]);
    if (!a) return err(res, 404, 'Asignación no encontrada o ya cerrada.');
    await pool.query("UPDATE visitas_asignaciones SET estado='CERRADA', cerrada_at=NOW() WHERE id=?", [id]);
    // borrar visitas futuras aún no realizadas de esa asignación
    const [rd] = await pool.query(
      "DELETE FROM visitas_dealers WHERE id_asignacion=? AND estado='PROGRAMADA' AND fecha_programada>=CURDATE()", [id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'visitas', entidad: 'asignacion', entidad_id: id,
      detalle: `Cerró asignación de ${a.nombre_dealer} (${a.usuario_nombre}); ${rd.affectedRows} visitas futuras borradas` });
    ok(res, { cerrada: true, visitas_borradas: rd.affectedRows });
  } catch (e) { console.error('[visitas cerrarAsignacion]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── GET /api/visitas/planes + PUT /planes/:id/cerrar (supervisar) ── */
const listarPlanes = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*,
        (SELECT COUNT(*) FROM visitas_asignaciones a WHERE a.id_plan=p.id) asignaciones,
        (SELECT COUNT(*) FROM visitas_dealers v WHERE v.id_plan=p.id) visitas,
        (SELECT COUNT(*) FROM visitas_dealers v WHERE v.id_plan=p.id AND v.estado='REALIZADA') realizadas
       FROM visitas_planes p ORDER BY p.id DESC LIMIT 200`);
    ok(res, rows);
  } catch (e) { console.error('[visitas listarPlanes]', e); err(res, 500, 'Error interno del servidor'); }
};
const cerrarPlan = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [[p]] = await pool.query("SELECT * FROM visitas_planes WHERE id=? AND estado='ACTIVO'", [id]);
    if (!p) return err(res, 404, 'Plan no encontrado o ya cerrado.');
    await pool.query("UPDATE visitas_planes SET estado='CERRADO' WHERE id=?", [id]);
    await pool.query("UPDATE visitas_asignaciones SET estado='CERRADA', cerrada_at=NOW() WHERE id_plan=? AND estado='ACTIVA'", [id]);
    const [rd] = await pool.query(
      "DELETE FROM visitas_dealers WHERE id_plan=? AND estado='PROGRAMADA' AND fecha_programada>=CURDATE()", [id]);
    auditar({ req, accion: 'EDITAR', modulo: 'visitas', entidad: 'plan', entidad_id: id,
      detalle: `Cerró plan «${p.nombre}» (${rd.affectedRows} visitas futuras borradas)` });
    ok(res, { cerrado: true, visitas_borradas: rd.affectedRows });
  } catch (e) { console.error('[visitas cerrarPlan]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── GET /api/visitas/ficha-dia?fecha=&usuario= — ficha imprimible ── */
const fichaDia = async (req, res) => {
  try {
    const uid = req.usuario.id_usuario;
    const esRevisor = await tieneFunc(uid, 'visitas_supervisar');
    const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.fecha || '')) ? req.query.fecha : null;
    if (!fecha) return err(res, 400, 'Fecha requerida.');
    const idU = esRevisor && req.query.usuario ? (parseInt(req.query.usuario) || uid) : uid;
    const [rows] = await pool.query(
      `SELECT v.*, d.direccion, d.direccion_parque, d.geo_dir, d.contacto, d.telefono, d.correo,
              d.cf_nombre, d.cf_telefono, d.categoria_asignada, d.lat, d.lng, d.ccs_parque, d.tipo_ficha,
              d.com_6_12, d.com_13_24, d.com_25_36, d.com_37
         FROM visitas_dealers v LEFT JOIN dealers d ON d.id_dealer=v.id_dealer
        WHERE v.fecha_programada=? AND v.id_usuario=? ORDER BY v.id`, [fecha, idU]);
    // última venta por dealer
    let ult = [];
    try {
      [ult] = await pool.query(
        `SELECT rut_dealer, MAX(fecha_otorgado) ultima, COUNT(*) n FROM creditos
          WHERE rut_dealer IS NOT NULL AND fecha_otorgado IS NOT NULL GROUP BY rut_dealer`);
    } catch (_) {}
    const norm = s => String(s || '').replace(/[.\-\s]/g, '').toUpperCase();
    const mU = new Map(ult.map(r => [norm(r.rut_dealer), r]));
    const data = rows.map(v => ({ ...v, direccion_visita: (v.geo_dir || v.direccion || v.direccion_parque || '').trim(),
      ultima_venta: mU.get(norm(v.rut_dealer))?.ultima || null, creditos_total: mU.get(norm(v.rut_dealer))?.n || 0 }));
    const [[u]] = await pool.query("SELECT CONCAT(nombre,' ',apellido) nombre FROM usuarios WHERE id_usuario=?", [idU]);
    ok(res, { fecha, usuario: u?.nombre || '', visitas: data });
  } catch (e) { console.error('[visitas fichaDia]', e); err(res, 500, 'Error interno del servidor'); }
};

/* ─── GET /api/visitas/stats?plan=&desde=&hasta= (supervisar: grupal) ── */
const stats = async (req, res) => {
  try {
    const uid = req.usuario.id_usuario;
    const esRevisor = await tieneFunc(uid, 'visitas_supervisar');
    const where = [], pars = [];
    if (!esRevisor) { where.push('v.id_usuario=?'); pars.push(uid); }
    if (req.query.plan) { where.push('v.id_plan=?'); pars.push(parseInt(req.query.plan) || 0); }
    if (req.query.desde) { where.push('v.fecha_programada>=?'); pars.push(req.query.desde); }
    if (req.query.hasta) { where.push('v.fecha_programada<=?'); pars.push(req.query.hasta); }
    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [[tot]] = await pool.query(
      `SELECT COUNT(*) programadas, SUM(estado='REALIZADA') realizadas,
              SUM(resultado='POSITIVO') positivas, SUM(resultado='NEGATIVO') negativas,
              COUNT(DISTINCT id_dealer) dealers, COUNT(DISTINCT id_usuario) ejecutivos
         FROM visitas_dealers v ${W}`, pars);
    const [porEjec] = await pool.query(
      `SELECT v.id_usuario, v.usuario_nombre,
              COUNT(*) programadas, SUM(v.estado='REALIZADA') realizadas,
              SUM(v.resultado='POSITIVO') positivas, SUM(v.resultado='NEGATIVO') negativas,
              COUNT(DISTINCT v.id_dealer) dealers,
              (SELECT COUNT(*) FROM visitas_asignaciones a WHERE a.id_usuario=v.id_usuario AND a.estado='ACTIVA') cartera
         FROM visitas_dealers v ${W} GROUP BY v.id_usuario, v.usuario_nombre ORDER BY realizadas DESC`, pars);
    const [planes] = await pool.query(
      `SELECT id, nombre, fecha_inicio, fecha_cierre, estado FROM visitas_planes ORDER BY fecha_inicio DESC LIMIT 100`);
    ok(res, { totales: tot, por_ejecutivo: porEjec, planes, esRevisor });
  } catch (e) { console.error('[visitas stats]', e); err(res, 500, 'Error interno del servidor'); }
};

module.exports = { getConfig, putConfig, getDealers, planificador, listar, crear, gestionar, eliminar,
  ejecutivos, zonasCartera, asignacionMasiva, listarAsignaciones, crearAsignacion, cerrarAsignacion,
  listarPlanes, cerrarPlan, fichaDia, stats };
