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
(async () => {
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
})();

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
    if (soloIA) conds.push(EXISTS_IA);
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    try {
      const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM dealers d ${where}`, params);
      const [rows] = await pool.query(
        `SELECT d.*, ${EXISTS_IA} AS tiene_reporte_ia,
                (SELECT df.socios FROM dealer_fichas df WHERE df.id_dealer = d.id_dealer AND df.socios IS NOT NULL ORDER BY df.updated_at DESC LIMIT 1) AS ficha_socios
         FROM dealers d ${where} ORDER BY d.numero ASC LIMIT ? OFFSET ?`,
        [...params, parseInt(limit), offset]);
      return res.json({ success: true, data: { rows, total, page: parseInt(page) }, error: null });
    } catch (eIA) {
      // Fallback si ia_informes_dealernet no existe aún: lista normal sin el flag IA.
      console.error('[dealers getDealers IA fallback]', eIA.message);
      const where2 = where.replace(EXISTS_IA, '1=1');
      const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM dealers d ${where2}`, params);
      const [rows] = await pool.query(`SELECT d.* FROM dealers d ${where2} ORDER BY d.numero ASC LIMIT ? OFFSET ?`, [...params, parseInt(limit), offset]);
      return res.json({ success: true, data: { rows, total, page: parseInt(page) }, error: null });
    }
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
const dirCompleta = (d, parque) => [
  parque ? d.direccion_parque : d.direccion,
  parque ? (d.comuna_parque || d.comuna) : d.comuna,
  d.region, 'Chile'
].filter(x => x && String(x).trim()).join(', ');

const geocodificar = async (req, res) => {
  try {
    if (!process.env.GOOGLE_MAPS_API_KEY)
      return res.status(400).json({ success: false, data: null, error: 'Falta GOOGLE_MAPS_API_KEY en el servidor (Render → Environment).' });
    const limite = Math.min(parseInt(req.body && req.body.limite) || 40, 100);
    const [rows] = await pool.query(
      `SELECT id_dealer, numero, direccion, comuna, region, direccion_parque, comuna_parque, lat, lat_parque
         FROM dealers
        WHERE activo=1 AND (
              (direccion IS NOT NULL AND direccion<>'' AND lat IS NULL)
           OR (direccion_parque IS NOT NULL AND direccion_parque<>'' AND lat_parque IS NULL))
        ORDER BY numero LIMIT ?`, [limite]);
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
      `SELECT COUNT(*) AS pend FROM dealers WHERE activo=1 AND (
            (direccion IS NOT NULL AND direccion<>'' AND lat IS NULL)
         OR (direccion_parque IS NOT NULL AND direccion_parque<>'' AND lat_parque IS NULL))`);
    auditar({ req, accion: 'GEOCODIFICAR', modulo: 'mantenedores', entidad: 'dealer', detalle: `Geocodificó ${ok} dirección(es) de dealers (${fail} fallida(s))` });
    res.json({ success: true, data: { ok, fallidos: fail, pendientes: pend }, error: null });
  } catch (e) { console.error('[geocodificar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const getMapa = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_dealer, numero, rut, COALESCE(NULLIF(nombre_indexa,''), nombre_razon) AS nombre,
              nombre_razon, ccs_parque, tipo_ficha, direccion, comuna, region,
              direccion_parque, comuna_parque, categoria_asignada, categoria_propuesta,
              telefono, lat, lng, lat_parque, lng_parque, geo_estado
         FROM dealers WHERE activo=1 ORDER BY numero`);
    const [[stats]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN lat IS NOT NULL THEN 1 ELSE 0 END) AS con_coord,
              SUM(CASE WHEN (direccion IS NOT NULL AND direccion<>'' AND lat IS NULL)
                         OR (direccion_parque IS NOT NULL AND direccion_parque<>'' AND lat_parque IS NULL) THEN 1 ELSE 0 END) AS pendientes
         FROM dealers WHERE activo=1`);
    res.json({ success: true, data: { rows, stats, tiene_key: !!process.env.GOOGLE_MAPS_API_KEY }, error: null });
  } catch (e) { console.error('[getMapa]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── Revisión de direcciones: tu dirección vs la normalizada por Google ──────
   `duda` = Google no está seguro (partial_match), o la precisión es baja
   (APPROXIMATE/GEOMETRIC_CENTER), o no se pudo geocodificar. Se priorizan. */
const DUDA_SQL = "(geo_partial=1 OR geo_precision IN ('APPROXIMATE','GEOMETRIC_CENTER') OR geo_dir IS NULL)";
const getDirecciones = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id_dealer, numero, rut, COALESCE(NULLIF(nombre_indexa,''), nombre_razon) AS nombre,
              comuna, region, direccion, geo_dir, geo_precision, geo_partial, lat, lng,
              COALESCE(dir_revisada,0) AS dir_revisada, ${DUDA_SQL} AS duda
         FROM dealers
        WHERE activo=1 AND direccion IS NOT NULL AND direccion<>''
        ORDER BY COALESCE(dir_revisada,0) ASC, ${DUDA_SQL} DESC, numero ASC`);
    const [[stats]] = await pool.query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN COALESCE(dir_revisada,0)=1 THEN 1 ELSE 0 END) AS revisadas,
              SUM(CASE WHEN COALESCE(dir_revisada,0)=0 AND ${DUDA_SQL} THEN 1 ELSE 0 END) AS dudas
         FROM dealers WHERE activo=1 AND direccion IS NOT NULL AND direccion<>''`);
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

module.exports = { getDealers, getDealer, getCcsList, importar, createDealer, updateDealer, deleteDealer, getMapa, geocodificar, getDirecciones, setDireccion };
