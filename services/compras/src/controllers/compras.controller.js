'use strict';
/**
 * Módulo COMPRAS (artículos de oficina). Catálogo sincronizado desde Dimeiggs (VTEX),
 * curado por perfil; el usuario pide cantidad + dirección de despacho; el admin consolida.
 * Fase 1: catálogo + curaduría por perfil + direcciones + config por usuario (mantenedor).
 */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { sincronizarCatalogo } = require('../compras-sync');

const MOD_SOPORTE = 500001;     // módulo nuevo "Soporte" (Home)
const MOD_MANT    = 30001;      // módulo "Mantenedores" (existente)

/* ── Migración: tablas + módulo/funcionalidades/permisos + precarga direcciones ── */
(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS compras_articulos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sku VARCHAR(40) UNIQUE NOT NULL,
      codigo_ref VARCHAR(60) NULL,
      nombre VARCHAR(300) NOT NULL,
      marca VARCHAR(120) NULL,
      categoria VARCHAR(300) NULL,
      precio DECIMAL(12,2) NOT NULL DEFAULT 0,
      stock INT NOT NULL DEFAULT 0,
      imagen VARCHAR(500) NULL,
      link VARCHAR(500) NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      fecha_sync DATETIME NULL,
      INDEX idx_cat (categoria), INDEX idx_activo (activo))`);

    await pool.query(`CREATE TABLE IF NOT EXISTS compras_articulo_perfil (
      id_articulo INT NOT NULL,
      id_perfil INT NOT NULL,
      PRIMARY KEY (id_articulo, id_perfil),
      INDEX idx_perfil (id_perfil))`);

    await pool.query(`CREATE TABLE IF NOT EXISTS compras_direcciones (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(150) NOT NULL,
      direccion VARCHAR(300) NULL,
      comuna VARCHAR(120) NULL,
      es_casa_matriz TINYINT(1) NOT NULL DEFAULT 0,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      orden INT DEFAULT 99)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS compras_usuario_config (
      id_usuario INT PRIMARY KEY,
      id_direccion INT NULL,
      centro_costo VARCHAR(60) NULL)`);

    await pool.query(`CREATE TABLE IF NOT EXISTS compras_pedidos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_usuario INT NOT NULL,
      usuario_nombre VARCHAR(150) NULL,
      id_direccion INT NULL,
      centro_costo VARCHAR(60) NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'PENDIENTE',
      total DECIMAL(14,2) NOT NULL DEFAULT 0,
      observacion VARCHAR(500) NULL,
      id_orden INT NULL,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_estado (estado), INDEX idx_usuario (id_usuario), INDEX idx_fecha (fecha))`);

    await pool.query(`CREATE TABLE IF NOT EXISTS compras_pedido_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_pedido INT NOT NULL,
      id_articulo INT NULL,
      sku VARCHAR(40) NULL,
      nombre VARCHAR(300) NULL,
      precio_unit DECIMAL(12,2) NOT NULL DEFAULT 0,
      cantidad INT NOT NULL DEFAULT 1,
      subtotal DECIMAL(14,2) NOT NULL DEFAULT 0,
      INDEX idx_pedido (id_pedido))`);

    await pool.query(`CREATE TABLE IF NOT EXISTS compras_ordenes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      modo VARCHAR(20) NOT NULL DEFAULT 'CONSOLIDADO',
      id_direccion INT NULL,
      destino VARCHAR(150) NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'ABIERTA',
      total DECIMAL(14,2) NOT NULL DEFAULT 0,
      id_usuario INT NULL,
      observacion VARCHAR(500) NULL,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP)`);

    // ── Módulo Soporte + funcionalidades + permisos (idempotente) ──
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (?, 'Soporte', 'Soporte interno: compras de artículos de oficina y más', 'bi-headset', '/soporte/', 120, 'activo')`,
      [MOD_SOPORTE]);

    const funcs = [
      // [nombre, codigo, href, icono, id_modulo]
      ['Soporte',            'soporte_ver',  '/soporte/',            'bi-headset',     MOD_SOPORTE],
      ['Compras de Oficina', 'compras',      '/soporte/compras/',    'bi-bag',         MOD_SOPORTE],
      ['Administrar Compras', 'compras_admin', null,                 null,             MOD_SOPORTE],
      ['Mantenedor Compras', 'compras_mant', '/mantenedores/compras/', 'bi-bag-check', MOD_MANT],
    ];
    const idFunc = {};
    for (const [nombre, codigo, href, icono, idmod] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query(
        'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
        [idmod, nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    // Perfiles: 1 Admin · 2 Gerente · 3 Supervisor · 4 Ejec.Comercial · 5 Analista Crédito
    //           6 Analista Operaciones · 90008 Gte Op y Crédito · 90009 Gte General
    const TODOS = [1, 2, 3, 4, 5, 6, 90008, 90009];
    const seed = {
      soporte_ver:   TODOS,           // todos pueden ver Soporte
      compras:       TODOS,           // todos pueden pedir (la curaduría por perfil controla qué ven)
      compras_admin: [1, 2, 90008, 90009],
      compras_mant:  [1, 2],          // Admin pasa por bypass igual; se amplía desde Perfiles
    };
    for (const [codigo, perfiles] of Object.entries(seed)) {
      const idf = idFunc[codigo]; if (!idf) continue;
      for (const idp of perfiles) {
        const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [idp, idf]);
        if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
      }
    }

    // compras_admin pasa a ser card en Soporte (página de consolidación de pedidos)
    await pool.query("UPDATE funcionalidades SET href='/soporte/compras-admin/', icono='bi-clipboard-check' WHERE codigo='compras_admin' AND (href IS NULL OR href='')");

    // ── Precarga de direcciones: parques activos + Casa Matriz (solo si está vacía) ──
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM compras_direcciones');
    if (n === 0) {
      try {
        const [parques] = await pool.query('SELECT nombre, orden FROM parques_comisiones WHERE activo=1 ORDER BY orden, nombre');
        for (const p of parques) {
          await pool.query('INSERT INTO compras_direcciones (nombre, es_casa_matriz, orden) VALUES (?,0,?)', [p.nombre, p.orden || 99]);
        }
      } catch (_) {}
      await pool.query("INSERT INTO compras_direcciones (nombre, es_casa_matriz, orden) VALUES ('Casa Matriz', 1, 0)");
    }
    console.log('[compras] módulo registrado');
  } catch (e) { console.error('[compras migration]', e.message); }
})();

const err = (res, e) => { console.error('[compras]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); };
const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

/* ════════════ CATÁLOGO ════════════ */

// Búsqueda insensible a MAYÚSCULAS y ACENTOS (la colación de la BD es case-sensitive,
// por eso "papel" no encontraba "Papel…" ni "lapiz" a "Lápiz…"). Se pliega ambos lados.
const _foldSQL = c => `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(${c}),'á','a'),'é','e'),'í','i'),'ó','o'),'ú','u')`;
const _foldJS  = s => String(s || '').toLowerCase().replace(/á/g,'a').replace(/é/g,'e').replace(/í/g,'i').replace(/ó/g,'o').replace(/ú/g,'u');

// GET /api/compras/catalogo?q=&categoria=&soloActivos=1&limit=&offset=
const catalogo = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const cat = String(req.query.categoria || '').trim();
    const soloActivos = req.query.soloActivos === '0' ? false : true;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    const where = [], args = [];
    if (soloActivos) where.push('activo=1');
    if (q) { where.push(`(${_foldSQL('nombre')} LIKE ? OR ${_foldSQL('marca')} LIKE ? OR LOWER(sku) LIKE ? OR LOWER(codigo_ref) LIKE ?)`); const qf = `%${_foldJS(q)}%`, ql = `%${q.toLowerCase()}%`; args.push(qf, qf, ql, ql); }
    if (cat) { where.push('categoria LIKE ?'); args.push(`${cat}%`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM compras_articulos ${w}`, args);
    const [rows] = await pool.query(
      `SELECT id, sku, codigo_ref, nombre, marca, categoria, precio, stock, imagen, link, fecha_sync
       FROM compras_articulos ${w} ORDER BY nombre LIMIT ? OFFSET ?`, [...args, limit, offset]);
    res.json({ success: true, data: { items: rows, total }, error: null });
  } catch (e) { err(res, e); }
};

// GET /api/compras/categorias → primer nivel de categoría (para filtro)
const categorias = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT SUBSTRING_INDEX(categoria,'/',1) cat, COUNT(*) n
       FROM compras_articulos WHERE activo=1 AND categoria<>'' GROUP BY cat ORDER BY cat`);
    res.json({ success: true, data: rows.map(r => ({ categoria: r.cat, n: r.n })), error: null });
  } catch (e) { err(res, e); }
};

// GET /api/compras/catalogo-ids?q=&categoria= → IDs de TODOS los artículos que matchean el filtro
// (todas las páginas). Lo usa "Asignar/Quitar todo el filtro" del mantenedor.
const catalogoIds = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const cat = String(req.query.categoria || '').trim();
    const where = ['activo=1'], args = [];
    if (q) { where.push(`(${_foldSQL('nombre')} LIKE ? OR ${_foldSQL('marca')} LIKE ? OR LOWER(sku) LIKE ? OR LOWER(codigo_ref) LIKE ?)`); const qf = `%${_foldJS(q)}%`, ql = `%${q.toLowerCase()}%`; args.push(qf, qf, ql, ql); }
    if (cat) { where.push('categoria LIKE ?'); args.push(`${cat}%`); }
    const [rows] = await pool.query(`SELECT id FROM compras_articulos WHERE ${where.join(' AND ')} ORDER BY id LIMIT 10000`, args);
    res.json({ success: true, data: { ids: rows.map(r => r.id) }, error: null });
  } catch (e) { err(res, e); }
};

// POST /api/compras/sincronizar → recarga el catálogo desde Dimeiggs
const sincronizar = async (req, res) => {
  try {
    const r = await sincronizarCatalogo();
    auditar({ req, accion: 'CARGA_MASIVA', modulo: 'compras', entidad: 'catalogo', detalle: `Sincronizó catálogo Dimeiggs: ${r.upserts} artículos`, meta: r });
    res.json({ success: true, data: r, error: null });
  } catch (e) { err(res, e); }
};

/* ════════════ PERFILES + CURADURÍA ════════════ */

// GET /api/compras/perfiles
const perfiles = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT id_perfil, nombre FROM perfiles WHERE estado='activo' ORDER BY nombre");
    res.json({ success: true, data: rows, error: null });
  } catch (e) { err(res, e); }
};

// GET /api/compras/articulo-perfil?id_perfil=ID → ids de artículos asignados a ese perfil
const articuloPerfilGet = async (req, res) => {
  try {
    const idp = num(req.query.id_perfil);
    if (!idp) return res.status(400).json({ success: false, data: null, error: 'id_perfil requerido' });
    const [rows] = await pool.query('SELECT id_articulo FROM compras_articulo_perfil WHERE id_perfil=?', [idp]);
    res.json({ success: true, data: { id_perfil: idp, asignados: rows.map(r => r.id_articulo) }, error: null });
  } catch (e) { err(res, e); }
};

// POST /api/compras/articulo-perfil { id_perfil, ids:[...], asignar:true|false } → asigna/quita en lote
const articuloPerfilSet = async (req, res) => {
  try {
    const idp = num(req.body.id_perfil);
    const ids = Array.isArray(req.body.ids) ? req.body.ids.map(num).filter(Boolean) : [];
    const asignar = req.body.asignar !== false;
    if (!idp || !ids.length) return res.status(400).json({ success: false, data: null, error: 'id_perfil e ids requeridos' });
    if (asignar) {
      const vals = ids.map(id => [id, idp]);
      await pool.query('INSERT IGNORE INTO compras_articulo_perfil (id_articulo, id_perfil) VALUES ?', [vals]);
    } else {
      await pool.query('DELETE FROM compras_articulo_perfil WHERE id_perfil=? AND id_articulo IN (?)', [idp, ids]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'compras', entidad: 'articulo_perfil', entidad_id: idp, detalle: `${asignar ? 'Asignó' : 'Quitó'} ${ids.length} artículo(s) al perfil ${idp}` });
    res.json({ success: true, data: { ok: true, afectados: ids.length }, error: null });
  } catch (e) { err(res, e); }
};

/* ════════════ DIRECCIONES ════════════ */

const direccionesList = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM compras_direcciones ORDER BY es_casa_matriz DESC, orden, nombre');
    res.json({ success: true, data: rows, error: null });
  } catch (e) { err(res, e); }
};

const direccionCrear = async (req, res) => {
  try {
    const b = req.body || {};
    const nombre = String(b.nombre || '').trim();
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'El nombre de la oficina es obligatorio' });
    const [r] = await pool.query(
      'INSERT INTO compras_direcciones (nombre, direccion, comuna, es_casa_matriz, activo, orden) VALUES (?,?,?,?,?,?)',
      [nombre, String(b.direccion || '').trim() || null, String(b.comuna || '').trim() || null, b.es_casa_matriz ? 1 : 0, b.activo === 0 ? 0 : 1, num(b.orden) ?? 99]);
    auditar({ req, accion: 'CREAR', modulo: 'compras', entidad: 'direccion', entidad_id: r.insertId, detalle: `Creó oficina ${nombre}` });
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { err(res, e); }
};

const direccionEditar = async (req, res) => {
  try {
    const id = num(req.params.id); const b = req.body || {};
    if (!id) return res.status(400).json({ success: false, data: null, error: 'id inválido' });
    await pool.query(
      'UPDATE compras_direcciones SET nombre=?, direccion=?, comuna=?, es_casa_matriz=?, activo=?, orden=? WHERE id=?',
      [String(b.nombre || '').trim(), String(b.direccion || '').trim() || null, String(b.comuna || '').trim() || null,
       b.es_casa_matriz ? 1 : 0, b.activo === 0 ? 0 : 1, num(b.orden) ?? 99, id]);
    auditar({ req, accion: 'EDITAR', modulo: 'compras', entidad: 'direccion', entidad_id: id, detalle: `Editó oficina #${id}` });
    res.json({ success: true, data: { id }, error: null });
  } catch (e) { err(res, e); }
};

const direccionEliminar = async (req, res) => {
  try {
    const id = num(req.params.id);
    await pool.query('DELETE FROM compras_direcciones WHERE id=?', [id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'compras', entidad: 'direccion', entidad_id: id, detalle: `Eliminó oficina #${id}` });
    res.json({ success: true, data: { mensaje: 'Oficina eliminada' }, error: null });
  } catch (e) { err(res, e); }
};

/* ════════════ CONFIG POR USUARIO (dirección + centro de costo) ════════════ */

const usuariosConfig = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.id_usuario, u.nombre, u.apellido, u.email, p.nombre AS perfil,
             cfg.id_direccion, cfg.centro_costo, d.nombre AS direccion_nombre
      FROM usuarios u
      JOIN perfiles p ON p.id_perfil = u.id_perfil
      LEFT JOIN compras_usuario_config cfg ON cfg.id_usuario = u.id_usuario
      LEFT JOIN compras_direcciones d ON d.id = cfg.id_direccion
      WHERE u.estado='activo'
      ORDER BY u.nombre, u.apellido`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { err(res, e); }
};

const usuarioConfigSet = async (req, res) => {
  try {
    const id = num(req.params.id); const b = req.body || {};
    if (!id) return res.status(400).json({ success: false, data: null, error: 'id inválido' });
    const idDir = num(b.id_direccion);
    const cc = String(b.centro_costo || '').trim().slice(0, 60) || null;
    await pool.query(
      `INSERT INTO compras_usuario_config (id_usuario, id_direccion, centro_costo) VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE id_direccion=VALUES(id_direccion), centro_costo=VALUES(centro_costo)`,
      [id, idDir, cc]);
    auditar({ req, accion: 'EDITAR', modulo: 'compras', entidad: 'usuario_config', entidad_id: id, detalle: `Asignó despacho/centro de costo al usuario #${id}` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { err(res, e); }
};

/* ════════════ USUARIO (página de Compras) ════════════ */

// Perfil del usuario logueado (para filtrar su catálogo)
async function perfilDe(uid) {
  const [[u]] = await pool.query('SELECT id_perfil FROM usuarios WHERE id_usuario=? LIMIT 1', [uid]);
  return u ? u.id_perfil : null;
}

// GET /api/compras/articulos?q=&categoria=&limit=&offset= → solo los asignados al perfil del usuario
const misArticulos = async (req, res) => {
  try {
    const esAdmin = req.usuario?.perfil_nombre === 'Administrador';
    const idp = await perfilDe(req.usuario.id_usuario);
    if (!esAdmin && !idp) return res.json({ success: true, data: { items: [], total: 0 }, error: null });
    const q = String(req.query.q || '').trim();
    const cat = String(req.query.categoria || '').trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 60, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    // Administrador ve TODO el catálogo (convención del sistema); el resto solo lo asignado a su perfil.
    const join = esAdmin ? '' : 'JOIN compras_articulo_perfil ap ON ap.id_articulo=a.id';
    const where = ['a.activo=1'], args = [];
    if (!esAdmin) { where.push('ap.id_perfil=?'); args.push(idp); }
    if (q) { where.push(`(${_foldSQL('a.nombre')} LIKE ? OR ${_foldSQL('a.marca')} LIKE ? OR LOWER(a.sku) LIKE ?)`); const qf = `%${_foldJS(q)}%`, ql = `%${q.toLowerCase()}%`; args.push(qf, qf, ql); }
    if (cat) { where.push('a.categoria LIKE ?'); args.push(`${cat}%`); }
    const w = 'WHERE ' + where.join(' AND ');
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) total FROM compras_articulos a ${join} ${w}`, args);
    const [rows] = await pool.query(
      `SELECT a.id, a.sku, a.nombre, a.marca, a.categoria, a.precio, a.stock, a.imagen
       FROM compras_articulos a ${join}
       ${w} ORDER BY a.nombre LIMIT ? OFFSET ?`, [...args, limit, offset]);
    res.json({ success: true, data: { items: rows, total }, error: null });
  } catch (e) { err(res, e); }
};

// GET /api/compras/mis-categorias → categorías del catálogo del perfil del usuario
const misCategorias = async (req, res) => {
  try {
    const esAdmin = req.usuario?.perfil_nombre === 'Administrador';
    const idp = await perfilDe(req.usuario.id_usuario);
    if (!esAdmin && !idp) return res.json({ success: true, data: [], error: null });
    const [rows] = esAdmin
      ? await pool.query("SELECT SUBSTRING_INDEX(categoria,'/',1) cat, COUNT(*) n FROM compras_articulos WHERE activo=1 AND categoria<>'' GROUP BY cat ORDER BY cat")
      : await pool.query(
        `SELECT SUBSTRING_INDEX(a.categoria,'/',1) cat, COUNT(*) n
         FROM compras_articulos a JOIN compras_articulo_perfil ap ON ap.id_articulo=a.id
         WHERE a.activo=1 AND ap.id_perfil=? AND a.categoria<>'' GROUP BY cat ORDER BY cat`, [idp]);
    res.json({ success: true, data: rows.map(r => ({ categoria: r.cat, n: r.n })), error: null });
  } catch (e) { err(res, e); }
};

// GET /api/compras/mi-config → dirección asignada + centro de costo + direcciones activas (para el selector)
const miConfig = async (req, res) => {
  try {
    const uid = req.usuario.id_usuario;
    const [[cfg]] = await pool.query('SELECT id_direccion, centro_costo FROM compras_usuario_config WHERE id_usuario=? LIMIT 1', [uid]);
    const [direcciones] = await pool.query('SELECT id, nombre, es_casa_matriz FROM compras_direcciones WHERE activo=1 ORDER BY es_casa_matriz DESC, orden, nombre');
    res.json({ success: true, data: { id_direccion: cfg?.id_direccion ?? null, centro_costo: cfg?.centro_costo ?? null, direcciones }, error: null });
  } catch (e) { err(res, e); }
};

// POST /api/compras/pedidos { items:[{id_articulo, cantidad}], id_direccion, observacion }
const crearPedido = async (req, res) => {
  try {
    const uid = req.usuario.id_usuario;
    const obs = String(req.body.observacion || '').trim().slice(0, 500) || null;
    let idDir = num(req.body.id_direccion);
    const [[u]] = await pool.query(
      `SELECT u.id_perfil, TRIM(CONCAT(u.nombre,' ',u.apellido)) AS nombre, cfg.id_direccion AS cfgDir, cfg.centro_costo
       FROM usuarios u LEFT JOIN compras_usuario_config cfg ON cfg.id_usuario=u.id_usuario WHERE u.id_usuario=? LIMIT 1`, [uid]);
    if (!u) return res.status(400).json({ success: false, data: null, error: 'Usuario no encontrado' });
    if (!idDir) idDir = u.cfgDir || null;
    if (!idDir) return res.status(400).json({ success: false, data: null, error: 'Elige una dirección de despacho' });
    const [[d]] = await pool.query('SELECT id FROM compras_direcciones WHERE id=? AND activo=1 LIMIT 1', [idDir]);
    if (!d) return res.status(400).json({ success: false, data: null, error: 'Dirección de despacho inválida' });

    // Consolida cantidades por artículo (defensivo)
    const want = new Map();
    for (const it of (Array.isArray(req.body.items) ? req.body.items : [])) {
      const id = num(it.id_articulo), c = num(it.cantidad);
      if (id && c > 0) want.set(id, (want.get(id) || 0) + c);
    }
    if (!want.size) return res.status(400).json({ success: false, data: null, error: 'Agrega al menos un artículo' });

    // Solo artículos permitidos al perfil del usuario; precio SIEMPRE del servidor.
    // Administrador puede pedir cualquier artículo del catálogo (convención del sistema).
    const esAdmin = req.usuario?.perfil_nombre === 'Administrador';
    const [arts] = esAdmin
      ? await pool.query('SELECT id, sku, nombre, precio FROM compras_articulos WHERE activo=1 AND id IN (?)', [[...want.keys()]])
      : await pool.query(
        `SELECT a.id, a.sku, a.nombre, a.precio FROM compras_articulos a
         JOIN compras_articulo_perfil ap ON ap.id_articulo=a.id
         WHERE a.activo=1 AND ap.id_perfil=? AND a.id IN (?)`, [u.id_perfil, [...want.keys()]]);
    if (!arts.length) return res.status(400).json({ success: false, data: null, error: 'Ninguno de los artículos está disponible para tu perfil' });

    let total = 0; const filas = [];
    for (const a of arts) {
      const c = want.get(a.id); const sub = Number(a.precio) * c; total += sub;
      filas.push([a.id, a.sku, a.nombre, a.precio, c, sub]);
    }
    const [r] = await pool.query(
      `INSERT INTO compras_pedidos (id_usuario, usuario_nombre, id_direccion, centro_costo, estado, total, observacion)
       VALUES (?,?,?,?,'PENDIENTE',?,?)`, [uid, u.nombre, idDir, u.centro_costo || null, total, obs]);
    const pid = r.insertId;
    await pool.query(
      'INSERT INTO compras_pedido_items (id_pedido, id_articulo, sku, nombre, precio_unit, cantidad, subtotal) VALUES ?',
      [filas.map(f => [pid, ...f])]);
    auditar({ req, accion: 'CREAR', modulo: 'compras', entidad: 'pedido', entidad_id: pid, detalle: `Pedido de compra #${pid}: ${filas.length} ítem(s), total $${total}`, meta: { items: filas.length, total, id_direccion: idDir } });
    res.status(201).json({ success: true, data: { id: pid, total, items: filas.length }, error: null });
  } catch (e) { err(res, e); }
};

// GET /api/compras/mis-pedidos → historial del usuario (cabecera + ítems)
const misPedidos = async (req, res) => {
  try {
    const uid = req.usuario.id_usuario;
    const [peds] = await pool.query(
      `SELECT p.id, p.estado, p.total, p.observacion, p.fecha, d.nombre AS direccion
       FROM compras_pedidos p LEFT JOIN compras_direcciones d ON d.id=p.id_direccion
       WHERE p.id_usuario=? ORDER BY p.fecha DESC LIMIT 100`, [uid]);
    if (peds.length) {
      const [its] = await pool.query(
        'SELECT id_pedido, nombre, precio_unit, cantidad, subtotal FROM compras_pedido_items WHERE id_pedido IN (?)',
        [peds.map(p => p.id)]);
      const byPed = {};
      for (const it of its) (byPed[it.id_pedido] = byPed[it.id_pedido] || []).push(it);
      peds.forEach(p => { p.items = byPed[p.id] || []; });
    }
    res.json({ success: true, data: peds, error: null });
  } catch (e) { err(res, e); }
};

/* ════════════ ADMIN (consolidación de pedidos) ════════════ */

// GET /api/compras/admin/pedidos?estado=PENDIENTE → pool de pedidos + ítems
const adminPedidos = async (req, res) => {
  try {
    const estado = String(req.query.estado || 'PENDIENTE').toUpperCase();
    const [peds] = await pool.query(
      `SELECT p.id, p.id_usuario, p.usuario_nombre, p.id_direccion, p.centro_costo, p.estado, p.total, p.observacion, p.fecha,
              d.nombre AS direccion, d.es_casa_matriz
       FROM compras_pedidos p LEFT JOIN compras_direcciones d ON d.id=p.id_direccion
       WHERE p.estado=? ORDER BY p.fecha DESC LIMIT 500`, [estado]);
    if (peds.length) {
      const [its] = await pool.query(
        'SELECT id_pedido, nombre, precio_unit, cantidad, subtotal FROM compras_pedido_items WHERE id_pedido IN (?)',
        [peds.map(p => p.id)]);
      const by = {};
      for (const it of its) (by[it.id_pedido] = by[it.id_pedido] || []).push(it);
      peds.forEach(p => { p.items = by[p.id] || []; });
    }
    res.json({ success: true, data: peds, error: null });
  } catch (e) { err(res, e); }
};

// POST /api/compras/admin/consolidar { pedido_ids:[...], modo:'CONSOLIDADO'|'SEPARADO' }
//   CONSOLIDADO → 1 orden, todo a Casa Matriz. SEPARADO → 1 orden por sucursal (id_direccion).
const consolidar = async (req, res) => {
  try {
    const modo = String(req.body.modo || 'CONSOLIDADO').toUpperCase() === 'SEPARADO' ? 'SEPARADO' : 'CONSOLIDADO';
    const ids = (Array.isArray(req.body.pedido_ids) ? req.body.pedido_ids : []).map(num).filter(Boolean);
    if (!ids.length) return res.status(400).json({ success: false, data: null, error: 'Selecciona al menos un pedido' });
    const [peds] = await pool.query(
      'SELECT id, id_direccion, total FROM compras_pedidos WHERE estado=\'PENDIENTE\' AND id IN (?)', [ids]);
    if (!peds.length) return res.status(400).json({ success: false, data: null, error: 'No hay pedidos pendientes en la selección' });
    const uid = req.usuario.id_usuario;
    const ordenes = [];

    if (modo === 'CONSOLIDADO') {
      const [[cm]] = await pool.query('SELECT id, nombre FROM compras_direcciones WHERE es_casa_matriz=1 AND activo=1 ORDER BY id LIMIT 1');
      const total = peds.reduce((s, p) => s + Number(p.total), 0);
      const [r] = await pool.query(
        `INSERT INTO compras_ordenes (modo, id_direccion, destino, estado, total, id_usuario) VALUES ('CONSOLIDADO',?,?, 'ABIERTA', ?, ?)`,
        [cm?.id ?? null, cm?.nombre || 'Casa Matriz', total, uid]);
      await pool.query('UPDATE compras_pedidos SET estado=\'CONSOLIDADO\', id_orden=? WHERE id IN (?)', [r.insertId, peds.map(p => p.id)]);
      ordenes.push(r.insertId);
    } else {
      const grupos = {};
      for (const p of peds) (grupos[p.id_direccion || 0] = grupos[p.id_direccion || 0] || []).push(p);
      for (const [idDir, gr] of Object.entries(grupos)) {
        const dId = num(idDir);
        let nombre = 'Sin dirección';
        if (dId) { const [[d]] = await pool.query('SELECT nombre FROM compras_direcciones WHERE id=?', [dId]); nombre = d?.nombre || nombre; }
        const total = gr.reduce((s, p) => s + Number(p.total), 0);
        const [r] = await pool.query(
          `INSERT INTO compras_ordenes (modo, id_direccion, destino, estado, total, id_usuario) VALUES ('SEPARADO',?,?, 'ABIERTA', ?, ?)`,
          [dId || null, nombre, total, uid]);
        await pool.query('UPDATE compras_pedidos SET estado=\'CONSOLIDADO\', id_orden=? WHERE id IN (?)', [r.insertId, gr.map(p => p.id)]);
        ordenes.push(r.insertId);
      }
    }
    auditar({ req, accion: 'CREAR', modulo: 'compras', entidad: 'orden', detalle: `Consolidó ${peds.length} pedido(s) en ${ordenes.length} orden(es) (${modo})`, meta: { modo, ordenes, pedidos: peds.length } });
    res.json({ success: true, data: { ordenes, modo }, error: null });
  } catch (e) { err(res, e); }
};

// GET /api/compras/admin/ordenes?estado= → órdenes (con conteo de ítems)
const adminOrdenes = async (req, res) => {
  try {
    const estado = String(req.query.estado || '').toUpperCase();
    const where = estado ? 'WHERE o.estado=?' : '';
    const args = estado ? [estado] : [];
    const [rows] = await pool.query(
      `SELECT o.*, (SELECT COUNT(*) FROM compras_pedidos p WHERE p.id_orden=o.id) AS n_pedidos
       FROM compras_ordenes o ${where} ORDER BY o.fecha DESC LIMIT 300`, args);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { err(res, e); }
};

// GET /api/compras/admin/ordenes/:id → lista de compra consolidada (agrupada por artículo) + pedidos incluidos
const adminOrdenDetalle = async (req, res) => {
  try {
    const id = num(req.params.id);
    const [[orden]] = await pool.query(
      `SELECT o.*, dd.direccion AS dest_calle, dd.comuna AS dest_comuna
       FROM compras_ordenes o LEFT JOIN compras_direcciones dd ON dd.id=o.id_direccion WHERE o.id=?`, [id]);
    if (!orden) return res.status(404).json({ success: false, data: null, error: 'Orden no encontrada' });
    const [items] = await pool.query(
      `SELECT sku, nombre, SUM(cantidad) AS cantidad, MAX(precio_unit) AS precio_unit, SUM(subtotal) AS subtotal
       FROM compras_pedido_items WHERE id_pedido IN (SELECT id FROM compras_pedidos WHERE id_orden=?)
       GROUP BY sku, nombre ORDER BY nombre`, [id]);
    const [pedidos] = await pool.query(
      `SELECT p.id, p.usuario_nombre, p.centro_costo, p.total, u.email,
              d.nombre AS direccion, d.direccion AS dir_calle, d.comuna
       FROM compras_pedidos p
       LEFT JOIN compras_direcciones d ON d.id=p.id_direccion
       LEFT JOIN usuarios u ON u.id_usuario=p.id_usuario
       WHERE p.id_orden=? ORDER BY p.id`, [id]);
    res.json({ success: true, data: { orden, items, pedidos }, error: null });
  } catch (e) { err(res, e); }
};

// PUT /api/compras/admin/ordenes/:id/estado { estado }
const adminOrdenEstado = async (req, res) => {
  try {
    const id = num(req.params.id);
    const estado = String(req.body.estado || '').toUpperCase();
    const OK = ['ABIERTA', 'COMPRADA', 'RECIBIDA', 'ANULADA'];
    if (!OK.includes(estado)) return res.status(400).json({ success: false, data: null, error: 'Estado inválido' });
    await pool.query('UPDATE compras_ordenes SET estado=? WHERE id=?', [estado, id]);
    // Propaga a los pedidos de la orden
    if (estado === 'ANULADA') {
      await pool.query('UPDATE compras_pedidos SET estado=\'PENDIENTE\', id_orden=NULL WHERE id_orden=?', [id]);
    } else {
      const map = { ABIERTA: 'CONSOLIDADO', COMPRADA: 'COMPRADO', RECIBIDA: 'RECIBIDO' };
      await pool.query('UPDATE compras_pedidos SET estado=? WHERE id_orden=?', [map[estado], id]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'compras', entidad: 'orden', entidad_id: id, detalle: `Orden #${id} → ${estado}` });
    res.json({ success: true, data: { id, estado }, error: null });
  } catch (e) { err(res, e); }
};

// GET /api/compras/admin/reporte?anio=YYYY&modo=todas|efectivas → montos por sucursal y mes
const reporteMensual = async (req, res) => {
  try {
    const anio = num(req.query.anio) || new Date().getFullYear();
    const modo = req.query.modo === 'efectivas' ? 'efectivas' : 'todas';
    // "todas" = pedidos no anulados; "efectivas" = solo comprados/recibidos
    const cond = modo === 'efectivas' ? "p.estado IN ('COMPRADO','RECIBIDO')" : "p.estado <> 'ANULADO'";
    const [filas] = await pool.query(
      `SELECT MONTH(p.fecha) AS mes, COALESCE(p.id_direccion,0) AS id_direccion,
              COALESCE(d.nombre,'Sin dirección') AS direccion, COUNT(*) AS n, SUM(p.total) AS monto
       FROM compras_pedidos p LEFT JOIN compras_direcciones d ON d.id=p.id_direccion
       WHERE ${cond} AND YEAR(p.fecha)=?
       GROUP BY mes, id_direccion, direccion ORDER BY direccion, mes`, [anio]);
    res.json({ success: true, data: { anio, modo, filas }, error: null });
  } catch (e) { err(res, e); }
};

module.exports = {
  catalogo, categorias, catalogoIds, sincronizar,
  perfiles, articuloPerfilGet, articuloPerfilSet,
  direccionesList, direccionCrear, direccionEditar, direccionEliminar,
  usuariosConfig, usuarioConfigSet,
  misArticulos, misCategorias, miConfig, crearPedido, misPedidos,
  adminPedidos, consolidar, adminOrdenes, adminOrdenDetalle, adminOrdenEstado,
  reporteMensual,
};
