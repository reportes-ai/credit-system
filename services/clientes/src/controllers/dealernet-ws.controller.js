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

module.exports = { getProductos, addProducto, updateProducto, deleteProducto, consultar, listConsultas, estado };
