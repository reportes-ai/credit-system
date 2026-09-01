'use strict';
/**
 * Módulo COMPRAS (artículos de oficina). Catálogo sincronizado desde Dimeiggs (VTEX),
 * curado por perfil; el usuario pide cantidad + dirección de despacho; el admin consolida.
 * Fase 1: catálogo + curaduría por perfil + direcciones + config por usuario (mantenedor).
 */
const { programar } = require('../../../../shared/scheduler.js');
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const { sincronizarCatalogo } = require('../compras-sync');

const MOD_SOPORTE = 500001;     // módulo nuevo "Soporte" (Home)
const MOD_MANT    = 30001;      // módulo "Mantenedores" (existente)

/* ── Migración: tablas + módulo/funcionalidades/permisos + precarga direcciones ── */
require('../../../../shared/migrate').enFila('compras', async () => {
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
});

/* ── WORKFLOW DE APROBACIÓN DE ÓRDENES (paramétrico) ─────────────────────────
   La orden consolidada no se compra al tiro: pasa por niveles de firma que el
   Administrador define con casillas por CARGO (perfil) y/o PERSONA (usuario).
   Seed del flujo pedido por gerencia: 1) revisión del Asistente Administrativo,
   2) aprobación del Gerente General, 3) un nivel adicional (nace desactivado).
   Las alarmas de cada nivel son eventos del mantenedor Avisos (campanita). */
const AVISOS = require('../../../../shared/avisos');
require('../../../../shared/migrate').enFila('compras-aprobacion', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS compras_aprobacion_niveles (
      nivel INT PRIMARY KEY,
      nombre VARCHAR(120) NOT NULL,
      perfiles TEXT,
      usuarios TEXT,
      activo TINYINT(1) NOT NULL DEFAULT 1)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS compras_orden_firmas (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_orden INT NOT NULL,
      nivel INT NOT NULL,
      nivel_nombre VARCHAR(120) NULL,
      id_usuario INT NULL,
      usuario VARCHAR(150) NULL,
      accion VARCHAR(15) NOT NULL,
      comentario VARCHAR(400) NULL,
      fecha DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_orden (id_orden))`);
    await pool.query(`ALTER TABLE compras_ordenes ADD COLUMN IF NOT EXISTS nivel_actual INT NULL`).catch(() => {});
    // Recordatorio paramétrico por nivel (horas sin firma → re-alarma; 0 = sin recordatorio)
    await pool.query(`ALTER TABLE compras_aprobacion_niveles ADD COLUMN IF NOT EXISTS recordatorio_horas INT NOT NULL DEFAULT 24`).catch(() => {});
    await pool.query(`ALTER TABLE compras_ordenes ADD COLUMN IF NOT EXISTS ultima_alarma DATETIME NULL`).catch(() => {});
    // Card "Revisión de Órdenes de Compra" en Soporte — la bandeja del firmante
    {
      const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='compras_revision' LIMIT 1");
      let idf = ex && ex.id_funcionalidad;
      if (!idf) {
        const [r] = await pool.query(
          "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?, 'Revisión de Órdenes de Compra', 'compras_revision', '/soporte/compras-revision/', 'bi-clipboard2-check')",
          [MOD_SOPORTE]);
        idf = r.insertId;
      }
      // Firmantes por defecto del workflow + administración
      await pool.query(`INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT p.id_perfil, ?, 1 FROM perfiles p
                        WHERE (p.nombre IN ('Administrador','Asistente Administrativo','Gerente General') OR p.nombre LIKE 'Gerente%')
                          AND NOT EXISTS (SELECT 1 FROM permisos_perfil pp WHERE pp.id_perfil=p.id_perfil AND pp.id_funcionalidad=?)`,
                       [idf, idf]);
    }
    for (const [nivel, nombre, perfiles, activo] of [
      [1, 'Revisión administrativa', 'Asistente Administrativo', 1],
      [2, 'Aprobación Gerencia General', 'Gerente General', 1],
      [3, 'Aprobación adicional', '', 0],
    ]) await pool.query(
      'INSERT IGNORE INTO compras_aprobacion_niveles (nivel, nombre, perfiles, usuarios, activo) VALUES (?,?,?,\'\',?)',
      [nivel, nombre, perfiles, activo]);
  } catch (e) { console.error('[compras-aprobacion migration]', e.message); }
});
for (const n of [1, 2, 3]) AVISOS.registrarAviso({
  evento: 'compras_aprob_nivel_' + n, modulo: 'Compras',
  nombre: 'Orden de compra por firmar — nivel ' + n,
  descripcion: 'Una orden de compra llegó a este nivel del workflow de aprobación y espera firma.',
  perfiles: n === 1 ? 'Asistente Administrativo' : (n === 2 ? 'Gerente General' : ''),
  incluir_admin: 0, prioridad: 'alta', sonido_tipo: 'dingdong',
});
AVISOS.registrarAviso({ evento: 'compras_orden_aprobada', modulo: 'Compras',
  nombre: 'Orden de compra aprobada (lista para comprar)',
  descripcion: 'La orden completó todos los niveles de firma. A DÓNDE VA: la orden queda ABIERTA (lista para comprar) en Administrar Compras; aquí se define a quién se le avisa.',
  perfiles: 'Asistente Administrativo', incluir_admin: 0, prioridad: 'alta', sonido_tipo: 'dingdong' });
AVISOS.registrarAviso({ evento: 'compras_orden_rechazada', modulo: 'Compras',
  nombre: 'Orden de compra rechazada',
  descripcion: 'Un firmante rechazó la orden (siempre con comentario); los pedidos vuelven a pendientes en Administrar Compras. Aquí se define a quién se le avisa.',
  perfiles: 'Asistente Administrativo', incluir_admin: 0, prioridad: 'alta', sonido_tipo: 'dingdong' });
AVISOS.registrarAviso({ evento: 'compras_aprob_recordatorio', modulo: 'Compras',
  nombre: 'Recordatorio: orden de compra sin firmar',
  descripcion: 'Una orden lleva más horas esperando firma que el recordatorio configurado en su nivel (mantenedor Compras → Workflow). Se re-alarma al nivel que debe firmar.',
  perfiles: '', incluir_admin: 0, prioridad: 'alta', sonido_tipo: 'dingdong' });

async function nivelesAprobacion() {
  const [n] = await pool.query('SELECT * FROM compras_aprobacion_niveles ORDER BY nivel');
  return n;
}
const primerNivelActivo = niveles => { const n = niveles.find(x => x.activo); return n ? n.nivel : null; };
const siguienteNivelActivo = (niveles, actual) => { const n = niveles.find(x => x.activo && x.nivel > actual); return n ? n.nivel : null; };
function _csv(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean); }
// ¿Puede este usuario firmar el nivel? Por cargo (perfil), por persona, o Administrador.
function puedeFirmarNivel(req, nivelCfg) {
  if (!nivelCfg) return false;
  const perfil = String(req.usuario.perfil_nombre || '').trim();
  if (perfil === 'Administrador') return true;
  if (_csv(nivelCfg.perfiles).some(p => p.toLowerCase() === perfil.toLowerCase())) return true;
  return _csv(nivelCfg.usuarios).map(Number).includes(Number(req.usuario.id_usuario));
}

const err = (res, e) => { console.error('[compras]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); };
const num = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

/* ════════════ CIERRE MENSUAL DEL PEDIDO ════════════
   El pedido de compras cierra el día 10 (paramétrico) o el hábil siguiente de
   cada mes: ese día el Asistente consolida y genera la ODC. Generada la ODC del
   mes (o pasada la fecha), la página de pedidos informa el cierre del MES
   SIGUIENTE — lo que se pida después entra al ciclo siguiente. */
require('../../../../shared/migrate').enFila('compras-config', async () => {
  await pool.query('CREATE TABLE IF NOT EXISTS compras_config (clave VARCHAR(40) PRIMARY KEY, valor VARCHAR(100) NOT NULL)').catch(() => {});
  await pool.query("INSERT IGNORE INTO compras_config (clave, valor) VALUES ('dia_cierre','10')").catch(() => {});
  // De momento TODO se despacha a Casa Matriz (pedido Pato 01-09-2026). Paramétrico:
  // con '0' vuelve la elección de dirección por usuario.
  await pool.query("INSERT IGNORE INTO compras_config (clave, valor) VALUES ('despacho_solo_cm','1')").catch(() => {});
  // Cantidad SOLICITADA original: el Asistente puede corregir `cantidad` antes de
  // consolidar; esta columna conserva lo pedido para el correo "solicitado vs aprobado".
  await pool.query('ALTER TABLE compras_pedido_items ADD COLUMN IF NOT EXISTS cantidad_solicitada INT NULL').catch(() => {});
  await pool.query('UPDATE compras_pedido_items SET cantidad_solicitada = cantidad WHERE cantidad_solicitada IS NULL').catch(() => {});
});

// GET /api/compras/cierre → { fecha_cierre, cerrado, dia }
const cierrePedidos = async (req, res) => {
  try {
    const [[cfg]] = await pool.query("SELECT valor FROM compras_config WHERE clave='dia_cierre'").catch(() => [[null]]);
    const dia = Math.min(28, Math.max(1, parseInt(cfg?.valor, 10) || 10));
    const hoyStr = require('../../../../shared/fecha-chile').hoyISO();   // día de Chile, no UTC
    const [y, m] = hoyStr.split('-').map(Number);
    const habilDesde = (yy, mm) => {   // día `dia` del mes, corrido a lunes-viernes
      const d = new Date(Date.UTC(yy, mm - 1, dia));
      while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    const cierreMes = habilDesde(y, m);
    // Cerrado del mes: ya existe la ODC del mes en curso (una orden no rechazada/anulada)
    const [[odc]] = await pool.query(
      "SELECT id FROM compras_ordenes WHERE estado NOT IN ('RECHAZADA','ANULADA') AND DATE_FORMAT(fecha,'%Y-%m') = ? LIMIT 1",
      [hoyStr.slice(0, 7)]);
    const cerrado = !!odc || hoyStr > cierreMes;
    const fecha_cierre = cerrado ? habilDesde(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1) : cierreMes;
    res.json({ success: true, data: { fecha_cierre, cerrado, dia }, error: null });
  } catch (e) { err(res, e); }
};

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
// ¿El despacho está fijado a Casa Matriz? (compras_config.despacho_solo_cm — hoy '1')
async function despachoSoloCM() {
  try {
    const [[r]] = await pool.query("SELECT valor FROM compras_config WHERE clave='despacho_solo_cm'");
    return r ? r.valor === '1' : false;
  } catch (_) { return false; }
}
async function casaMatriz() {
  const [[cm]] = await pool.query('SELECT id, nombre FROM compras_direcciones WHERE es_casa_matriz=1 AND activo=1 ORDER BY id LIMIT 1');
  return cm || null;
}

const miConfig = async (req, res) => {
  try {
    const uid = req.usuario.id_usuario;
    const [[cfg]] = await pool.query('SELECT id_direccion, centro_costo FROM compras_usuario_config WHERE id_usuario=? LIMIT 1', [uid]);
    const [direcciones] = await pool.query('SELECT id, nombre, es_casa_matriz FROM compras_direcciones WHERE activo=1 ORDER BY es_casa_matriz DESC, orden, nombre');
    const soloCM = await despachoSoloCM();
    res.json({ success: true, data: { id_direccion: cfg?.id_direccion ?? null, centro_costo: cfg?.centro_costo ?? null, direcciones, despacho_solo_cm: soloCM, casa_matriz: soloCM ? await casaMatriz() : null }, error: null });
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
    // Despacho fijado a Casa Matriz (paramétrico: compras_config.despacho_solo_cm)
    if (await despachoSoloCM()) {
      const cm = await casaMatriz();
      if (cm) idDir = cm.id;
    }
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
      'INSERT INTO compras_pedido_items (id_pedido, id_articulo, sku, nombre, precio_unit, cantidad, subtotal, cantidad_solicitada) VALUES ?',
      [filas.map(f => [pid, ...f, f[4]])]);   // cantidad_solicitada = cantidad original
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
        'SELECT id, id_pedido, id_articulo, sku, nombre, precio_unit, cantidad, subtotal FROM compras_pedido_items WHERE id_pedido IN (?)',
        [peds.map(p => p.id)]);
      const by = {};
      for (const it of its) (by[it.id_pedido] = by[it.id_pedido] || []).push(it);
      peds.forEach(p => { p.items = by[p.id] || []; });
    }
    res.json({ success: true, data: peds, error: null });
  } catch (e) { err(res, e); }
};

/* Corrección de un pedido ANTES de consolidar: el administrador puede ajustar
   cantidades o sacar productos (pedidos con ítems de más o equivocados). Solo
   sobre pedidos PENDIENTES: los ya consolidados viven en su orden de compra. */
async function _pedidoPendiente(idPedido) {
  const [[p]] = await pool.query('SELECT id, estado FROM compras_pedidos WHERE id=?', [idPedido]);
  if (!p) return { error: 'Pedido no existe' };
  if (p.estado !== 'PENDIENTE') return { error: `El pedido está ${p.estado}: solo se corrigen pedidos pendientes.` };
  return { p };
}
async function _recalcTotal(idPedido) {
  await pool.query(
    `UPDATE compras_pedidos p SET p.total =
       (SELECT COALESCE(SUM(subtotal),0) FROM compras_pedido_items WHERE id_pedido=p.id)
     WHERE p.id=?`, [idPedido]);
}

// PUT /api/compras/admin/pedidos/:id/items/:itemId { cantidad }
const adminItemEditar = async (req, res) => {
  try {
    const chk = await _pedidoPendiente(req.params.id);
    if (chk.error) return res.status(400).json({ success: false, data: null, error: chk.error });
    const cant = parseInt(req.body.cantidad);
    if (!(cant > 0)) return res.status(400).json({ success: false, data: null, error: 'Cantidad inválida (para sacar el producto usa eliminar)' });
    const [r] = await pool.query(
      'UPDATE compras_pedido_items SET cantidad=?, subtotal=ROUND(precio_unit*?) WHERE id=? AND id_pedido=?',
      [cant, cant, req.params.itemId, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Ítem no encontrado' });
    await _recalcTotal(req.params.id);
    auditar({ req, accion: 'EDITAR', modulo: 'compras', entidad: 'pedido', entidad_id: String(req.params.id),
      detalle: `Ajustó cantidad del ítem #${req.params.itemId} a ${cant} en el pedido #${req.params.id}` });
    res.json({ success: true, data: { id: +req.params.itemId, cantidad: cant }, error: null });
  } catch (e) { err(res, e); }
};

// DELETE /api/compras/admin/pedidos/:id/items/:itemId — si era el último ítem, el pedido se elimina
const adminItemEliminar = async (req, res) => {
  try {
    const chk = await _pedidoPendiente(req.params.id);
    if (chk.error) return res.status(400).json({ success: false, data: null, error: chk.error });
    const [r] = await pool.query('DELETE FROM compras_pedido_items WHERE id=? AND id_pedido=?',
      [req.params.itemId, req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Ítem no encontrado' });
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM compras_pedido_items WHERE id_pedido=?', [req.params.id]);
    let pedidoEliminado = false;
    if (n === 0) { await pool.query('DELETE FROM compras_pedidos WHERE id=?', [req.params.id]); pedidoEliminado = true; }
    else await _recalcTotal(req.params.id);
    auditar({ req, accion: 'ELIMINAR', modulo: 'compras', entidad: 'pedido', entidad_id: String(req.params.id),
      detalle: `Eliminó el ítem #${req.params.itemId} del pedido #${req.params.id}${pedidoEliminado ? ' (quedó vacío y se eliminó el pedido)' : ''}` });
    res.json({ success: true, data: { pedidoEliminado }, error: null });
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
    // Workflow parametrico: con niveles activos la orden nace EN_APROBACION;
    // sin niveles (todo desactivado) queda ABIERTA directo, como antes.
    const NIV = await nivelesAprobacion();
    const niv0 = primerNivelActivo(NIV);
    const estadoIni = niv0 ? 'EN_APROBACION' : 'ABIERTA';

    if (modo === 'CONSOLIDADO') {
      const [[cm]] = await pool.query('SELECT id, nombre FROM compras_direcciones WHERE es_casa_matriz=1 AND activo=1 ORDER BY id LIMIT 1');
      const total = peds.reduce((s, p) => s + Number(p.total), 0);
      const [r] = await pool.query(
        `INSERT INTO compras_ordenes (modo, id_direccion, destino, estado, nivel_actual, total, id_usuario) VALUES ('CONSOLIDADO',?,?,?,?,?,?)`,
        [cm?.id ?? null, cm?.nombre || 'Casa Matriz', estadoIni, niv0, total, uid]);
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
          `INSERT INTO compras_ordenes (modo, id_direccion, destino, estado, nivel_actual, total, id_usuario) VALUES ('SEPARADO',?,?,?,?,?,?)`,
          [dId || null, nombre, estadoIni, niv0, total, uid]);
        await pool.query('UPDATE compras_pedidos SET estado=\'CONSOLIDADO\', id_orden=? WHERE id IN (?)', [r.insertId, gr.map(p => p.id)]);
        ordenes.push(r.insertId);
      }
    }
    auditar({ req, accion: 'CREAR', modulo: 'compras', entidad: 'orden', detalle: `Consolidó ${peds.length} pedido(s) en ${ordenes.length} orden(es) (${modo})`, meta: { modo, ordenes, pedidos: peds.length } });
    if (niv0) for (const oid of ordenes) AVISOS.avisar('compras_aprob_nivel_' + niv0, {
      titulo: 'Orden de compra por firmar',
      mensaje: `La orden de compra #${oid} espera tu firma (${(NIV.find(n=>n.nivel===niv0)||{}).nombre||'nivel '+niv0}).`,
      href: '/soporte/compras-revision/?orden=' + oid,
    }, { excluir: [uid] }).catch(()=>{});
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
    // La hoja de la orden va SEPARADA POR SUCURSAL con el N° de pedido de origen
    const [items_sucursal] = await pool.query(
      `SELECT COALESCE(d.nombre,'Sin sucursal') AS sucursal, p.id AS id_pedido, p.usuario_nombre,
              i.sku, i.nombre, i.cantidad, i.precio_unit, i.subtotal
       FROM compras_pedido_items i
       JOIN compras_pedidos p ON p.id=i.id_pedido
       LEFT JOIN compras_direcciones d ON d.id=p.id_direccion
       WHERE p.id_orden=? ORDER BY sucursal, p.id, i.nombre`, [id]);
    const [firmas] = await pool.query(
      'SELECT nivel, nivel_nombre, usuario, accion, comentario, fecha FROM compras_orden_firmas WHERE id_orden=? ORDER BY fecha', [id]);
    const niveles = await nivelesAprobacion();
    const nivCfg = orden.nivel_actual ? niveles.find(n => n.nivel === orden.nivel_actual) : null;
    const puedo_firmar = orden.estado === 'EN_APROBACION' && puedeFirmarNivel(req, nivCfg);
    res.json({ success: true, data: { orden, items, pedidos, items_sucursal, firmas, niveles, puedo_firmar }, error: null });
  } catch (e) { err(res, e); }
};

/* ── GET /api/compras/admin/pedidos/:id/mes-anterior ─────────────────────────
   Cuánto de CADA producto pidió el MISMO usuario el mes calendario anterior —
   contexto para que el Asistente corrija cantidades con historia a la vista. */
const adminPedidoMesAnterior = async (req, res) => {
  try {
    const id = num(req.params.id);
    const [[p]] = await pool.query('SELECT id_usuario FROM compras_pedidos WHERE id=?', [id]);
    if (!p) return res.status(404).json({ success: false, data: null, error: 'Pedido no encontrado' });
    const [rows] = await pool.query(`
      SELECT i.id_articulo, SUM(i.cantidad) cantidad
        FROM compras_pedido_items i
        JOIN compras_pedidos pe ON pe.id = i.id_pedido
       WHERE pe.id_usuario = ?
         AND pe.fecha >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')
         AND pe.fecha <  DATE_FORMAT(CURDATE(), '%Y-%m-01')
       GROUP BY i.id_articulo`, [p.id_usuario]);
    const porArticulo = {};
    rows.forEach(r => { porArticulo[r.id_articulo] = Number(r.cantidad) || 0; });
    res.json({ success: true, data: { porArticulo }, error: null });
  } catch (e) { err(res, e); }
};

/* ── ODP AUTOMÁTICA al aprobarse la Orden de Compra (Máxima 4: todo movimiento
   de dinero se registra). Una ODP por PROVEEDOR presente en la orden (los
   artículos PRISA a PRISA; el resto al proveedor del catálogo, Dimerc), con el
   detalle del pedido y las firmas de la OC en las observaciones. Monto
   referencial de catálogo (IVA incluido) — se ajusta al recibir la factura.
   Best-effort: si falla, la aprobación NO se cae (queda en el log). */
async function generarODPCompras(idOrden, req) {
  const nom = `${req.usuario.nombre || ''} ${req.usuario.apellido || ''}`.trim() || req.usuario.email;
  const [items] = await pool.query(`
    SELECT i.sku, i.nombre, SUM(i.cantidad) cantidad, SUM(i.subtotal) subtotal,
           COALESCE(a.codigo_ref,'') codigo_ref
      FROM compras_pedido_items i
      JOIN compras_pedidos pe ON pe.id = i.id_pedido AND pe.id_orden = ?
      LEFT JOIN compras_articulos a ON a.id = i.id_articulo
     GROUP BY i.sku, i.nombre, a.codigo_ref ORDER BY i.nombre`, [idOrden]);
  if (!items.length) return [];
  const [firmas] = await pool.query(
    "SELECT usuario, nivel, nivel_nombre, fecha FROM compras_orden_firmas WHERE id_orden=? AND accion='APROBAR' ORDER BY fecha", [idOrden]);
  const grupos = {};
  for (const it of items) {
    const prov = it.codigo_ref === 'PRISA' ? 'PRISA' : 'DIMERC';
    (grupos[prov] = grupos[prov] || []).push(it);
  }
  const odps = [];
  for (const [provNom, its] of Object.entries(grupos)) {
    let [[prov]] = await pool.query('SELECT id, nombre, rut FROM proveedores WHERE UPPER(nombre) LIKE ? LIMIT 1', ['%' + provNom + '%']);
    if (!prov) {
      const [np] = await pool.query('INSERT INTO proveedores (nombre, activo) VALUES (?,1)', [provNom]);
      prov = { id: np.insertId, nombre: provNom, rut: null };
    }
    const total = its.reduce((s, i) => s + Number(i.subtotal || 0), 0);
    const neto = Math.round(total / 1.19), imp = total - neto;
    const detalle = its.map(i => `${i.cantidad} x ${i.nombre}${i.sku ? ` [${i.sku}]` : ''}`).join('\n');
    const firmasTxt = firmas.map(f => `${f.usuario} — ${f.nivel_nombre || ('nivel ' + f.nivel)} (${new Date(f.fecha).toLocaleDateString('es-CL')})`).join(' · ');
    const obs = `Generada automáticamente al aprobarse la Orden de Compra #${idOrden}.` +
      `\nAprobaciones de la OC: ${firmasTxt || '—'}` +
      `\n\nDETALLE DEL PEDIDO (por código de producto):\n${detalle}` +
      `\n\nMonto referencial de catálogo (IVA incluido): ajustar con la factura del proveedor.`;
    const [r] = await pool.query(`
      INSERT INTO ordenes_pago
        (id_proveedor, proveedor_nombre, proveedor_rut, concepto, categoria, tipo_documento,
         tratamiento, monto_bruto, monto_neto, impuesto_pct, impuesto_monto, monto,
         fecha_emision, estado, observaciones, id_usuario, usuario_nombre)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURDATE(),'EMITIDA',?,?,?)`,
      [prov.id, prov.nombre, prov.rut, `Insumos oficina — Orden de Compra #${idOrden} (${prov.nombre})`, 'Insumos',
       'Factura', 'IVA', total, neto, 19, imp, total, obs, req.usuario.id_usuario, nom]);
    const { emitirCorrelativo } = require('../../../../shared/ordenes-pago');
    const { numero } = await emitirCorrelativo({
      origen: 'GENERAL', origen_id: r.insertId,
      concepto: `Insumos oficina — Orden de Compra #${idOrden} — ${prov.nombre}`,
      monto: total, id_usuario: req.usuario.id_usuario, usuario_nombre: nom });
    await pool.query('UPDATE ordenes_pago SET numero=? WHERE id=?', [numero, r.insertId]);
    auditar({ req, accion: 'CREAR', modulo: 'compras', entidad: 'orden_pago', entidad_id: String(r.insertId),
      detalle: `ODP ${numero} generada automáticamente al aprobarse la Orden de Compra #${idOrden} (${prov.nombre}, ${its.length} producto(s), $${total.toLocaleString('es-CL')})` });
    odps.push(numero);
  }
  return odps;
}

/* ── Correo a cada solicitante cuando su pedido queda APROBADO (la OC completó
   las firmas). Detalle producto a producto: cantidad solicitada vs aprobada
   (la aprobada es la corregida por el Asistente antes de consolidar). Texto
   paramétrico en Correos del Sistema (compras_pedido_aprobado). Best-effort. */
async function notificarPedidosAprobados(idOrden) {
  const [peds] = await pool.query(`
    SELECT p.id, p.id_usuario, p.usuario_nombre, u.email, COALESCE(d.nombre,'Casa Matriz') despacho
      FROM compras_pedidos p
      JOIN usuarios u ON u.id_usuario = p.id_usuario
      LEFT JOIN compras_direcciones d ON d.id = p.id_direccion
     WHERE p.id_orden = ?`, [idOrden]);
  if (!peds.length) return;
  const [its] = await pool.query(
    'SELECT id_pedido, nombre, cantidad, COALESCE(cantidad_solicitada, cantidad) solicitada FROM compras_pedido_items WHERE id_pedido IN (?) ORDER BY nombre',
    [peds.map(p => p.id)]);
  const byPed = {};
  for (const it of its) (byPed[it.id_pedido] = byPed[it.id_pedido] || []).push(it);
  const plant = require('../../../../shared/plantillas-correo');
  for (const p of peds) {
    if (!p.email) continue;
    const lineas = (byPed[p.id] || []).map(i =>
      `· ${i.nombre} — solicitado: ${i.solicitada} · aprobado: ${i.cantidad}${Number(i.cantidad) !== Number(i.solicitada) ? ' (ajustado)' : ''}`);
    if (!lineas.length) continue;
    await plant.enviar({
      codigo: 'compras_pedido_aprobado', to: [p.email],
      datos: { nombre: String(p.usuario_nombre || '').split(' ')[0], detalle: lineas.join('\n'), despacho: p.despacho },
    });
  }
}

/* ── POST /api/compras/admin/ordenes/:id/decidir { accion, comentario } ──────
   Firma del nivel actual. APROBAR pasa al siguiente nivel activo (o deja la
   orden ABIERTA, lista para comprar). RECHAZAR devuelve los pedidos al pool. */
const adminOrdenDecidir = async (req, res) => {
  try {
    const id = num(req.params.id);
    const accion = String(req.body.accion || '').toUpperCase();
    if (!['APROBAR', 'RECHAZAR'].includes(accion))
      return res.status(400).json({ success: false, data: null, error: 'Acción inválida' });
    const [[o]] = await pool.query('SELECT * FROM compras_ordenes WHERE id=?', [id]);
    if (!o) return res.status(404).json({ success: false, data: null, error: 'Orden no encontrada' });
    if (o.estado !== 'EN_APROBACION' || !o.nivel_actual)
      return res.status(400).json({ success: false, data: null, error: `La orden está ${o.estado}: no espera firma.` });
    const niveles = await nivelesAprobacion();
    const nivCfg = niveles.find(n => n.nivel === o.nivel_actual);
    if (!puedeFirmarNivel(req, nivCfg))
      return res.status(403).json({ success: false, data: null, error: `Este nivel lo firma: ${nivCfg ? (nivCfg.perfiles || 'personas designadas') : '—'}.` });

    if (accion === 'RECHAZAR' && !String(req.body.comentario || '').trim())
      return res.status(400).json({ success: false, data: null, error: 'Para rechazar debes indicar el motivo (comentario obligatorio).' });

    const nom = `${req.usuario.nombre || ''} ${req.usuario.apellido || ''}`.trim() || req.usuario.email;
    await pool.query(
      'INSERT INTO compras_orden_firmas (id_orden, nivel, nivel_nombre, id_usuario, usuario, accion, comentario) VALUES (?,?,?,?,?,?,?)',
      [id, o.nivel_actual, nivCfg ? nivCfg.nombre : null, req.usuario.id_usuario, nom, accion,
       String(req.body.comentario || '').slice(0, 400) || null]);

    if (accion === 'RECHAZAR') {
      await pool.query("UPDATE compras_ordenes SET estado='RECHAZADA', nivel_actual=NULL WHERE id=?", [id]);
      await pool.query("UPDATE compras_pedidos SET estado='PENDIENTE', id_orden=NULL WHERE id_orden=?", [id]);
      auditar({ req, accion: 'EDITAR', modulo: 'compras', entidad: 'orden', entidad_id: String(id),
        detalle: `RECHAZÓ la orden #${id} en "${nivCfg ? nivCfg.nombre : 'nivel ' + o.nivel_actual}" — los pedidos vuelven a pendientes` });
      AVISOS.avisar('compras_orden_rechazada', { titulo: 'Orden de compra rechazada',
        mensaje: `${nom} rechazó la orden #${id}${req.body.comentario ? ': ' + String(req.body.comentario).slice(0, 120) : ''}. Los pedidos volvieron a pendientes.`,
        href: '/soporte/compras-admin/' }, { excluir: [req.usuario.id_usuario] }).catch(() => {});
      return res.json({ success: true, data: { estado: 'RECHAZADA' }, error: null });
    }

    const sig = siguienteNivelActivo(niveles, o.nivel_actual);
    if (sig) {
      await pool.query('UPDATE compras_ordenes SET nivel_actual=? WHERE id=?', [sig, id]);
      const sigCfg = niveles.find(n => n.nivel === sig);
      AVISOS.avisar('compras_aprob_nivel_' + sig, { titulo: 'Orden de compra por firmar',
        mensaje: `La orden #${id} pasó a "${sigCfg ? sigCfg.nombre : 'nivel ' + sig}" y espera tu firma.`,
        href: '/soporte/compras-revision/?orden=' + id }, { excluir: [req.usuario.id_usuario] }).catch(() => {});
    } else {
      await pool.query("UPDATE compras_ordenes SET estado='ABIERTA', nivel_actual=NULL WHERE id=?", [id]);
      AVISOS.avisar('compras_orden_aprobada', { titulo: 'Orden de compra aprobada',
        mensaje: `La orden #${id} completó todas las firmas: lista para comprar.`,
        href: '/soporte/compras-admin/?orden=' + id }, { excluir: [req.usuario.id_usuario] }).catch(() => {});
    }
    // Orden aprobada por TODOS los niveles → nace su Orden de Pago (Máxima 4)
    // y cada solicitante recibe el correo "tu pedido fue aprobado" con su detalle.
    let odps = null;
    if (!sig) {
      try { odps = await generarODPCompras(id, req); } catch (e) { console.error('[compras ODP auto]', e.message); }
      notificarPedidosAprobados(id).catch(e => console.error('[compras correo aprobado]', e.message));
    }
    auditar({ req, accion: 'EDITAR', modulo: 'compras', entidad: 'orden', entidad_id: String(id),
      detalle: `APROBÓ la orden #${id} en "${nivCfg ? nivCfg.nombre : 'nivel ' + o.nivel_actual}"${sig ? ' → pasa al nivel ' + sig : ' → orden ABIERTA (lista para comprar)'}` });
    res.json({ success: true, data: { estado: sig ? 'EN_APROBACION' : 'ABIERTA', nivel_actual: sig, odps }, error: null });
  } catch (e) { err(res, e); }
};

/* ── Config del workflow (casillas por cargo y/o persona por nivel) ── */
const nivelesGet = async (req, res) => {
  try {
    const niveles = await nivelesAprobacion();
    const [perfiles] = await pool.query('SELECT id_perfil, nombre FROM perfiles ORDER BY nombre');
    const [usuarios] = await pool.query(
      `SELECT u.id_usuario, TRIM(CONCAT(u.nombre,' ',COALESCE(u.apellido,''))) nombre, p.nombre perfil
       FROM usuarios u LEFT JOIN perfiles p ON p.id_perfil=u.id_perfil
       WHERE u.estado='activo' ORDER BY nombre`);
    res.json({ success: true, data: { niveles, perfiles, usuarios }, error: null });
  } catch (e) { err(res, e); }
};
const nivelesSet = async (req, res) => {
  try {
    const nivel = num(req.params.nivel);
    if (![1, 2, 3].includes(nivel)) return res.status(400).json({ success: false, data: null, error: 'Nivel inválido' });
    const b = req.body || {};
    const csv = v => Array.isArray(v) ? v.join(',') : String(v == null ? '' : v);
    await pool.query(
      'UPDATE compras_aprobacion_niveles SET nombre=?, perfiles=?, usuarios=?, activo=?, recordatorio_horas=? WHERE nivel=?',
      [String(b.nombre || 'Nivel ' + nivel).slice(0, 120), csv(b.perfiles), csv(b.usuarios), b.activo ? 1 : 0,
       Math.max(0, parseInt(b.recordatorio_horas, 10) || 0), nivel]);
    auditar({ req, accion: 'EDITAR', modulo: 'compras', entidad: 'aprobacion_nivel', entidad_id: String(nivel),
      detalle: `Configuró el nivel ${nivel} del workflow de aprobación de compras`, meta: b });
    res.json({ success: true, data: null, error: null });
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

/* ── RECORDATORIOS DEL WORKFLOW ────────────────────────────────────────────────
   Cada 30 min: órdenes EN_APROBACION cuya última actividad (última firma, última
   alarma o la creación) superó las `recordatorio_horas` del nivel actual reciben
   una re-alarma (campanita con sonido) al nivel que debe firmar. 0 = sin recordatorio. */
async function recordatoriosWorkflow() {
  try {
    const niveles = await nivelesAprobacion();
    const [ords] = await pool.query(`
      SELECT o.id, o.nivel_actual, o.total,
             GREATEST(COALESCE(o.ultima_alarma, o.fecha),
                      COALESCE((SELECT MAX(f.fecha) FROM compras_orden_firmas f WHERE f.id_orden=o.id), o.fecha),
                      o.fecha) AS ultima_actividad
      FROM compras_ordenes o WHERE o.estado='EN_APROBACION' AND o.nivel_actual IS NOT NULL`);
    for (const o of ords) {
      const cfg = niveles.find(n => n.nivel === o.nivel_actual);
      const horas = cfg ? Number(cfg.recordatorio_horas) : 0;
      if (!horas || horas <= 0) continue;
      const horasSin = (Date.now() - new Date(o.ultima_actividad).getTime()) / 36e5;
      if (horasSin < horas) continue;
      await pool.query('UPDATE compras_ordenes SET ultima_alarma=NOW() WHERE id=?', [o.id]);
      const dest = { titulo: '⏰ Recordatorio: orden de compra sin firmar',
        mensaje: `La orden #${o.id} ($${Math.round(o.total).toLocaleString('es-CL')}) lleva ${Math.floor(horasSin)} h esperando la firma de "${cfg.nombre}".`,
        href: '/soporte/compras-revision/?orden=' + o.id };
      // Al nivel que debe firmar (perfiles/usuarios del nivel) + a los suscritos del evento recordatorio
      await AVISOS.avisar('compras_aprob_nivel_' + o.nivel_actual, dest).catch(() => {});
      await AVISOS.avisar('compras_aprob_recordatorio', dest).catch(() => {});
    }
  } catch (e) { console.error('[compras recordatorios]', e.message); }
}
programar('compras-recordatorios', recordatoriosWorkflow, 30 * 60 * 1000);
setTimeout(recordatoriosWorkflow, 90 * 1000);   // primera pasada al minuto y medio del boot

/* ── BANDEJA DE REVISIÓN (el módulo del firmante) ─────────────────────────────
   GET /api/compras/revision → órdenes que esperan MI firma + mis decisiones.
   Sin requireFunc de admin: la validación real es ser firmante del nivel
   (puedeFirmarNivel) — el detalle y la decisión reusan esa misma guardia. */
const revisionBandeja = async (req, res) => {
  try {
    const niveles = await nivelesAprobacion();
    const [ords] = await pool.query(`
      SELECT o.id, o.estado, o.total, o.fecha, o.nivel_actual, o.observacion,
             (SELECT COUNT(*) FROM compras_pedidos p WHERE p.id_orden=o.id) AS n_pedidos,
             (SELECT MAX(f.fecha) FROM compras_orden_firmas f WHERE f.id_orden=o.id) AS ultima_firma
      FROM compras_ordenes o WHERE o.estado='EN_APROBACION' ORDER BY o.fecha`);
    const pendientes = ords.filter(o => puedeFirmarNivel(req, niveles.find(n => n.nivel === o.nivel_actual)))
      .map(o => ({ ...o, nivel_nombre: (niveles.find(n => n.nivel === o.nivel_actual) || {}).nombre || ('Nivel ' + o.nivel_actual) }));
    const [mias] = await pool.query(`
      SELECT f.id_orden, f.nivel_nombre, f.accion, f.comentario, f.fecha, o.total, o.estado
      FROM compras_orden_firmas f JOIN compras_ordenes o ON o.id=f.id_orden
      WHERE f.id_usuario=? ORDER BY f.fecha DESC LIMIT 60`, [req.usuario.id_usuario]);
    res.json({ success: true, data: { pendientes, mias, niveles }, error: null });
  } catch (e) { err(res, e); }
};

// Detalle para el firmante: mismo payload que el admin, pero la guardia es
// "puedo firmar el nivel actual, ya firmé antes, o soy Administrador".
const revisionDetalle = async (req, res) => {
  try {
    const id = num(req.params.id);
    const [[o]] = await pool.query('SELECT estado, nivel_actual FROM compras_ordenes WHERE id=?', [id]);
    if (!o) return res.status(404).json({ success: false, data: null, error: 'Orden no encontrada' });
    const niveles = await nivelesAprobacion();
    const [[firme]] = await pool.query('SELECT 1 ok FROM compras_orden_firmas WHERE id_orden=? AND id_usuario=? LIMIT 1', [id, req.usuario.id_usuario]);
    const esAdmin = String(req.usuario.perfil_nombre || '') === 'Administrador';
    const puedoNivel = niveles.some(n => puedeFirmarNivel(req, n));
    if (!esAdmin && !firme && !puedoNivel)
      return res.status(403).json({ success: false, data: null, error: 'No eres firmante de este workflow' });
    return adminOrdenDetalle(req, res);
  } catch (e) { err(res, e); }
};

module.exports = {
  catalogo, categorias, catalogoIds, sincronizar, cierrePedidos,
  perfiles, articuloPerfilGet, articuloPerfilSet,
  direccionesList, direccionCrear, direccionEditar, direccionEliminar,
  usuariosConfig, usuarioConfigSet,
  misArticulos, misCategorias, miConfig, crearPedido, misPedidos,
  adminPedidos, adminPedidoMesAnterior, adminItemEditar, adminItemEliminar, consolidar, adminOrdenes, adminOrdenDetalle, adminOrdenEstado,
  adminOrdenDecidir, nivelesGet, nivelesSet, revisionBandeja, revisionDetalle,
  reporteMensual,
};
