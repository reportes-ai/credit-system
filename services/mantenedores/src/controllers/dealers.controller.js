const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');
const RUT = require('../../../../api-gateway/public/js/rut-core');  // enforcement: RUT canónico al guardar

const ensureTable = () => pool.query(`CREATE TABLE IF NOT EXISTS dealers (
  id_dealer        INT AUTO_INCREMENT PRIMARY KEY,
  numero           INT,
  numero_ind       VARCHAR(20),
  rut              VARCHAR(12),
  nombre_indexa    VARCHAR(200),
  nombre_razon     VARCHAR(200),
  ccs_parque       VARCHAR(100),
  direccion        VARCHAR(300),
  fecha_incorporacion DATE,
  contacto         VARCHAR(150),
  telefono         VARCHAR(30),
  correo           VARCHAR(150),
  num_cuenta       VARCHAR(30),
  banco            VARCHAR(80),
  rut_pago         VARCHAR(12),
  activo           TINYINT(1) DEFAULT 1,
  tiene_factura    TINYINT(1) DEFAULT 0,
  observaciones    TEXT,
  UNIQUE KEY uk_rut (rut)
)`);

ensureTable().catch(e => console.error('dealers table init:', e.message));

// Dealers AMBOS (Calle+Parque): segunda tabla de comisión PARQUE + dirección de parque.
// Boot-migration para que el cálculo de créditos y el mantenedor lean estas columnas
// aunque todavía no se haya cerrado ninguna ficha AMBOS (ensureDealersCols las crea en cierre).
require('../../../../shared/migrate').enFila('dealers', async () => {
  const cols = [
    'com_parque_6_12 DECIMAL(5,2)', 'com_parque_13_24 DECIMAL(5,2)',
    'com_parque_25_36 DECIMAL(5,2)', 'com_parque_37 DECIMAL(5,2)',
    'direccion_parque VARCHAR(300)', 'comuna_parque VARCHAR(120)',
    // Geocodificación para el Mapa de Dealers (Google Geocoding API → lat/lng).
    'lat DECIMAL(10,7)', 'lng DECIMAL(10,7)', 'lat_parque DECIMAL(10,7)', 'lng_parque DECIMAL(10,7)',
    'geo_estado VARCHAR(20)', 'geo_dir VARCHAR(300)', 'geo_at DATETIME',
    // Revisión de direcciones: precisión de Google + marca de revisada manual.
    'geo_precision VARCHAR(30)', 'geo_partial TINYINT(1)', 'dir_revisada TINYINT(1)',
  ];
  for (const c of cols) { try { await pool.query(`ALTER TABLE dealers ADD COLUMN IF NOT EXISTS ${c} NULL`); } catch (e) {} }
});

/* ── Locales del dealer: multi-parque + calle (v218.0) ────────────────────────
   Un dealer (identidad única = RUT) puede operar en VARIOS locales: N parques y/o
   calle. Decisión Pato 26-08-2026: las comisiones se pactan POR UBICACIÓN
   (cada parque su tabla + calle la suya) y la cartola sigue siendo UNA por dealer.
   - dealer_locales    : catálogo de locales (ubicacion = 'CALLE' o nombre del parque)
   - dealer_comisiones : tabla pactada por (id_dealer, ubicacion) — la lee el MOTOR
     comision-dealer.js con fallback a las columnas legacy com_ / com_parque_ de dealers.
   Las columnas históricas de `dealers` (ccs_parque, direccion y comisiones) quedan como
   ESPEJO del local principal (espejarDealerDesdeLocales) mientras las pantallas que
   las leen se migran — el espejo mantiene cartas/mapa/visitas funcionando igual. */
require('../../../../shared/migrate').enFila('dealer-locales', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS dealer_locales (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    id_dealer INT NOT NULL,
    ubicacion VARCHAR(150) NOT NULL,
    id_parque INT NULL,
    direccion VARCHAR(300) NULL,
    comuna VARCHAR(120) NULL,
    lat DECIMAL(10,7) NULL, lng DECIMAL(10,7) NULL,
    es_principal TINYINT(1) DEFAULT 0,
    activo TINYINT(1) DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_dealer_ubic (id_dealer, ubicacion),
    KEY idx_dealer (id_dealer)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS dealer_comisiones (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    id_dealer BIGINT NOT NULL,
    ubicacion VARCHAR(150) NOT NULL,
    com_6_12 DECIMAL(5,2) NULL, com_13_24 DECIMAL(5,2) NULL,
    com_25_36 DECIMAL(5,2) NULL, com_37 DECIMAL(5,2) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_dealer_ubic (id_dealer, ubicacion),
    KEY idx_id_dealer (id_dealer)
  )`);
});
// Seed una-vez desde las columnas planas de dealers (fiel a scripts/migracion-dealer-comisiones.js):
// ccs_parque → local PARQUE (con dirección/coords de parque) · calle → local CALLE ·
// com_* → tabla 'CALLE' · com_parque_* → tabla del parque de la ficha.
require('../../../../shared/migrate').migrar('dealer-locales-seed-v1', async () => {
  let idParque = new Map();
  try {
    const [parqs] = await pool.query('SELECT id, UPPER(TRIM(nombre)) nom FROM parques_comisiones');
    idParque = new Map(parqs.map(p => [p.nom, p.id]));
  } catch (e) { /* sin mantenedor de parques aún */ }
  const [ds] = await pool.query(
    `SELECT id_dealer, ccs_parque, tipo_ficha, direccion, comuna, lat, lng,
            direccion_parque, comuna_parque, lat_parque, lng_parque,
            com_6_12, com_13_24, com_25_36, com_37,
            com_parque_6_12, com_parque_13_24, com_parque_25_36, com_parque_37
       FROM dealers`);
  const hay = a => a.some(v => v != null && v !== '');
  for (const d of ds) {
    const ccs = String(d.ccs_parque || '').toUpperCase().trim();
    const esParque = !!ccs && ccs !== 'CALLE' && ccs !== 'PARTICULAR';
    if (esParque)
      await pool.query(
        `INSERT IGNORE INTO dealer_locales (id_dealer, ubicacion, id_parque, direccion, comuna, lat, lng, es_principal)
         VALUES (?,?,?,?,?,?,?,1)`,
        [d.id_dealer, ccs, idParque.get(ccs) || null, d.direccion_parque, d.comuna_parque, d.lat_parque, d.lng_parque]);
    const esAmbos = String(d.tipo_ficha || '').toUpperCase() === 'AMBOS';
    if (!esParque || esAmbos)
      await pool.query(
        `INSERT IGNORE INTO dealer_locales (id_dealer, ubicacion, direccion, comuna, lat, lng, es_principal)
         VALUES (?,?,?,?,?,?,?)`,
        [d.id_dealer, 'CALLE', d.direccion, d.comuna, d.lat, d.lng, esParque ? 0 : 1]);
    if (hay([d.com_6_12, d.com_13_24, d.com_25_36, d.com_37]))
      await pool.query(
        `INSERT IGNORE INTO dealer_comisiones (id_dealer, ubicacion, com_6_12, com_13_24, com_25_36, com_37)
         VALUES (?,'CALLE',?,?,?,?)`,
        [d.id_dealer, d.com_6_12, d.com_13_24, d.com_25_36, d.com_37]);
    if (hay([d.com_parque_6_12, d.com_parque_13_24, d.com_parque_25_36, d.com_parque_37]))
      await pool.query(
        `INSERT IGNORE INTO dealer_comisiones (id_dealer, ubicacion, com_6_12, com_13_24, com_25_36, com_37)
         VALUES (?,?,?,?,?,?)`,
        [d.id_dealer, esParque ? ccs : 'PARQUE', d.com_parque_6_12, d.com_parque_13_24, d.com_parque_25_36, d.com_parque_37]);
  }
  console.log(`[dealer-locales] seed: ${ds.length} dealers procesados`);
});

/* ── Permisos por pestaña del módulo Dealers (v216.7) ─────────────────────────
   Hasta acá "entrar a Dealers" (mantenedores_dealers) daba las tres pestañas
   completas. Ahora cada una tiene su par ver/editar, para poder abrir la Base a
   un ejecutivo sin regalarle la Categoría ni el Potencial.
   Ruta AutoFácil NO se duplica: ya se gobierna con visitas_ver / visitas_dealers
   / visitas_supervisar (una sola fuente de datos).
   El seed reparte los seis según lo que cada perfil YA podía hacer, para que
   nadie pierda acceso el día del deploy; desde ahí se recorta en Perfiles. */
const PESTANAS_DEALERS = [
  ['dealers_base_ver',        'Pestaña Base Dealer — ver'],
  ['dealers_base_editar',     'Pestaña Base Dealer — editar'],
  ['dealers_cat_ver',         'Pestaña Categoría Dealers — ver'],
  ['dealers_cat_editar',      'Pestaña Categoría Dealers — asignar categoría / activar / recalcular'],
  ['dealers_potencial_ver',   'Pestaña Potencial Parque/Dealer — ver'],
  ['dealers_potencial_editar','Pestaña Potencial Parque/Dealer — editar posiciones y ventas'],
];
require('../../../../shared/migrate').migrar('dealers-modulo-propio', async () => {
  // Módulo PROPIO "Dealers": las siete casillas (la del módulo + las seis de
  // pestaña) tienen que quedar juntas bajo su propio título en Perfiles y
  // Permisos, no perdidas entre los mantenedores. Y como la card del home se
  // otorga por tener CUALQUIER funcionalidad del módulo, marcar una sola
  // pestaña ya hace aparecer la card — antes había que acordarse de marcar
  // además "Dealers", y sin eso el permiso quedaba operando sin puerta.
  const RUTA = '/mantenedores/dealers/';
  let [[mod]] = await pool.query('SELECT id_modulo FROM modulos WHERE ruta = ? LIMIT 1', [RUTA]);
  if (!mod) {
    const [[o]] = await pool.query(
      `SELECT COALESCE(MAX(orden), 0) + 1 n FROM modulos WHERE ruta = '/dealers-incorporacion/'`);
    await pool.query(
      `INSERT INTO modulos (nombre, descripcion, icono, ruta, orden, estado)
       VALUES ('Dealers', 'Base de concesionarios, categorías y potencial de crecimiento', 'bi-building', ?, ?, 'activo')`,
      [RUTA, o.n]);
    [[mod]] = await pool.query('SELECT id_modulo FROM modulos WHERE ruta = ? LIMIT 1', [RUTA]);
  }
  if (!mod) return;
  // La casilla que abre el módulo se muda con las demás.
  await pool.query(`UPDATE funcionalidades SET id_modulo = ? WHERE codigo = 'mantenedores_dealers'`, [mod.id_modulo]);

  for (const [codigo, nombre] of PESTANAS_DEALERS) {
    await pool.query(
      `INSERT IGNORE INTO funcionalidades (id_modulo, codigo, nombre, href) VALUES (?,?,?,NULL)`,
      [mod.id_modulo, codigo, nombre]);
    // UPDATE aparte: la primera versión las creó bajo Mantenedores y con el
    // nombre prefijado — acá se mudan y se renombran (el título ya lo da el módulo).
    await pool.query('UPDATE funcionalidades SET id_modulo = ?, nombre = ? WHERE codigo = ?',
      [mod.id_modulo, nombre, codigo]);
    const [[f]] = await pool.query('SELECT id_funcionalidad id FROM funcionalidades WHERE codigo = ?', [codigo]);
    if (!f) continue;
    // Quién lo hereda: VER = quien ya entraba al módulo; EDITAR = quien ya podía
    // escribir en esa pestaña (base = dealer_ficha_revisar; cat/potencial = dealer_mantener).
    const origen = codigo === 'dealers_base_editar'
      ? ['dealer_ficha_revisar']
      : codigo.endsWith('_editar')
        ? ['mantenedores_dealers', 'dealer_mantener']
        : ['mantenedores_dealers', 'dealer_mantener', 'dealer_ficha_revisar'];
    // habilitado = 1 explícito: la columna es DEFAULT 0 y mis-permisos filtra por ella.
    await pool.query(
      `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
       SELECT DISTINCT pp.id_perfil, ?, 1
         FROM permisos_perfil pp
         JOIN funcionalidades fo ON fo.id_funcionalidad = pp.id_funcionalidad
        WHERE pp.habilitado = 1 AND fo.codigo IN (?)`, [f.id, origen]);
  }
});


function excelDate(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.substring(0, 10);
  const d = new Date(Math.round((v - 25569) * 86400000));
  return d.toISOString().slice(0, 10);
}

// Cuerpo del RUT (sin puntos/guión/espacios ni dígito verificador) para cruzar con
// ia_informes_dealernet.rut (que se guarda como el cuerpo). Maneja DV numérico o K.
const RUT_BODY = "LEFT(REPLACE(REPLACE(REPLACE(UPPER(d.rut),'.',''),'-',''),' ',''), GREATEST(CHAR_LENGTH(REPLACE(REPLACE(REPLACE(UPPER(d.rut),'.',''),'-',''),' ',''))-1,0))";
const EXISTS_IA = `EXISTS (SELECT 1 FROM ia_informes_dealernet i WHERE i.rut = ${RUT_BODY})`;

const getDealers = async (req, res) => {
  try {
    const { q, ccs, activo, categoria, con_ia, page = 1, limit = 100 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conds = [], params = [];
    if (q) {
      const ql = `%${q.toLowerCase()}%`;
      conds.push('(LOWER(d.nombre_indexa) LIKE ? OR LOWER(d.nombre_razon) LIKE ? OR LOWER(d.rut) LIKE ?)');
      params.push(ql, ql, ql);
    }
    if (ccs)    { conds.push('d.ccs_parque = ?'); params.push(ccs); }
    if (activo !== undefined && activo !== '') { conds.push('d.activo = ?'); params.push(parseInt(activo)); }
    if (categoria) {
      if (categoria === 'SIN') conds.push("(d.categoria_asignada IS NULL OR d.categoria_asignada = '')");
      else { conds.push('d.categoria_asignada = ?'); params.push(categoria); }
    }
    const soloIA = con_ia === '1' || con_ia === 'true';
    // Flag "tiene reporte IA": los RUT con informe se traen UNA vez (tabla chica) y el
    // flag se calcula en JS. Antes era un EXISTS correlacionado por fila de dealers
    // (678 ms y ~6K RU por consulta, visto en TiDB SQL Statements).
    let rutsIA = new Set();
    try {
      const [ri] = await pool.query('SELECT DISTINCT rut FROM ia_informes_dealernet');
      rutsIA = new Set(ri.map(r => String(r.rut)));
    } catch (_) { /* tabla puede no existir aún */ }
    if (soloIA) {
      if (!rutsIA.size) return res.json({ success: true, data: { rows: [], total: 0, page: parseInt(page) }, error: null });
      conds.push(`${RUT_BODY} IN (?)`); params.push([...rutsIA]);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM dealers d ${where}`, params);
    const [rows] = await pool.query(
      `SELECT d.*,
              (SELECT df.socios FROM dealer_fichas df WHERE df.id_dealer = d.id_dealer AND df.socios IS NOT NULL ORDER BY df.updated_at DESC LIMIT 1) AS ficha_socios
       FROM dealers d ${where} ORDER BY d.numero ASC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]);
    const body = r => { const s = String(r || '').toUpperCase().replace(/[.\-\s]/g, ''); return s.slice(0, -1); };
    rows.forEach(r => { r.tiene_reporte_ia = rutsIA.has(body(r.rut)) ? 1 : 0; });
    // Flag "ya tiene cuenta del portal": apaga el botón de demo comercial en la
    // Base Dealer (mismo patrón tabla-chica de rutsIA, sin EXISTS por fila).
    try {
      const [pc] = await pool.query('SELECT DISTINCT id_dealer FROM ar_dealer_cuentas WHERE activo = 1 AND id_dealer IS NOT NULL');
      const conPortal = new Set(pc.map(x => x.id_dealer));
      rows.forEach(r => { r.tiene_portal = conPortal.has(r.id_dealer) ? 1 : 0; });
    } catch (_) { rows.forEach(r => { r.tiene_portal = 0; }); }
    // Locales activos (multi-parque + calle): la carta los usa para ofrecer al dealer
    // en CADA parque donde tenga local y en calle (v218.4).
    try {
      const ids = rows.map(r => r.id_dealer);
      if (ids.length) {
        const [ls] = await pool.query('SELECT id_dealer, ubicacion FROM dealer_locales WHERE activo=1 AND id_dealer IN (?)', [ids]);
        const de = {}; ls.forEach(l => (de[l.id_dealer] = de[l.id_dealer] || []).push(l.ubicacion));
        rows.forEach(r => { r.locales = de[r.id_dealer] || []; });
      }
    } catch (_) { /* tabla aún no creada */ }
    return res.json({ success: true, data: { rows, total, page: parseInt(page) }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const getDealer = async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM dealers WHERE id_dealer=?', [req.params.id]);
    res.json({ success: true, data: row || null, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const getCcsList = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT DISTINCT ccs_parque FROM dealers WHERE ccs_parque IS NOT NULL ORDER BY ccs_parque');
    res.json({ success: true, data: rows.map(r => r.ccs_parque), error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const importar = async (req, res) => {
  try {
    await ensureTable();
    const { registros } = req.body;
    if (!Array.isArray(registros) || !registros.length)
      return res.status(400).json({ success: false, data: null, error: 'Sin registros' });

    const vals = registros.map(r => [
      r.numero, r.numero_ind, RUT.normalizar(r.rut) || r.rut, r.nombre_indexa, r.nombre_razon,
      r.ccs_parque, r.direccion, r.fecha_incorporacion,
      r.contacto, r.telefono, r.correo,
      r.num_cuenta, r.banco, RUT.normalizar(r.rut_pago) || r.rut_pago,
      r.activo ? 1 : 0, r.tiene_factura ? 1 : 0, r.observaciones || null
    ]);

    const sql = `INSERT IGNORE INTO dealers
      (numero,numero_ind,rut,nombre_indexa,nombre_razon,ccs_parque,direccion,
       fecha_incorporacion,contacto,telefono,correo,num_cuenta,banco,rut_pago,
       activo,tiene_factura,observaciones)
      VALUES ?`;
    const [result] = await pool.query(sql, [vals]);
    auditar({ req, accion: 'CARGA_MASIVA', modulo: 'mantenedores', entidad: 'dealer', detalle: `Importó dealers: ${result.affectedRows} insertado(s)`, meta: { insertados: result.affectedRows } });
    res.json({ success: true, data: { insertados: result.affectedRows }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const createDealer = async (req, res) => {
  try {
    const r = req.body;
    r.rut = RUT.normalizar(r.rut) || r.rut;
    r.rut_pago = RUT.normalizar(r.rut_pago) || r.rut_pago;
    const [[{ maxN }]] = await pool.query('SELECT COALESCE(MAX(numero),0)+1 AS maxN FROM dealers');
    const [result] = await pool.query(
      `INSERT INTO dealers (numero,numero_ind,rut,nombre_indexa,nombre_razon,ccs_parque,
       direccion,fecha_incorporacion,contacto,telefono,correo,num_cuenta,banco,rut_pago,
       activo,tiene_factura,observaciones)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [maxN, r.numero_ind, r.rut, r.nombre_indexa, r.nombre_razon, r.ccs_parque,
       r.direccion, r.fecha_incorporacion || null, r.contacto, r.telefono, r.correo,
       r.num_cuenta, r.banco, r.rut_pago,
       r.activo ? 1 : 0, r.tiene_factura ? 1 : 0, r.observaciones || null]
    );
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'dealer', entidad_id: result.insertId, detalle: `Creó el dealer N°${maxN} — ${r.nombre_razon || r.nombre_indexa || ''}`, rut: r.rut, meta: req.body });
    res.status(201).json({ success: true, data: { id_dealer: result.insertId, numero: maxN }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const updateDealer = async (req, res) => {
  try {
    /* Permisos por campo (Mantenedores › Dealers › Permisos de edición): si el
       perfil no puede tocar un campo, se conserva el valor que ya tenía. Pintar
       el input en gris no basta — sin esto un POST a mano se saltaría la regla. */
    const DC = require('../../../../shared/dealer-campos');
    if (!(await DC.puedeAcceder(req.usuario, 'DEALER')))
      return res.status(403).json({ success: false, data: null, error: 'Tu perfil no puede editar dealers' });
    const { quitados } = await DC.filtrarCuerpo(req.usuario, 'DEALER', req.body);
    if (quitados.length) {
      const [[actual]] = await pool.query('SELECT * FROM dealers WHERE id_dealer=?', [req.params.id]);
      if (actual) quitados.forEach(c => { req.body[c] = actual[c]; });
    }
    const r = req.body;
    r.rut = RUT.normalizar(r.rut) || r.rut;
    r.rut_pago = RUT.normalizar(r.rut_pago) || r.rut_pago;
    await pool.query(
      `UPDATE dealers SET numero_ind=?,rut=?,nombre_indexa=?,nombre_razon=?,ccs_parque=?,
       direccion=?,fecha_incorporacion=?,contacto=?,telefono=?,correo=?,
       num_cuenta=?,banco=?,rut_pago=?,activo=?,tiene_factura=?,observaciones=?
       WHERE id_dealer=?`,
      [r.numero_ind, r.rut, r.nombre_indexa, r.nombre_razon, r.ccs_parque,
       r.direccion, r.fecha_incorporacion || null, r.contacto, r.telefono, r.correo,
       r.num_cuenta, r.banco, r.rut_pago,
       r.activo ? 1 : 0, r.tiene_factura ? 1 : 0, r.observaciones || null,
       req.params.id]
    );
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'dealer', entidad_id: req.params.id, detalle: `Editó el dealer #${req.params.id} — ${r.nombre_razon || r.nombre_indexa || ''}`, rut: r.rut, meta: req.body });
    res.json({ success: true, data: { id_dealer: req.params.id }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const deleteDealer = async (req, res) => {
  try {
    await pool.query('DELETE FROM dealers WHERE id_dealer=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'dealer', entidad_id: req.params.id, detalle: `Eliminó el dealer #${req.params.id}` });
    res.json({ success: true, data: { mensaje: 'Dealer eliminado' }, error: null });
  } catch (e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

/* ── Mapa de Dealers: geocodificación (Google) + datos para el mapa ──────────
   La API key vive en env GOOGLE_MAPS_API_KEY (NO en código). El mapa se pinta con
   Leaflet + OpenStreetMap (sin key); solo la geocodificación usa Google → la key
   nunca se expone al frontend. Las coordenadas se cachean en `dealers` (1 sola vez). */
async function geocodeDireccion(dir) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return { status: 'NO_KEY' };
  if (!dir || !String(dir).trim()) return { status: 'SIN_DIR' };
  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?region=cl&language=es'
      + '&address=' + encodeURIComponent(String(dir).trim()) + '&key=' + key;
    const j = await (await fetch(url)).json();
    if (j.status === 'OK' && j.results && j.results[0]) {
      const g = j.results[0];
      return { status: 'OK', lat: g.geometry.location.lat, lng: g.geometry.location.lng, formatted: g.formatted_address,
               precision: (g.geometry && g.geometry.location_type) || null, partial: g.partial_match ? 1 : 0 };
    }
    return { status: j.status || 'ERROR', error: j.error_message || null };
  } catch (e) { return { status: 'ERROR', error: e.message }; }
}
const _sleep = ms => new Promise(r => setTimeout(r, ms));
// Arma "calle, comuna, región, Chile" para mejorar la precisión del geocoder.
// Pre-normalización: si la comuna ya viene pegada al final de la calle
// ("PADRE HURTADO 1321 LAS CONDES"), se quita de la calle para no duplicarla.
const _normTxt = s => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-ZN0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const sinComunaAlFinal = (calle, comuna) => {
  if (!calle || !comuna) return calle;
  const nc = _normTxt(comuna);
  const words = String(calle).trim().split(/\s+/);
  const k = nc.split(' ').length;                       // n° de palabras de la comuna
  if (words.length > k && _normTxt(words.slice(-k).join(' ')) === nc)
    return words.slice(0, -k).join(' ').replace(/[,\s]+$/, '');
  return calle;
};
const dirCompleta = (d, parque) => {
  const comuna = parque ? (d.comuna_parque || d.comuna) : d.comuna;
  const calle  = sinComunaAlFinal(parque ? d.direccion_parque : d.direccion, comuna) || '';
  const ncalle = _normTxt(calle);
  const partes = [calle];
  if (comuna && !ncalle.includes(_normTxt(comuna))) partes.push(comuna);   // ya viene en el texto → no duplicar
  if (d.region && !ncalle.includes(_normTxt(d.region))) partes.push(d.region);
  if (!ncalle.endsWith('CHILE')) partes.push('Chile');
  return partes.filter(x => x && String(x).trim()).join(', ');
};

const geocodificar = async (req, res) => {
  try {
    if (!process.env.GOOGLE_MAPS_API_KEY)
      return res.status(400).json({ success: false, data: null, error: 'Falta GOOGLE_MAPS_API_KEY en el servidor (Render → Environment).' });
    const limite = Math.min(parseInt(req.body && req.body.limite) || 40, 100);
    const incInactivos = !!(req.body && req.body.incluir_inactivos);
    const fAct = incInactivos ? '1=1' : 'activo=1';
    const [rows] = await pool.query(
      `SELECT id_dealer, numero, direccion, comuna, region, direccion_parque, comuna_parque, lat, lat_parque
         FROM dealers
        WHERE ${fAct} AND (
              (direccion IS NOT NULL AND direccion<>'' AND lat IS NULL)
           OR (direccion_parque IS NOT NULL AND direccion_parque<>'' AND lat_parque IS NULL))
        ORDER BY activo DESC, numero LIMIT ?`, [limite]);
    let ok = 0, fail = 0;
    for (const d of rows) {
      if (d.direccion && d.lat == null) {
        const g = await geocodeDireccion(dirCompleta(d, false));
        if (g.status === 'OK') { await pool.query('UPDATE dealers SET lat=?, lng=?, geo_dir=?, geo_precision=?, geo_partial=?, geo_estado=?, geo_at=NOW() WHERE id_dealer=?', [g.lat, g.lng, g.formatted, g.precision, g.partial, 'OK', d.id_dealer]); ok++; }
        else { await pool.query('UPDATE dealers SET geo_estado=?, geo_at=NOW() WHERE id_dealer=?', [g.status, d.id_dealer]); fail++; }
        await _sleep(120);
      }
      if (d.direccion_parque && d.lat_parque == null) {
        const g = await geocodeDireccion(dirCompleta(d, true));
        if (g.status === 'OK') { await pool.query('UPDATE dealers SET lat_parque=?, lng_parque=? WHERE id_dealer=?', [g.lat, g.lng, d.id_dealer]); ok++; }
        else fail++;
        await _sleep(120);
      }
    }
    const [[{ pend }]] = await pool.query(
      `SELECT COUNT(*) AS pend FROM dealers WHERE ${fAct} AND (
            (direccion IS NOT NULL AND direccion<>'' AND lat IS NULL)
         OR (direccion_parque IS NOT NULL AND direccion_parque<>'' AND lat_parque IS NULL))`);
    auditar({ req, accion: 'GEOCODIFICAR', modulo: 'mantenedores', entidad: 'dealer', detalle: `Geocodificó ${ok} dirección(es) de dealers (${fail} fallida(s))` });
    res.json({ success: true, data: { ok, fallidos: fail, pendientes: pend }, error: null });
  } catch (e) { console.error('[geocodificar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const getMapa = async (req, res) => {
  try {
    const fAct = req.query.todos === '1' ? '1=1' : 'activo=1';
    const [rows] = await pool.query(
      `SELECT id_dealer, numero, rut, COALESCE(NULLIF(nombre_indexa,''), nombre_razon) AS nombre,
              nombre_razon, ccs_parque, tipo_ficha, direccion, comuna, region,
              direccion_parque, comuna_parque, categoria_asignada, categoria_propuesta,
              telefono, lat, lng, lat_parque, lng_parque, geo_estado, activo
         FROM dealers WHERE ${fAct} ORDER BY numero`);
    const [[stats]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) AS con_coord,
              SUM(CASE WHEN (direccion IS NOT NULL AND direccion<>'' AND lat IS NULL)
                         OR (direccion_parque IS NOT NULL AND direccion_parque<>'' AND lat_parque IS NULL) THEN 1 ELSE 0 END) AS pendientes
         FROM dealers WHERE ${fAct}`);
    res.json({ success: true, data: { rows, stats, tiene_key: !!process.env.GOOGLE_MAPS_API_KEY }, error: null });
  } catch (e) { console.error('[getMapa]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Revisión de direcciones: tu dirección vs la normalizada por Google ──────
   `duda` = Google no está seguro (partial_match), o la precisión es baja
   (APPROXIMATE/GEOMETRIC_CENTER), o no se pudo geocodificar. Se priorizan. */
const DUDA_SQL = "(geo_partial=1 OR geo_precision IN ('APPROXIMATE','GEOMETRIC_CENTER') OR geo_dir IS NULL)";
const getDirecciones = async (req, res) => {
  try {
    const fAct = req.query.todos === '1' ? '1=1' : 'activo=1';
    const [rows] = await pool.query(
      `SELECT id_dealer, numero, rut, COALESCE(NULLIF(nombre_indexa,''), nombre_razon) AS nombre,
              comuna, region, direccion, geo_dir, geo_precision, geo_partial, lat, lng, activo,
              COALESCE(dir_revisada,0) AS dir_revisada, ${DUDA_SQL} AS duda
         FROM dealers
        WHERE ${fAct} AND direccion IS NOT NULL AND direccion<>''
        ORDER BY COALESCE(dir_revisada,0) ASC, ${DUDA_SQL} DESC, numero ASC`);
    const [[stats]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN COALESCE(dir_revisada,0)=1 THEN 1 ELSE 0 END) AS revisadas,
              SUM(CASE WHEN COALESCE(dir_revisada,0)=0 AND ${DUDA_SQL} THEN 1 ELSE 0 END) AS dudas
         FROM dealers WHERE ${fAct} AND direccion IS NOT NULL AND direccion<>''`);
    res.json({ success: true, data: { rows, stats, tiene_key: !!process.env.GOOGLE_MAPS_API_KEY }, error: null });
  } catch (e) { console.error('[getDirecciones]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// POST /:id/direccion { accion:'guardar'|'mantener', direccion? }
const setDireccion = async (req, res) => {
  try {
    const id = req.params.id;
    const accion = (req.body && req.body.accion) || 'guardar';
    const [[d]] = await pool.query('SELECT id_dealer, comuna, region FROM dealers WHERE id_dealer=?', [id]);
    if (!d) return res.status(404).json({ success: false, data: null, error: 'Dealer no encontrado' });
    if (accion === 'mantener') {
      await pool.query('UPDATE dealers SET dir_revisada=1 WHERE id_dealer=?', [id]);
      auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'dealer', entidad_id: id, detalle: 'Mantuvo la dirección original (revisión de direcciones)' });
      const [[r]] = await pool.query('SELECT lat, lng, geo_dir, geo_precision, geo_partial, dir_revisada FROM dealers WHERE id_dealer=?', [id]);
      return res.json({ success: true, data: r, error: null });
    }
    const nueva = String((req.body && req.body.direccion) || '').trim();
    if (!nueva) return res.status(400).json({ success: false, data: null, error: 'Dirección vacía' });
    // Guarda la dirección elegida y re-geocodifica para refrescar el punto del mapa.
    const g = await geocodeDireccion([nueva, d.comuna, d.region, 'Chile'].filter(x => x && String(x).trim()).join(', '));
    if (g.status === 'OK')
      await pool.query('UPDATE dealers SET direccion=?, lat=?, lng=?, geo_dir=?, geo_precision=?, geo_partial=?, geo_estado=?, geo_at=NOW(), dir_revisada=1 WHERE id_dealer=?',
        [nueva, g.lat, g.lng, g.formatted, g.precision, g.partial, 'OK', id]);
    else
      await pool.query('UPDATE dealers SET direccion=?, dir_revisada=1 WHERE id_dealer=?', [nueva, id]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'dealer', entidad_id: id, detalle: `Actualizó la dirección a "${nueva}" (revisión de direcciones)` });
    const [[r]] = await pool.query('SELECT lat, lng, geo_dir, geo_precision, geo_partial, dir_revisada FROM dealers WHERE id_dealer=?', [id]);
    res.json({ success: true, data: { ...r, geo_status: g.status }, error: null });
  } catch (e) { console.error('[setDireccion]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Locales y comisiones por ubicación (v218.0) ─────────────────────────────
   Fuente única nueva: dealer_locales + dealer_comisiones. Las columnas planas de
   `dealers` se mantienen como ESPEJO del local principal para las pantallas legacy. */
const normUbicSrv = u => String(u || '').toUpperCase().trim();

async function espejarDealerDesdeLocales(idDealer) {
  const [locs] = await pool.query('SELECT * FROM dealer_locales WHERE id_dealer=? AND activo=1', [idDealer]);
  const parques = locs.filter(l => normUbicSrv(l.ubicacion) !== 'CALLE');
  const calle   = locs.find(l => normUbicSrv(l.ubicacion) === 'CALLE') || null;
  const prin    = parques.find(l => l.es_principal) || parques[0] || null;
  const sets = [], vals = [];
  if (prin) {
    sets.push('ccs_parque=?', 'direccion_parque=?', 'comuna_parque=?', 'lat_parque=?', 'lng_parque=?');
    vals.push(prin.ubicacion, prin.direccion, prin.comuna, prin.lat, prin.lng);
  } else if (calle) { sets.push('ccs_parque=?'); vals.push('CALLE'); }
  if (calle && calle.direccion) {
    sets.push('direccion=?', 'comuna=?'); vals.push(calle.direccion, calle.comuna);
    if (calle.lat != null) { sets.push('lat=?', 'lng=?'); vals.push(calle.lat, calle.lng); }
  }
  // AMBOS solo se afirma (parque+calle); con un solo tipo se respeta lo que diga la ficha.
  if (prin && calle) sets.push("tipo_ficha='AMBOS'");
  const [coms] = await pool.query('SELECT * FROM dealer_comisiones WHERE id_dealer=?', [idDealer]);
  const cCalle = coms.find(c => normUbicSrv(c.ubicacion) === 'CALLE');
  const cPrin  = prin ? coms.find(c => normUbicSrv(c.ubicacion) === normUbicSrv(prin.ubicacion)) : null;
  if (cCalle) { sets.push('com_6_12=?', 'com_13_24=?', 'com_25_36=?', 'com_37=?'); vals.push(cCalle.com_6_12, cCalle.com_13_24, cCalle.com_25_36, cCalle.com_37); }
  if (cPrin)  { sets.push('com_parque_6_12=?', 'com_parque_13_24=?', 'com_parque_25_36=?', 'com_parque_37=?'); vals.push(cPrin.com_6_12, cPrin.com_13_24, cPrin.com_25_36, cPrin.com_37); }
  if (sets.length) await pool.query(`UPDATE dealers SET ${sets.join(', ')} WHERE id_dealer=?`, [...vals, idDealer]);
}

// GET /api/dealers/:id/locales → locales + su tabla pactada por ubicación
const getLocales = async (req, res) => {
  try {
    const id = req.params.id;
    const [locs] = await pool.query(
      'SELECT * FROM dealer_locales WHERE id_dealer=? ORDER BY activo DESC, es_principal DESC, ubicacion', [id]);
    const [coms] = await pool.query(
      'SELECT ubicacion, com_6_12, com_13_24, com_25_36, com_37 FROM dealer_comisiones WHERE id_dealer=?', [id]);
    const comDe = {}; coms.forEach(c => { comDe[normUbicSrv(c.ubicacion)] = c; });
    locs.forEach(l => { l.comisiones = comDe[normUbicSrv(l.ubicacion)] || null; });
    // Tablas pactadas sin local asociado (ej. fila genérica 'PARQUE' del seed): visibles igual
    const sinLocal = coms.filter(c => !locs.some(l => normUbicSrv(l.ubicacion) === normUbicSrv(c.ubicacion)));
    res.json({ success: true, data: { locales: locs, comisiones_sin_local: sinLocal }, error: null });
  } catch (e) { console.error('[getLocales]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// POST /api/dealers/:id/locales — crea/actualiza el local (llave id_dealer+ubicacion)
// y su tabla de comisión. body: { ubicacion, direccion, comuna, es_principal, activo, com_6_12..com_37 }
const saveLocal = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const ubic = normUbicSrv(b.ubicacion);
    if (!id || !ubic) return res.status(400).json({ success: false, data: null, error: 'Falta la ubicación del local' });
    let idParque = null;
    if (ubic !== 'CALLE') {
      // La ubicación parque debe existir en el mantenedor (llave de facto contra creditos.parque)
      const [[pq]] = await pool.query('SELECT id FROM parques_comisiones WHERE UPPER(TRIM(nombre))=? LIMIT 1', [ubic]);
      if (!pq) return res.status(400).json({ success: false, data: null, error: `"${ubic}" no es un parque del mantenedor Arriendos y Comisiones (o escribe CALLE)` });
      idParque = pq.id;
    }
    const [[dl]] = await pool.query('SELECT id_dealer, nombre_razon, nombre_indexa, rut FROM dealers WHERE id_dealer=?', [id]);
    if (!dl) return res.status(404).json({ success: false, data: null, error: 'Dealer no encontrado' });
    await pool.query(
      `INSERT INTO dealer_locales (id_dealer, ubicacion, id_parque, direccion, comuna, es_principal, activo)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE id_parque=VALUES(id_parque), direccion=VALUES(direccion), comuna=VALUES(comuna),
         es_principal=VALUES(es_principal), activo=VALUES(activo)`,
      [id, ubic, idParque, String(b.direccion || '').trim() || null, String(b.comuna || '').trim() || null,
       b.es_principal ? 1 : 0, b.activo === 0 || b.activo === false ? 0 : 1]);
    // Un solo principal entre los locales PARQUE (es el que se espeja a ccs_parque)
    if (b.es_principal && ubic !== 'CALLE')
      await pool.query("UPDATE dealer_locales SET es_principal=0 WHERE id_dealer=? AND ubicacion<>? AND UPPER(ubicacion)<>'CALLE'", [id, ubic]);
    // Tabla pactada de la ubicación (si el cuerpo trae algún tramo, se escriben los 4 tal cual)
    const T = ['com_6_12', 'com_13_24', 'com_25_36', 'com_37'];
    if (T.some(k => b[k] !== undefined)) {
      const pct = k => { const v = b[k]; return (v === '' || v == null) ? null : Number(v); };
      if (T.some(k => pct(k) != null && (isNaN(pct(k)) || pct(k) < 0 || pct(k) > 99)))
        return res.status(400).json({ success: false, data: null, error: 'Comisión inválida: cada tramo debe ser un % entre 0 y 99' });
      await pool.query(
        `INSERT INTO dealer_comisiones (id_dealer, ubicacion, com_6_12, com_13_24, com_25_36, com_37)
         VALUES (?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE com_6_12=VALUES(com_6_12), com_13_24=VALUES(com_13_24), com_25_36=VALUES(com_25_36), com_37=VALUES(com_37)`,
        [id, ubic, pct('com_6_12'), pct('com_13_24'), pct('com_25_36'), pct('com_37')]);
    }
    await espejarDealerDesdeLocales(id);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'dealer', entidad_id: id, rut: dl.rut,
      detalle: `Guardó el local ${ubic} del dealer ${dl.nombre_razon || dl.nombre_indexa || '#' + id}${T.some(k => b[k] !== undefined) ? ' (incluye tabla de comisión)' : ''}`, meta: b });
    res.json({ success: true, data: { id_dealer: id, ubicacion: ubic }, error: null });
  } catch (e) { console.error('[saveLocal]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// DELETE /api/dealers/:id/locales/:idLocal — desactiva (nunca borra: las ops históricas lo referencian)
const deleteLocal = async (req, res) => {
  try {
    const { id, idLocal } = req.params;
    const [[l]] = await pool.query('SELECT ubicacion FROM dealer_locales WHERE id=? AND id_dealer=?', [idLocal, id]);
    if (!l) return res.status(404).json({ success: false, data: null, error: 'Local no encontrado' });
    await pool.query('UPDATE dealer_locales SET activo=0, es_principal=0 WHERE id=?', [idLocal]);
    await espejarDealerDesdeLocales(parseInt(id));
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'dealer', entidad_id: id, detalle: `Desactivó el local ${l.ubicacion} del dealer #${id}` });
    res.json({ success: true, data: { ubicacion: l.ubicacion }, error: null });
  } catch (e) { console.error('[deleteLocal]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Zona - Parque - Dealer (base de posiciones, v221.0) ─────────────────────
   Base comercial cargada desde el Excel de zonas: qué dealer (sucursal) está en
   qué parque/zona, cuántas posiciones tiene y quién lo atiende. El RUT se agregó
   con match automático contra `dealers` (los sin match quedan NULL y se completan
   a mano desde el mantenedor). categoria/estado aquí son los del Excel comercial,
   NO reemplazan a categoria_asignada de dealers. */
require('../../../../shared/migrate').enFila('zona-parque-dealer', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS zona_parque_dealer (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    zona VARCHAR(60) NOT NULL,
    parque VARCHAR(120) NOT NULL,
    sucursal VARCHAR(200) NOT NULL,
    posiciones INT DEFAULT 0,
    categoria VARCHAR(40) NULL,
    estado VARCHAR(60) NULL,
    jefe VARCHAR(120) NULL,
    ejecutivo1 VARCHAR(120) NULL,
    ejecutivo2 VARCHAR(120) NULL,
    rut_dealer VARCHAR(15) NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_zona (zona), KEY idx_parque (parque), KEY idx_rut (rut_dealer)
  )`);
});

const getZonaParque = async (req, res) => {
  try {
    // Categoría: si la fila está vinculada a un dealer (RUT), manda la categoria_asignada
    // de su ficha (fuente única — se refleja solo al cambiarla en Base Dealer); si no
    // hay RUT, queda la que venía del Excel comercial.
    const [rows] = await pool.query(`
      SELECT z.id, z.zona, z.parque, z.sucursal, z.posiciones, z.estado, z.jefe,
             z.ejecutivo1, z.ejecutivo2, z.rut_dealer,
             COALESCE(NULLIF(TRIM(d.categoria_asignada), ''), z.categoria) AS categoria,
             d.nombre_indexa AS dealer_bd
      FROM zona_parque_dealer z
      LEFT JOIN dealers d ON d.rut = z.rut_dealer
      ORDER BY z.zona, z.parque, z.sucursal`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const updateZonaParque = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'id inválido' });
    const b = req.body || {};
    const campos = ['zona','parque','sucursal','posiciones','categoria','estado','jefe','ejecutivo1','ejecutivo2','rut_dealer'];
    const sets = [], vals = [];
    for (const c of campos) if (c in b) { sets.push(`${c}=?`); vals.push(b[c] === '' ? null : b[c]); }
    if (!sets.length) return res.status(400).json({ success: false, error: 'nada que actualizar' });
    let dealer_bd = null;
    if (b.rut_dealer) {
      const [[d]] = await pool.query('SELECT nombre_indexa FROM dealers WHERE rut = ?', [String(b.rut_dealer).trim()]);
      if (!d) return res.status(404).json({ success: false, error: `RUT ${b.rut_dealer} no existe en la base de dealers` });
      dealer_bd = d.nombre_indexa;
    }
    vals.push(id);
    const [r] = await pool.query(`UPDATE zona_parque_dealer SET ${sets.join(', ')} WHERE id = ?`, vals);
    if (!r.affectedRows) return res.status(404).json({ success: false, error: 'fila no encontrada' });
    res.json({ success: true, data: { dealer_bd }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const createZonaParque = async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.zona || !b.parque || !b.sucursal) return res.status(400).json({ success: false, error: 'zona, parque y sucursal son obligatorios' });
    if (b.rut_dealer) {
      const [[d]] = await pool.query('SELECT rut FROM dealers WHERE rut = ?', [String(b.rut_dealer).trim()]);
      if (!d) return res.status(404).json({ success: false, error: `RUT ${b.rut_dealer} no existe en la base de dealers` });
    }
    const [r] = await pool.query(
      `INSERT INTO zona_parque_dealer (zona, parque, sucursal, posiciones, categoria, estado, jefe, ejecutivo1, ejecutivo2, rut_dealer)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [b.zona, b.parque, b.sucursal, Number(b.posiciones)||0, b.categoria||null, b.estado||null, b.jefe||null, b.ejecutivo1||null, b.ejecutivo2||null, b.rut_dealer||null]);
    res.json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

const deleteZonaParque = async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM zona_parque_dealer WHERE id = ?', [Number(req.params.id)]);
    if (!r.affectedRows) return res.status(404).json({ success: false, error: 'fila no encontrada' });
    res.json({ success: true, data: null, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: e.message }); }
};

module.exports = { getDealers, getDealer, getCcsList, importar, createDealer, updateDealer, deleteDealer, getMapa, geocodificar, getDirecciones, setDireccion, getLocales, saveLocal, deleteLocal, getZonaParque, updateZonaParque, createZonaParque, deleteZonaParque };
