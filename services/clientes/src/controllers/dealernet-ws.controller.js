'use strict';
/**
 * Integración DealerNet — Central de Información (Web Service SOAP).
 * Método CentralDeInformacion: consulta antecedentes por RUT y lista de
 * productos. Reemplaza la carga manual de PDF: trae la misma data en vivo.
 *
 * Credenciales SIEMPRE por variables de entorno (nunca en el código):
 *   DEALERNET_USER, DEALERNET_PASS
 *   DEALERNET_ENDPOINT (opcional, default producción)
 *   DEALERNET_TIPOCNS  (opcional, default 'O')
 *
 * Este archivo: migraciones (mantenedor de productos + bitácora de consultas),
 * el cliente SOAP y los endpoints. El parseo fino por producto se afina cuando
 * haya una respuesta real (cada producto trae su propio formato de salida).
 */
const pool = require('../../../../shared/config/database');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { auditar } = require('../../../../shared/audit');

const ENDPOINT    = process.env.DEALERNET_ENDPOINT || 'https://infows.dealernet.cl/wsinfodlnt.asmx';
const SOAP_ACTION = 'http://dealernet.cl/webservices/CentralDeInformacion';
const TIPOCNS_DEF = process.env.DEALERNET_TIPOCNS || 'O';

const errSrv = (res, e, tag) => { console.error(`[${tag}]`, e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); };

// Catálogo del protocolo general v14 (códigos 3401–3450) + productos con código
// propio fuera de ese rango (16, 2101). Activos por defecto los que pidió el
// negocio y ya tienen código confirmado.
const CATALOGO = [
  ['3401','Comportamiento Civil'], ['3402','Comportamiento Laboral'], ['3403','Comportamiento Penal'],
  ['3404','Boletín Concursal'], ['3407','Contactabilidad'], ['3408','Verificación Múltiple'],
  ['3409','Directorio Direcciones'], ['3410','Directorio Teléfonos'], ['3411','Directorio Correo'],
  ['3412','Registro Automotriz'], ['3413','Índice de Propiedades'], ['3414','Activos'],
  ['3417','Ficha Empresa'], ['3419','Cobranza Laboral'], ['3420','Registro de Sanciones (SNIFA)'],
  ['3421','Registros de Relacionados'], ['3423','Carga Familiar-Índice'], ['3425','Boletín Impagos Vigentes'],
  ['3426','Boletín Impagos Históricos'], ['3427','Boletín Lab. y Prev. Vigente'], ['3428','Boletín Lab. y Prev. Histórico'],
  ['3429','Boletín de Alertas'], ['3430','Malla Societaria'], ['3431','Índice Judicial Civil'],
  ['3432','Índice Judicial Laboral'], ['3433','Índice Judicial Penal'], ['3434','Índice Judicial Cobranza'],
  ['3435','Perfil Comercial'], ['3439','Boletín de Procesos Penales'], ['3440','Identificación'],
  ['3443','Registro Propiedades'], ['3450','Persona Expuesta Políticamente (PEP)'],
  // Códigos propios (fuera del rango 3401–3450), confirmados por DealerNet:
  ['16','Comportamiento Vigente'], ['2101','Boletín Deudores de Pensión de Alimentos'],
];
const ACTIVOS_DEFAULT = ['3435', '3425', '16', '2101'];
// Productos con código propio: alta idempotente para BD ya sembradas antes de
// tener estos códigos (no fuerza 'activo' tras el alta — eso lo maneja el admin).
const EXTRA_CODIGOS = ['16', '2101'];

(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS dealernet_productos (
      id     INT AUTO_INCREMENT PRIMARY KEY,
      codigo VARCHAR(10) NOT NULL UNIQUE,
      nombre VARCHAR(120) NOT NULL,
      activo TINYINT(1) DEFAULT 0,
      orden  INT DEFAULT 0
    )`);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) n FROM dealernet_productos');
    if (n === 0) {
      let o = 1;
      for (const [cod, nom] of CATALOGO)
        await pool.query('INSERT IGNORE INTO dealernet_productos (codigo, nombre, activo, orden) VALUES (?,?,?,?)',
          [cod, nom, ACTIVOS_DEFAULT.includes(cod) ? 1 : 0, o++]);
    }
    // Alta idempotente de los códigos propios (16, 2101) para BD ya sembradas.
    const [[{ mo }]] = await pool.query('SELECT COALESCE(MAX(orden),0) mo FROM dealernet_productos');
    let oExtra = mo;
    for (const cod of EXTRA_CODIGOS) {
      const nom = (CATALOGO.find(c => c[0] === cod) || [, cod])[1];
      await pool.query('INSERT IGNORE INTO dealernet_productos (codigo, nombre, activo, orden) VALUES (?,?,1,?)',
        [cod, nom, ++oExtra]);
    }

    await pool.query(`CREATE TABLE IF NOT EXISTS dealernet_consultas (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      rut        VARCHAR(12),
      dv         VARCHAR(2),
      productos  VARCHAR(255),
      retcode    VARCHAR(10),
      retmsg     VARCHAR(255),
      output_raw LONGTEXT,
      parsed     JSON NULL,
      id_usuario INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_rut (rut)
    )`);

    // Mantenedor + permiso de consulta (anti-hardcode: módulo/funcionalidad en BD).
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo' LIMIT 1");
    if (mod) {
      for (const f of [
        { nombre: 'Productos DealerNet', codigo: 'mant_dealernet_productos', href: '/mantenedores/dealernet-productos/', icono: 'bi-cloud-arrow-down' },
        { nombre: 'Consultar DealerNet', codigo: 'dealernet_consultar', href: null, icono: 'bi-search' },
      ]) {
        const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [f.codigo]);
        let idf = ex && ex.id_funcionalidad;
        if (!idf) {
          const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
            [mod.id_modulo, f.nombre, f.codigo, f.href, f.icono]);
          idf = r.insertId;
        }
        const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
        if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
      }
    }
    console.log('[dealernet-ws] mantenedor y esquema listos');
  } catch (e) { console.error('[dealernet-ws migration]', e.message); }
})();

/* ── Migración: repositorio de informes compartido + config + módulo card ──── */
(async () => {
  try {
    // Repositorio compartido: un registro por RUT+producto+consulta. Todos los
    // usuarios con permiso ven el mismo histórico (no se duplica por usuario).
    await pool.query(`CREATE TABLE IF NOT EXISTS dealernet_informes (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      rut             VARCHAR(12) NOT NULL,
      dv              VARCHAR(2),
      codigo_producto VARCHAR(10) NOT NULL,
      nombre_producto VARCHAR(120),
      retcode         VARCHAR(10),
      retmsg          VARCHAR(255),
      ws_tag          VARCHAR(80),
      contenido       JSON NULL,
      pdf_url         TEXT NULL,
      id_consulta     INT NULL,
      id_usuario      INT NULL,
      usuario_nombre  VARCHAR(120),
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_rut_prod (rut, codigo_producto, created_at)
    )`);

    // Config paramétrica (umbrales editables por el Administrador, sin tocar código).
    await pool.query(`CREATE TABLE IF NOT EXISTS dealernet_config (
      clave VARCHAR(40) PRIMARY KEY,
      valor VARCHAR(40) NOT NULL
    )`);
    await pool.query("INSERT IGNORE INTO dealernet_config (clave, valor) VALUES ('dias_bloqueo','15'), ('dias_vigencia','180')");

    // Módulo/card propio "Informes DealerNet" (anti-hardcode: vive en BD).
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (380001, 'Informes DealerNet', 'Consulta de antecedentes por RUT vía Web Service, con repositorio compartido de informes', 'bi-clipboard-data', '/dealernet-informes/', 105, 'activo')`);
    const funcs = [
      ['Informes DealerNet', 'dealernet_informes_ver', '/dealernet-informes/', 'bi-clipboard-data'],
    ];
    const idFunc = {};
    for (const [nombre, codigo, href, icono] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (380001,?,?,?,?)', [nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    // Permisos por defecto. dealernet_informes_ver = ver repositorio (gratis);
    // dealernet_consultar = solicitar a DealerNet (gasta saldo, más restringido).
    const [[fc]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='dealernet_consultar' LIMIT 1");
    const seed = {
      [idFunc['dealernet_informes_ver']]: [1, 4, 6, 90008],
      ...(fc ? { [fc.id_funcionalidad]: [1, 6, 90008] } : {}),
    };
    for (const [idf, perfiles] of Object.entries(seed)) {
      for (const idp of perfiles) {
        const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=? AND id_funcionalidad=? LIMIT 1', [idp, idf]);
        if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [idp, idf]);
      }
    }
    console.log('[dealernet-ws] repositorio de informes y card listos');
  } catch (e) { console.error('[dealernet-informes migration]', e.message); }
})();

/* ── Utilidades RUT ──────────────────────────────────────────────────────── */
function splitRut(rut) {
  const clean = String(rut || '').replace(/[.\s]/g, '').toUpperCase();
  const m = clean.match(/^(\d+)-?([0-9K])$/);
  if (m) return { num: m[1], dv: m[2] };
  const c = clean.replace(/-/g, '');
  return { num: c.slice(0, -1), dv: c.slice(-1) };
}
const escXml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ── Cliente SOAP ────────────────────────────────────────────────────────── */
function buildEnvelope({ usr, pwd, ruts, productos, tipocns }) {
  const rutsXml = ruts.map(r => `<rut num="${escXml(r.num)}" dv="${escXml(r.dv)}"/>`).join('');
  const prodsXml = productos.map(c => `<prod cod="${escXml(c)}"/>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="http://dealernet.cl/webservices/">
  <soapenv:Header/>
  <soapenv:Body>
    <web:CentralDeInformacion>
      <web:ctausr>${escXml(usr)}</web:ctausr>
      <web:ctapwd>${escXml(pwd)}</web:ctapwd>
      <web:input>
        <root>
          <tipocns>${escXml(tipocns)}</tipocns>
          <ruts>${rutsXml}</ruts>
          <prods>${prodsXml}</prods>
        </root>
      </web:input>
    </web:CentralDeInformacion>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function consultarCentral({ ruts, productos, tipocns = TIPOCNS_DEF }) {
  const usr = process.env.DEALERNET_USER, pwd = process.env.DEALERNET_PASS;
  if (!usr || !pwd) { const e = new Error('Credenciales DealerNet no configuradas (env DEALERNET_USER/DEALERNET_PASS)'); e.code = 'NOCREDS'; throw e; }
  const envelope = buildEnvelope({ usr, pwd, ruts, productos, tipocns });
  const resp = await axios.post(ENDPOINT, envelope, {
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': SOAP_ACTION },
    timeout: 30000, responseType: 'text', transformResponse: x => x,
  });
  const raw = String(resp.data || '');
  let retcode = null, retmsg = null, output = null, parsed = null;
  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: true });
    const obj = parser.parse(raw);
    const result = (obj && obj.Envelope && obj.Envelope.Body && obj.Envelope.Body.CentralDeInformacionResult) || {};
    retcode = result.retcode != null ? String(result.retcode) : null;
    retmsg = result.retmsg != null ? String(result.retmsg) : null;
    output = result.output != null ? result.output : null;
    parsed = result;
  } catch (pe) {
    const rc = raw.match(/<retcode>([\s\S]*?)<\/retcode>/i); if (rc) retcode = rc[1].trim();
    const rm = raw.match(/<retmsg>([\s\S]*?)<\/retmsg>/i); if (rm) retmsg = rm[1].trim();
    const op = raw.match(/<output>([\s\S]*?)<\/output>/i); if (op) output = op[1];
  }
  return { retcode, retmsg, output, parsed, raw };
}

/* ── REST: mantenedor de productos ───────────────────────────────────────── */
const getProductos = async (req, res) => {
  try { const [rows] = await pool.query('SELECT * FROM dealernet_productos ORDER BY orden, codigo'); res.json({ success: true, data: rows, error: null }); }
  catch (e) { errSrv(res, e, 'getProductos'); }
};
const addProducto = async (req, res) => {
  try {
    const codigo = String(req.body?.codigo || '').trim();
    const nombre = String(req.body?.nombre || '').trim();
    if (!codigo || !nombre) return res.status(400).json({ success: false, data: null, error: 'Código y nombre requeridos' });
    const [[dup]] = await pool.query('SELECT id FROM dealernet_productos WHERE codigo=?', [codigo]);
    if (dup) return res.status(409).json({ success: false, data: null, error: 'Ya existe ese código' });
    const [[{ mx }]] = await pool.query('SELECT COALESCE(MAX(orden),0)+1 mx FROM dealernet_productos');
    const [r] = await pool.query('INSERT INTO dealernet_productos (codigo, nombre, activo, orden) VALUES (?,?,1,?)', [codigo, nombre, mx]);
    auditar({ req, accion: 'CREAR', modulo: 'dealernet', entidad: 'producto', entidad_id: r.insertId, detalle: `Agregó producto DealerNet ${codigo} — ${nombre}` });
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { errSrv(res, e, 'addProducto'); }
};
const updateProducto = async (req, res) => {
  try {
    const { nombre, activo } = req.body || {};
    if (nombre !== undefined) await pool.query('UPDATE dealernet_productos SET nombre=? WHERE id=?', [String(nombre).trim(), req.params.id]);
    if (activo !== undefined) await pool.query('UPDATE dealernet_productos SET activo=? WHERE id=?', [activo ? 1 : 0, req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealernet', entidad: 'producto', entidad_id: req.params.id, detalle: `Editó producto DealerNet #${req.params.id}` });
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch (e) { errSrv(res, e, 'updateProducto'); }
};
const deleteProducto = async (req, res) => {
  try {
    await pool.query('DELETE FROM dealernet_productos WHERE id=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'dealernet', entidad: 'producto', entidad_id: req.params.id, detalle: `Eliminó producto DealerNet #${req.params.id}` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { errSrv(res, e, 'deleteProducto'); }
};
// Reordenar productos (drag&drop en el mantenedor): el orden rige la selección
// y el "Descargar todos" en Informes DealerNet.
const reordenarProductos = async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.orden) ? req.body.orden : null;
    if (!ids || !ids.length) return res.status(400).json({ success: false, data: null, error: 'Orden inválido' });
    let i = 1;
    for (const id of ids) await pool.query('UPDATE dealernet_productos SET orden=? WHERE id=?', [i++, id]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealernet', entidad: 'producto', detalle: `Reordenó productos DealerNet (${ids.length})` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { errSrv(res, e, 'reordenarProductos'); }
};

/* ── REST: consulta a la Central ─────────────────────────────────────────── */
const consultar = async (req, res) => {
  try {
    const rut = req.body?.rut;
    if (!rut) return res.status(400).json({ success: false, data: null, error: 'RUT requerido' });
    const { num, dv } = splitRut(rut);
    if (!num || !dv) return res.status(400).json({ success: false, data: null, error: 'RUT inválido' });

    // Productos: los indicados, o los activos del mantenedor.
    let productos = Array.isArray(req.body?.productos) ? req.body.productos.map(String) : null;
    if (!productos || !productos.length) {
      const [act] = await pool.query("SELECT codigo FROM dealernet_productos WHERE activo=1 ORDER BY orden");
      productos = act.map(r => r.codigo);
    }
    if (!productos.length) return res.status(400).json({ success: false, data: null, error: 'No hay productos activos para consultar' });

    let r;
    try {
      r = await consultarCentral({ ruts: [{ num, dv }], productos });
    } catch (e) {
      if (e.code === 'NOCREDS') return res.status(400).json({ success: false, data: null, error: e.message });
      console.error('[dealernet consultar]', e.message);
      return res.status(502).json({ success: false, data: null, error: 'No se pudo contactar a DealerNet: ' + e.message });
    }

    const [ins] = await pool.query(
      `INSERT INTO dealernet_consultas (rut, dv, productos, retcode, retmsg, output_raw, parsed, id_usuario)
       VALUES (?,?,?,?,?,?,?,?)`,
      [num, dv, productos.join(','), r.retcode, (r.retmsg || '').slice(0, 255), r.raw,
       r.parsed ? JSON.stringify(r.parsed) : null, req.usuario.id_usuario]);
    auditar({ req, accion: 'CONSULTAR', modulo: 'dealernet', entidad: 'consulta', entidad_id: ins.insertId,
      detalle: `Consultó DealerNet RUT ${num}-${dv} (productos ${productos.join(',')}) → retcode ${r.retcode}`, rut: `${num}-${dv}` });
    res.json({ success: true, data: { id: ins.insertId, retcode: r.retcode, retmsg: r.retmsg, output: r.output, productos }, error: null });
  } catch (e) { errSrv(res, e, 'consultar'); }
};

// ¿Están cargadas las credenciales? (no hace ninguna llamada ni gasta saldo)
const estado = async (req, res) => {
  res.json({ success: true, data: {
    configurado: !!(process.env.DEALERNET_USER && process.env.DEALERNET_PASS),
    endpoint: ENDPOINT, tipocns: TIPOCNS_DEF
  }, error: null });
};

const listConsultas = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, rut, dv, productos, retcode, retmsg, id_usuario, created_at FROM dealernet_consultas ORDER BY id DESC LIMIT 50');
    res.json({ success: true, data: rows, error: null });
  } catch (e) { errSrv(res, e, 'listConsultas'); }
};

/* ── Repositorio de informes: helpers ────────────────────────────────────── */
const toArr = x => (x == null ? [] : (Array.isArray(x) ? x : [x]));

async function getConfig() {
  try {
    const [rows] = await pool.query('SELECT clave, valor FROM dealernet_config');
    const m = {}; rows.forEach(r => m[r.clave] = r.valor);
    return { dias_bloqueo: Number(m.dias_bloqueo) || 15, dias_vigencia: Number(m.dias_vigencia) || 180 };
  } catch { return { dias_bloqueo: 15, dias_vigencia: 180 }; }
}

// Busca recursivamente el atributo urlpdf (boletín 2101 trae el PDF descargable).
function findUrlPdf(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 8) return null;
  for (const k of Object.keys(o)) {
    if ((k === '@_urlpdf' || k === 'urlpdf') && o[k]) return String(o[k]);
    if (o[k] && typeof o[k] === 'object') { const r = findUrlPdf(o[k], depth + 1); if (r) return r; }
  }
  return null;
}

// Parte el árbol de salida en un registro por producto. El XML real entrega
// output.rut.prd[] donde cada elemento trae su propio tag WS (no siempre @_cod);
// si no hay @_cod se mapea por orden de la lista pedida.
function splitProductos(parsed, productosPedidos) {
  const out = [];
  const output = parsed && parsed.output;
  if (!output) return out;
  const ruts = toArr(output.rut);
  const prdList = ruts.length ? toArr(ruts[0].prd) : [];
  prdList.forEach((prd, i) => {
    if (prd == null) return;
    const codigo = prd['@_cod'] != null ? String(prd['@_cod'])
      : (productosPedidos[i] != null ? String(productosPedidos[i]) : null);
    const tagKey = Object.keys(prd).filter(k => !k.startsWith('@_'))[0] || null;
    out.push({ codigo, ws_tag: tagKey, contenido: prd, pdf_url: findUrlPdf(prd) });
  });
  return out;
}

async function guardarInformes({ num, dv, productosPedidos, r, idConsulta, usuario }) {
  const [prods] = await pool.query('SELECT codigo, nombre FROM dealernet_productos');
  const nombreDe = c => (prods.find(p => String(p.codigo) === String(c)) || {}).nombre || null;
  const items = splitProductos(r.parsed, productosPedidos);
  // Si el split no reconoció la estructura, guardamos un registro por producto
  // pedido con el output completo (no se pierde data; se afina el display luego).
  const lista = items.length ? items
    : productosPedidos.map(c => ({ codigo: c, ws_tag: null, contenido: r.output ?? null, pdf_url: null }));
  const nombreUsr = ((usuario?.nombre || '') + ' ' + (usuario?.apellido || '')).trim() || null;
  const ids = [];
  for (const it of lista) {
    const [ins] = await pool.query(
      `INSERT INTO dealernet_informes (rut, dv, codigo_producto, nombre_producto, retcode, retmsg, ws_tag, contenido, pdf_url, id_consulta, id_usuario, usuario_nombre)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [num, dv, it.codigo, nombreDe(it.codigo), r.retcode, (r.retmsg || '').slice(0, 255), it.ws_tag,
       it.contenido != null ? JSON.stringify(it.contenido) : null, it.pdf_url, idConsulta,
       usuario?.id_usuario || null, nombreUsr]);
    ids.push({ id: ins.insertId, codigo: it.codigo });
  }
  return ids;
}

/* ── Repositorio de informes: endpoints ──────────────────────────────────── */
// Revisa el repositorio ANTES de gastar saldo: por producto devuelve el último
// informe y su estado (bloqueado <bloqueo, advertencia entre bloqueo y vigencia, libre).
const verificarRepositorio = async (req, res) => {
  try {
    const { num, dv } = splitRut(req.body?.rut || '');
    if (!num || !dv) return res.status(400).json({ success: false, data: null, error: 'RUT inválido' });
    let productos = Array.isArray(req.body?.productos) ? req.body.productos.map(String) : [];
    if (!productos.length) {
      const [act] = await pool.query("SELECT codigo FROM dealernet_productos WHERE activo=1 ORDER BY orden");
      productos = act.map(r => r.codigo);
    }
    const cfg = await getConfig();
    const [prods] = await pool.query('SELECT codigo, nombre FROM dealernet_productos');
    const nombreDe = c => (prods.find(p => String(p.codigo) === String(c)) || {}).nombre || c;
    const items = [];
    for (const cod of productos) {
      const [[ult]] = await pool.query(
        `SELECT id, created_at, DATEDIFF(NOW(), created_at) dias FROM dealernet_informes
         WHERE rut=? AND codigo_producto=? AND retcode='0' ORDER BY created_at DESC LIMIT 1`, [num, cod]);
      let estado = 'libre', ultimo = null;
      if (ult) {
        const dias = Number(ult.dias);
        ultimo = { id: ult.id, fecha: ult.created_at, dias };
        estado = dias < cfg.dias_bloqueo ? 'bloqueado' : (dias < cfg.dias_vigencia ? 'advertencia' : 'libre');
      }
      items.push({ codigo: cod, nombre: nombreDe(cod), estado, ultimo });
    }
    res.json({ success: true, data: { rut: `${num}-${dv}`, config: cfg, items }, error: null });
  } catch (e) { errSrv(res, e, 'verificarRepositorio'); }
};

// Solicita informes a DealerNet (gasta saldo). Enforce del bloqueo duro:
// los productos con copia < dias_bloqueo NO se vuelven a pedir.
const solicitarInformes = async (req, res) => {
  try {
    const { num, dv } = splitRut(req.body?.rut || '');
    if (!num || !dv) return res.status(400).json({ success: false, data: null, error: 'RUT inválido' });
    let productos = Array.isArray(req.body?.productos) ? req.body.productos.map(String) : [];
    if (!productos.length) {
      const [act] = await pool.query("SELECT codigo FROM dealernet_productos WHERE activo=1 ORDER BY orden");
      productos = act.map(r => r.codigo);
    }
    if (!productos.length) return res.status(400).json({ success: false, data: null, error: 'No hay productos activos para solicitar' });

    const cfg = await getConfig();
    const bloqueados = [], aPedir = [];
    for (const cod of productos) {
      const [[ult]] = await pool.query(
        `SELECT id, DATEDIFF(NOW(), created_at) dias FROM dealernet_informes
         WHERE rut=? AND codigo_producto=? AND retcode='0' ORDER BY created_at DESC LIMIT 1`, [num, cod]);
      if (ult && Number(ult.dias) < cfg.dias_bloqueo) bloqueados.push({ codigo: cod, dias: Number(ult.dias), id_informe: ult.id });
      else aPedir.push(cod);
    }
    if (!aPedir.length)
      return res.json({ success: true, data: { rut: `${num}-${dv}`, pedidos: [], bloqueados, guardados: [],
        mensaje: 'Todos los productos solicitados ya tienen copia vigente en el repositorio.' }, error: null });

    let r;
    try { r = await consultarCentral({ ruts: [{ num, dv }], productos: aPedir }); }
    catch (e) {
      if (e.code === 'NOCREDS') return res.status(400).json({ success: false, data: null, error: e.message });
      console.error('[dealernet solicitar]', e.message);
      return res.status(502).json({ success: false, data: null, error: 'No se pudo contactar a DealerNet: ' + e.message });
    }

    const [ins] = await pool.query(
      `INSERT INTO dealernet_consultas (rut, dv, productos, retcode, retmsg, output_raw, parsed, id_usuario)
       VALUES (?,?,?,?,?,?,?,?)`,
      [num, dv, aPedir.join(','), r.retcode, (r.retmsg || '').slice(0, 255), r.raw,
       r.parsed ? JSON.stringify(r.parsed) : null, req.usuario.id_usuario]);
    const guardados = String(r.retcode) === '0'
      ? await guardarInformes({ num, dv, productosPedidos: aPedir, r, idConsulta: ins.insertId, usuario: req.usuario })
      : [];
    auditar({ req, accion: 'CONSULTAR', modulo: 'dealernet', entidad: 'informe', entidad_id: ins.insertId,
      detalle: `Solicitó informes DealerNet RUT ${num}-${dv} (productos ${aPedir.join(',')}) → retcode ${r.retcode}`, rut: `${num}-${dv}` });
    res.json({ success: true, data: { rut: `${num}-${dv}`, retcode: r.retcode, retmsg: r.retmsg, pedidos: aPedir, bloqueados, guardados }, error: null });
  } catch (e) { errSrv(res, e, 'solicitarInformes'); }
};

// Histórico del repositorio (todos los usuarios ven lo mismo). Filtra por RUT opcional.
// Productos activos para poblar la selección (gratis, permiso de la página).
const productosActivos = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT codigo, nombre FROM dealernet_productos WHERE activo=1 ORDER BY orden");
    res.json({ success: true, data: rows, error: null });
  } catch (e) { errSrv(res, e, 'productosActivos'); }
};

const historicos = async (req, res) => {
  try {
    let where = "WHERE retcode='0'", params = [];
    if (req.query.rut) { const { num } = splitRut(req.query.rut); if (num) { where += ' AND rut=?'; params.push(num); } }
    const [rows] = await pool.query(
      `SELECT id, rut, dv, codigo_producto, nombre_producto, retcode, retmsg,
        (pdf_url IS NOT NULL AND pdf_url<>'') AS tiene_pdf, id_usuario, usuario_nombre, created_at,
        DATEDIFF(NOW(), created_at) AS dias
       FROM dealernet_informes ${where} ORDER BY created_at DESC LIMIT 200`, params);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { errSrv(res, e, 'historicos'); }
};

const verInforme = async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT * FROM dealernet_informes WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ success: false, data: null, error: 'Informe no encontrado' });
    res.json({ success: true, data: row, error: null });
  } catch (e) { errSrv(res, e, 'verInforme'); }
};

// Descarga el PDF del informe (boletín 2101): se trae server-side y se sirve.
const descargarPdf = async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT pdf_url, codigo_producto, rut FROM dealernet_informes WHERE id=?', [req.params.id]);
    if (!row || !row.pdf_url) return res.status(404).json({ success: false, data: null, error: 'Este informe no tiene PDF asociado' });
    const resp = await axios.get(row.pdf_url, { responseType: 'arraybuffer', timeout: 30000 });
    res.setHeader('Content-Type', resp.headers['content-type'] || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="informe_${row.codigo_producto}_${row.rut}.pdf"`);
    res.send(Buffer.from(resp.data));
  } catch (e) { errSrv(res, e, 'descargarPdf'); }
};

/* ── Config paramétrica (umbrales) para el mantenedor ────────────────────── */
const getConfigEndpoint = async (req, res) => {
  try { res.json({ success: true, data: await getConfig(), error: null }); }
  catch (e) { errSrv(res, e, 'getConfigEndpoint'); }
};
const updateConfigEndpoint = async (req, res) => {
  try {
    const b = parseInt(req.body?.dias_bloqueo, 10), v = parseInt(req.body?.dias_vigencia, 10);
    if (!(b > 0) || !(v > 0) || v <= b)
      return res.status(400).json({ success: false, data: null, error: 'Días inválidos (vigencia debe ser mayor que bloqueo, ambos > 0)' });
    await pool.query("UPDATE dealernet_config SET valor=? WHERE clave='dias_bloqueo'", [String(b)]);
    await pool.query("UPDATE dealernet_config SET valor=? WHERE clave='dias_vigencia'", [String(v)]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealernet', entidad: 'config', detalle: `Umbrales informes: bloqueo ${b}d, vigencia ${v}d` });
    res.json({ success: true, data: { dias_bloqueo: b, dias_vigencia: v }, error: null });
  } catch (e) { errSrv(res, e, 'updateConfigEndpoint'); }
};

module.exports = { getProductos, addProducto, updateProducto, deleteProducto, reordenarProductos, consultar, listConsultas, estado,
  verificarRepositorio, solicitarInformes, productosActivos, historicos, verInforme, descargarPdf, getConfigEndpoint, updateConfigEndpoint };
