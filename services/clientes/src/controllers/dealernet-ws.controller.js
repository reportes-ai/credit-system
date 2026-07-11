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
const { enviarCorreo, envolverHTML, mailConfigurado } = require('../../../../shared/mailer');

// Cuerpo numérico del RUT (sin puntos, sin guión, sin dígito verificador) para comparar
// con dealernet_informes.rut (que se guarda solo con el número).
function rutNum(r) {
  const clean = String(r || '').replace(/[.\s]/g, '').toUpperCase();
  const m = clean.match(/^(\d+)-?[0-9K]$/);
  if (m) return m[1];
  // Sin formato de RUT válido: si quedan letras es un placeholder (ej. 'EXEJ-123'
  // de ex-ejecutivos migrados), no un RUT real → descartar para no generar falsos
  // positivos en la clasificación/auditoría de uso.
  if (/[A-Z]/.test(clean)) return '';
  const d = clean.replace(/[^0-9]/g, '');
  return d.length > 1 ? d.slice(0, -1) : d;
}

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

require('../../../../shared/migrate').enFila('dealernet-ws', async () => {
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
});

/* ── Migración: repositorio de informes compartido + config + módulo card ──── */
require('../../../../shared/migrate').enFila('dealernet-ws', async () => {
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
      ['Reporte IA (DealerNet)', 'dealernet_reporte_ia', null, 'bi-stars'],   // muestra el botón "Reporte IA"
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
      [idFunc['dealernet_reporte_ia']]: [1],   // por defecto solo Admin; se abre desde la matriz de Perfiles
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
});

/* ── Migración: auditoría de uso + aviso a supervisor/RRHH ────────────────── */
require('../../../../shared/migrate').enFila('dealernet-ws', async () => {
  try {
    // Bitácora de avisos enviados cuando alguien consulta su propio RUT o el de un colega
    await pool.query(`CREATE TABLE IF NOT EXISTS dealernet_avisos_uso (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      id_usuario      INT NULL,
      usuario_nombre  VARCHAR(160),
      rut_consultado  VARCHAR(14),
      motivo          VARCHAR(40),                 -- 'propio' | 'empresa'
      detalle         VARCHAR(255),
      destinatarios   VARCHAR(400),
      enviado         TINYINT(1) DEFAULT 0,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_av_usr (id_usuario, created_at)
    )`);
    // Correo de RRHH (paramétrico). También se detectan usuarios con perfil "Recursos Humanos".
    await pool.query("INSERT IGNORE INTO dealernet_config (clave, valor) VALUES ('rrhh_email','')");
    // Funcionalidad para ver la auditoría (módulo Informes DealerNet 380001)
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='dealernet_auditoria' LIMIT 1");
    let idf = ex && ex.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query("INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (380001,'Auditoría de Uso','dealernet_auditoria',NULL,'bi-graph-up')");
      idf = r.insertId;
    }
    const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
    if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    console.log('[dealernet-ws] auditoría de uso lista');
  } catch (e) { console.error('[dealernet-auditoria migration]', e.message); }
});

/* ── Migración: costos en UF + facturación prepago ───────────────────────── */
// Precio unitario en UF por informe, por tramo de plan [10, 20, 40, 80] UF mín. mensual.
const PLANES_UF = [10, 20, 40, 80];
const COLS_UF = { 10: 'precio_uf_10', 20: 'precio_uf_20', 40: 'precio_uf_40', 80: 'precio_uf_80' };
const PRECIO_UF4 = {
  '3435':[0.0132,0.0098,0.0085,0.0073], '3407':[0.0070,0.0064,0.0054,0.0045], '3409':[0.0026,0.0024,0.0020,0.0018],
  '3410':[0.0032,0.0030,0.0025,0.0023], '3411':[0.0020,0.0015,0.0015,0.0014], '3414':[0.0122,0.0111,0.0080,0.0065],
  '3443':[0.0084,0.0076,0.0065,0.0053], '3412':[0.0079,0.0072,0.0061,0.0050], '3404':[0.0050,0.0042,0.0035,0.0030],
  '3429':[0.0065,0.0060,0.0051,0.0043], '3425':[0.0060,0.0055,0.0047,0.0038], '3426':[0.0040,0.0038,0.0031,0.0029],
  '3427':[0.0050,0.0042,0.0035,0.0030], '3428':[0.0032,0.0030,0.0025,0.0023], '3439':[0.0050,0.0042,0.0035,0.0030],
  '3430':[0.0075,0.0068,0.0058,0.0048], '3423':[0.0026,0.0024,0.0020,0.0018], '3421':[0.0026,0.0024,0.0020,0.0018],
  '3401':[0.0075,0.0068,0.0058,0.0048], '3402':[0.0062,0.0056,0.0048,0.0039], '3403':[0.0070,0.0064,0.0054,0.0045],
  '3420':[0.0075,0.0068,0.0058,0.0048], '3419':[0.0075,0.0068,0.0058,0.0048], '3431':[0.0038,0.0034,0.0029,0.0024],
  '3434':[0.0038,0.0034,0.0029,0.0024], '3432':[0.0031,0.0028,0.0024,0.0020], '3433':[0.0035,0.0032,0.0027,0.0023],
};
require('../../../../shared/migrate').enFila('dealernet-ws', async () => {
  try {
    for (const c of ['precio_uf', ...Object.values(COLS_UF)]) {
      try { await pool.query(`ALTER TABLE dealernet_productos ADD COLUMN ${c} DECIMAL(8,4) NOT NULL DEFAULT 0`); }
      catch (e) { if (e.errno !== 1060) throw e; }
    }
    // Sembrar los 4 tramos sólo donde aún están en 0 (no piso ediciones del admin)
    for (const [cod, p] of Object.entries(PRECIO_UF4)) {
      await pool.query(
        `UPDATE dealernet_productos SET
           precio_uf_10 = IF(precio_uf_10=0, ?, precio_uf_10),
           precio_uf_20 = IF(precio_uf_20=0, ?, precio_uf_20),
           precio_uf_40 = IF(precio_uf_40=0, ?, precio_uf_40),
           precio_uf_80 = IF(precio_uf_80=0, ?, precio_uf_80)
         WHERE codigo=?`, [p[0], p[1], p[2], p[3], cod]);
    }
    // Plan prepago contratado (UF/mes)
    await pool.query("INSERT IGNORE INTO dealernet_config (clave, valor) VALUES ('plan_uf','40')");
    // Facturación mensual: consumo calculado vs monto real facturado
    await pool.query(`CREATE TABLE IF NOT EXISTS dealernet_facturacion (
      mes               CHAR(7) PRIMARY KEY,        -- 'YYYY-MM'
      consumo_uf        DECIMAL(12,4) DEFAULT 0,
      uf_valor          DECIMAL(12,2) DEFAULT 0,    -- UF del último día del mes
      consumo_clp       DECIMAL(14,2) DEFAULT 0,
      plan_uf           DECIMAL(8,2)  DEFAULT 0,
      facturado_real_clp DECIMAL(14,2) NULL,
      recomendacion     VARCHAR(20),
      plan_recomendado_uf DECIMAL(8,2) NULL,
      detalle           JSON NULL,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    // Funcionalidades: mantenedor de costos + card-grupo "Mantenedor DealerNet" + pestaña Facturación
    const [[modM]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo' LIMIT 1");
    if (modM) {
      for (const f of [
        { nombre: 'Costo DealerNet',      codigo: 'mant_dealernet_costos', href: '/mantenedores/dealernet-costos/', icono: 'bi-cash-coin' },
        { nombre: 'Mantenedor DealerNet', codigo: 'mant_dealernet',         href: '/mantenedores/dealernet/',        icono: 'bi-cloud-arrow-down' },
      ]) {
        const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [f.codigo]);
        let idf = ex && ex.id_funcionalidad;
        if (!idf) { const [r] = await pool.query("INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)",
          [modM.id_modulo, f.nombre, f.codigo, f.href, f.icono]); idf = r.insertId; }
        const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
        if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
      }
      // Quien ya tenía acceso a Productos o Costo DealerNet, también ve el card-grupo (sin regresión)
      const [[grp]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='mant_dealernet' LIMIT 1");
      if (grp) await pool.query(
        `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
         SELECT DISTINCT pp.id_perfil, ?, 1 FROM permisos_perfil pp
         JOIN funcionalidades f ON f.id_funcionalidad=pp.id_funcionalidad
         WHERE f.codigo IN ('mant_dealernet_productos','mant_dealernet_costos') AND pp.habilitado=1`, [grp.id_funcionalidad]);
    }
    const [[exF]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='dealernet_facturacion' LIMIT 1");
    let idF = exF && exF.id_funcionalidad;
    if (!idF) { const [r] = await pool.query("INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (380001,'Facturación',?,NULL,'bi-receipt')", ['dealernet_facturacion']); idF = r.insertId; }
    const [[ppF]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idF]);
    if (!ppF) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idF]);
    console.log('[dealernet-ws] costos y facturación listos');
  } catch (e) { console.error('[dealernet-costos migration]', e.message); }
});

/* ── Migración: set de informes para la Ficha de Dealer (empresa / socio) ────
   Flags paramétricos por producto: qué informes pide/valida la ficha de dealer
   para la EMPRESA y para cada SOCIO. La empresa NO lleva Deudores de Alimentos
   (2101); los socios sí. El Administrador ajusta los sets en el mantenedor de
   Productos DealerNet. Seed conservador (incluye un penal para la alerta grave). */
require('../../../../shared/migrate').enFila('dealernet-ws', async () => {
  try {
    for (const c of ['ficha_empresa', 'ficha_socio']) {
      try { await pool.query(`ALTER TABLE dealernet_productos ADD COLUMN ${c} TINYINT(1) NOT NULL DEFAULT 0`); }
      catch (e) { if (e.errno !== 1060) throw e; }
    }
    // Sembrar el default sólo una vez (flag), para no pisar lo que configure el admin.
    const [[ya]] = await pool.query("SELECT 1 ok FROM migraciones_aplicadas WHERE clave='dealernet_ficha_sets_v1' LIMIT 1").catch(() => [[null]]);
    if (!ya) {
      await pool.query(`CREATE TABLE IF NOT EXISTS migraciones_aplicadas (
        clave VARCHAR(80) PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      const EMPRESA = ['3435', '3425', '16', '3439'];          // Perfil Comercial, Impagos, Comportamiento, Boletín Procesos Penales
      const SOCIO   = ['3435', '3425', '16', '3439', '2101'];  // + Deudores de Pensión de Alimentos
      await pool.query('UPDATE dealernet_productos SET ficha_empresa=1 WHERE codigo IN (?)', [EMPRESA]);
      await pool.query('UPDATE dealernet_productos SET ficha_socio=1   WHERE codigo IN (?)', [SOCIO]);
      await pool.query("INSERT IGNORE INTO migraciones_aplicadas (clave) VALUES ('dealernet_ficha_sets_v1')");
    }
    console.log('[dealernet-ws] sets de informes para ficha de dealer listos');
  } catch (e) { console.error('[dealernet-ficha-sets migration]', e.message); }
});

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
  let resp;
  try {
    resp = await axios.post(ENDPOINT, envelope, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': SOAP_ACTION },
      timeout: 30000, responseType: 'text', transformResponse: x => x,
    });
  } catch (e) {
    // Error legible para el usuario: timeout, HTTP o SOAP fault (sin filtrar internals)
    if (e.code === 'ECONNABORTED') throw new Error('DealerNet no respondió dentro de 30 segundos (timeout)');
    if (e.response) {
      const fault = String(e.response.data || '').match(/<faultstring>([\s\S]*?)<\/faultstring>/i);
      throw new Error(`DealerNet respondió HTTP ${e.response.status}${fault ? ': ' + fault[1].trim().slice(0, 200) : ''}`);
    }
    throw new Error('Sin conexión con DealerNet: ' + e.message);
  }
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

// Sets de informes que pide/valida la Ficha de Dealer: empresa (sin Alimentos) y socio.
const fichaInformes = async (req, res) => {
  try {
    const [emp] = await pool.query('SELECT codigo, nombre FROM dealernet_productos WHERE ficha_empresa=1 ORDER BY orden, codigo');
    const [soc] = await pool.query('SELECT codigo, nombre FROM dealernet_productos WHERE ficha_socio=1 ORDER BY orden, codigo');
    res.json({ success: true, data: { empresa: emp, socio: soc }, error: null });
  } catch (e) { errSrv(res, e, 'fichaInformes'); }
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
    const { nombre, activo, ficha_empresa, ficha_socio } = req.body || {};
    if (nombre !== undefined) await pool.query('UPDATE dealernet_productos SET nombre=? WHERE id=?', [String(nombre).trim(), req.params.id]);
    if (activo !== undefined) await pool.query('UPDATE dealernet_productos SET activo=? WHERE id=?', [activo ? 1 : 0, req.params.id]);
    if (ficha_empresa !== undefined) await pool.query('UPDATE dealernet_productos SET ficha_empresa=? WHERE id=?', [ficha_empresa ? 1 : 0, req.params.id]);
    if (ficha_socio   !== undefined) await pool.query('UPDATE dealernet_productos SET ficha_socio=?   WHERE id=?', [ficha_socio ? 1 : 0, req.params.id]);
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

/* ── Auditoría de uso: clasificación de RUT + aviso a supervisor/RRHH ──────── */
// ¿El RUT consultado es el propio del usuario o el de otro usuario de la empresa?
async function clasificarRutParaUsuario(usuario, rut) {
  const num = rutNum(rut);
  const out = { esPropio: false, esUsuarioEmpresa: false, usuarioEmpresa: null };
  if (!num || !usuario) return out;
  const [[me]] = await pool.query('SELECT rut FROM usuarios WHERE id_usuario=?', [usuario.id_usuario]);
  if (me && rutNum(me.rut) === num) { out.esPropio = true; return out; }
  const [users] = await pool.query("SELECT id_usuario, nombre, apellido, rut FROM usuarios WHERE rut IS NOT NULL AND rut<>''");
  const match = users.find(u => rutNum(u.rut) === num);
  if (match) { out.esUsuarioEmpresa = true; out.usuarioEmpresa = { id_usuario: match.id_usuario, nombre: `${match.nombre} ${match.apellido || ''}`.trim() }; }
  return out;
}

// Destinatarios RRHH: config rrhh_email (coma/; ) + usuarios con perfil "Recursos Humanos"/"RRHH".
async function destinatariosRRHH() {
  const set = new Set();
  try {
    const [[c]] = await pool.query("SELECT valor FROM dealernet_config WHERE clave='rrhh_email'");
    (c?.valor || '').split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(s => s.includes('@')).forEach(e => set.add(e));
  } catch (_) {}
  try {
    const [rows] = await pool.query(`SELECT u.email FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
      WHERE u.estado='activo' AND u.email IS NOT NULL AND u.email<>''
        AND (LOWER(p.nombre) LIKE '%recursos humanos%' OR LOWER(p.nombre) LIKE '%rrhh%')`);
    rows.forEach(r => set.add(String(r.email).toLowerCase()));
  } catch (_) {}
  return [...set];
}

// Envía el "Aviso de uso de DealerNet" al supervisor + RRHH y lo registra en la bitácora.
async function notificarUsoDealernet({ usuario, rutConsultado, motivo, usuarioEmpresa, productos }) {
  let supEmail = null, solicitante = null;
  try {
    const [[row]] = await pool.query(
      `SELECT u.nombre, u.apellido, u.email, s.email sup_email
       FROM usuarios u LEFT JOIN usuarios s ON s.id_usuario=u.id_supervisor WHERE u.id_usuario=?`, [usuario.id_usuario]);
    if (row) { solicitante = row; supEmail = row.sup_email; }
  } catch (_) {}
  const rrhh = await destinatariosRRHH();
  const to = [...new Set([supEmail, ...rrhh].filter(Boolean))];
  const nombreSol = solicitante ? `${solicitante.nombre} ${solicitante.apellido || ''}`.trim() : (usuario.nombre || '');
  const detalle = motivo === 'propio'
    ? `consultó su propio RUT (${rutConsultado})`
    : `consultó el RUT de ${usuarioEmpresa?.nombre || 'un usuario de la empresa'} (${rutConsultado})`;

  let enviado = false;
  if (to.length && mailConfigurado()) {
    const cuerpo = `
      <p style="margin:0 0 14px">Estimado/a,</p>
      <p style="margin:0 0 14px">Se registró un uso de la herramienta <b>DealerNet</b> (informes comerciales pagados) que requiere su atención:</p>
      <table role="presentation" width="100%" style="border-collapse:collapse;background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px">
        <tr><td style="padding:12px 16px;line-height:1.75;font-size:14px">
          <b>Usuario:</b> ${nombreSol}<br>
          <b>Acción:</b> ${detalle}<br>
          <b>Informes solicitados:</b> ${(productos || []).join(', ') || '—'}<br>
          <b>Fecha:</b> ${new Date().toLocaleString('es-CL')}
        </td></tr>
      </table>
      <p style="margin:16px 0 0">DealerNet es una herramienta pagada de AutoFácil SpA destinada al análisis de negocios. Este aviso se genera de forma automática cuando un usuario consulta su propio RUT o el de otro funcionario de la empresa.</p>`;
    const r = await enviarCorreo({
      to: to.join(','), subject: `Aviso de uso de DealerNet — ${nombreSol}`, html: envolverHTML(cuerpo),
      text: `Aviso de uso de DealerNet.\n\nUsuario: ${nombreSol}\nAcción: ${detalle}\nInformes: ${(productos || []).join(', ')}\nFecha: ${new Date().toLocaleString('es-CL')}`
    });
    enviado = !!r.ok;
  }
  try {
    await pool.query(
      `INSERT INTO dealernet_avisos_uso (id_usuario, usuario_nombre, rut_consultado, motivo, detalle, destinatarios, enviado)
       VALUES (?,?,?,?,?,?,?)`,
      [usuario.id_usuario, nombreSol, rutConsultado, motivo, detalle, to.join(','), enviado ? 1 : 0]);
  } catch (_) {}
  return { enviado, destinatarios: to };
}

// El frontend lo usa para mostrar el pop-up ANTES de solicitar.
const clasificarRut = async (req, res) => {
  try {
    if (!req.body?.rut) return res.status(400).json({ success: false, data: null, error: 'RUT requerido' });
    res.json({ success: true, data: await clasificarRutParaUsuario(req.usuario, req.body.rut), error: null });
  } catch (e) { errSrv(res, e, 'clasificarRut'); }
};

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

    // Aviso automático: si consultó su propio RUT o el de otro usuario de la empresa,
    // se notifica al supervisor + RRHH (no bloquea la respuesta).
    let aviso = null;
    try {
      const cls = await clasificarRutParaUsuario(req.usuario, `${num}-${dv}`);
      if (cls.esPropio || cls.esUsuarioEmpresa) {
        const n = await notificarUsoDealernet({ usuario: req.usuario, rutConsultado: `${num}-${dv}`,
          motivo: cls.esPropio ? 'propio' : 'empresa', usuarioEmpresa: cls.usuarioEmpresa, productos: aPedir });
        aviso = { motivo: cls.esPropio ? 'propio' : 'empresa', ...n };
      }
    } catch (e) { console.error('[dealernet aviso]', e.message); }

    res.json({ success: true, data: { rut: `${num}-${dv}`, retcode: r.retcode, retmsg: r.retmsg, pedidos: aPedir, bloqueados, guardados, aviso }, error: null });
  } catch (e) { errSrv(res, e, 'solicitarInformes'); }
};

/* ── Reutilizable: asegura informes vigentes para un RUT (repo + pull) ────────
   Usado por la Ficha de Dealer al enviar a autorización. Por producto: si hay
   copia ≤ dias_bloqueo la reutiliza; si falta o está vencida la pide a DealerNet
   (gasta saldo) y la guarda. Degrada sin romper si no hay credenciales/contacto. */
const PENAL_CODIGOS = ['3403', '3433', '3439'];   // Comportamiento Penal, Índice Judicial Penal, Boletín de Procesos Penales

// Análisis best-effort del contenido (se afina con la respuesta real del WS).
// Penal con registros → alerta grave. Devuelve {tieneRegistros, grave, nota}.
function analizarInforme(codigo, contenido) {
  const esPenal = PENAL_CODIGOS.includes(String(codigo));
  if (contenido == null) return { tieneRegistros: false, grave: false, severidad: 'sin_datos', nota: 'sin datos' };

  // Los informes DealerNet son DATOS ESTRUCTURADOS (campos @_...): se clasifica por los MONTOS
  // e INDICADORES reales, no buscando palabras sueltas — antes "sin deuda" o una deuda vigente
  // (normal, al día) marcaban "malo" por contener la palabra "deuda". Ahora solo penaliza lo que
  // de verdad es negativo: mora / vencida / castigada / protestos / impagos > 0, o el indicador
  // textual del boletín dice explícitamente "con deuda / moroso / vencida".
  const flat = [];
  (function walk(o) { if (o && typeof o === 'object') for (const k in o) { const v = o[k]; if (v && typeof v === 'object') walk(v); else flat.push([String(k).toLowerCase(), v]); } })(contenido);
  const numD = v => { const n = parseFloat(String(v == null ? '' : v)); return isFinite(n) ? n : 0; };

  let montoNeg = 0, cantAnot = 0, indNeg = false, indLimpio = false;
  const gatillos = [];   // qué campo/valor causó la severidad, para explicarla en pantalla
  for (const [k, v] of flat) {
    // Montos negativos por nombre de campo (deuda vencida / castigada / morosa / mora_xx / impaga / protesto).
    if (/(vencid|castig|moros|mora_?\d|impag|protest)/.test(k)) { const n = numD(v); montoNeg += n; if (n > 0) gatillos.push(k.replace(/^@_/, '') + ' = ' + n); }
    // Conteo explícito de anotaciones/protestos/registros negativos.
    if (/(cant.*(anot|protest|moros)|nro_?(anot|protest)|num_?(anot|protest)|total_?(anot|protest))/.test(k) && numD(v) > 0) { cantAnot += numD(v); gatillos.push(numD(v) + ' anotación(es) en ' + k.replace(/^@_/, '')); }
    // Indicador textual del boletín (ej. inddeu: "Sin deuda" | "Con deuda").
    if (/inddeu|indicador|estado|glosa|situacion/.test(k)) {
      const vl = String(v).toLowerCase();
      if (/sin deuda|no registra|sin registro|sin anotac|sin observ|al d[ií]a/.test(vl)) indLimpio = true;
      else if (/con deuda|moros|vencid|castig|impag|protest/.test(vl)) { indNeg = true; gatillos.push(k.replace(/^@_/, '') + ': "' + String(v) + '"'); }
    }
  }

  const negativo = montoNeg > 0 || cantAnot > 0 || indNeg;
  const tieneRegistros = negativo;                 // solo lo NEGATIVO penaliza (deuda vigente/al día = sano)
  const grave = esPenal && negativo;
  const severidad = grave ? 'grave' : (negativo ? 'malo' : 'bueno');
  const detalle = gatillos.slice(0, 4).join('; ');
  const nota = grave ? 'registros penales/judiciales' + (detalle ? ': ' + detalle : '')
    : (negativo ? 'con observaciones: ' + (detalle || 'mora/vencida/castigada/protestos')
    : (indLimpio ? 'sin deuda / al día' : 'sin observaciones negativas'));
  return { tieneRegistros, grave, severidad, nota };
}

async function asegurarInformes({ rut, productos, usuario }) {
  const { num, dv } = splitRut(rut || '');
  const out = { rut: (num && dv) ? `${num}-${dv}` : String(rut || ''), items: [], pedidos: [], faltaban: [], consultado: false, error: null };
  if (!num || !dv) { out.error = 'RUT inválido'; return out; }
  productos = (productos || []).map(String);
  if (!productos.length) return out;
  const cfg = await getConfig();
  const [prods] = await pool.query('SELECT codigo, nombre FROM dealernet_productos');
  const nombreDe = c => (prods.find(p => String(p.codigo) === String(c)) || {}).nombre || c;
  const ultimoDe = async (cod) => {
    const [[u]] = await pool.query(
      `SELECT id, contenido, DATEDIFF(NOW(), created_at) dias, created_at FROM dealernet_informes
       WHERE rut=? AND codigo_producto=? AND retcode='0' ORDER BY created_at DESC LIMIT 1`, [num, cod]);
    return u || null;
  };

  const vigentes = {}, aPedir = [];
  for (const cod of productos) {
    const u = await ultimoDe(cod);
    if (u && Number(u.dias) <= cfg.dias_bloqueo) vigentes[cod] = u;
    else { aPedir.push(cod); out.faltaban.push(cod); }
  }

  if (aPedir.length) {
    try {
      const r = await consultarCentral({ ruts: [{ num, dv }], productos: aPedir });
      out.consultado = true;
      const [ins] = await pool.query(
        `INSERT INTO dealernet_consultas (rut, dv, productos, retcode, retmsg, output_raw, parsed, id_usuario)
         VALUES (?,?,?,?,?,?,?,?)`,
        [num, dv, aPedir.join(','), r.retcode, (r.retmsg || '').slice(0, 255), r.raw, r.parsed ? JSON.stringify(r.parsed) : null, usuario?.id_usuario || null]);
      if (String(r.retcode) === '0') {
        await guardarInformes({ num, dv, productosPedidos: aPedir, r, idConsulta: ins.insertId, usuario });
        out.pedidos = aPedir;
        for (const cod of aPedir) { const u = await ultimoDe(cod); if (u) vigentes[cod] = u; }
      } else out.error = r.retmsg || ('DealerNet retcode ' + r.retcode);
    } catch (e) {
      out.error = e.code === 'NOCREDS' ? 'Credenciales DealerNet no configuradas' : ('No se pudo consultar DealerNet: ' + e.message);
    }
  }

  for (const cod of productos) {
    const u = vigentes[cod];
    let contenido = null;
    if (u && u.contenido) { try { contenido = typeof u.contenido === 'string' ? JSON.parse(u.contenido) : u.contenido; } catch { contenido = u.contenido; } }
    const a = analizarInforme(cod, contenido);
    out.items.push({ codigo: cod, nombre: nombreDe(cod), disponible: !!u, fecha: u ? u.created_at : null,
      dias: u ? Number(u.dias) : null, vencido: u ? Number(u.dias) > cfg.dias_bloqueo : false,
      tiene_registros: a.tieneRegistros, grave: a.grave, severidad: a.severidad, nota: a.nota });
  }
  return out;
}

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
async function leerRRHHEmail() {
  try { const [[c]] = await pool.query("SELECT valor FROM dealernet_config WHERE clave='rrhh_email'"); return c?.valor || ''; }
  catch { return ''; }
}
const getConfigEndpoint = async (req, res) => {
  try { res.json({ success: true, data: { ...(await getConfig()), rrhh_email: await leerRRHHEmail() }, error: null }); }
  catch (e) { errSrv(res, e, 'getConfigEndpoint'); }
};
const updateConfigEndpoint = async (req, res) => {
  try {
    if (req.body?.dias_bloqueo !== undefined || req.body?.dias_vigencia !== undefined) {
      const b = parseInt(req.body?.dias_bloqueo, 10), v = parseInt(req.body?.dias_vigencia, 10);
      if (!(b > 0) || !(v > 0) || v <= b)
        return res.status(400).json({ success: false, data: null, error: 'Días inválidos (vigencia debe ser mayor que bloqueo, ambos > 0)' });
      await pool.query("UPDATE dealernet_config SET valor=? WHERE clave='dias_bloqueo'", [String(b)]);
      await pool.query("UPDATE dealernet_config SET valor=? WHERE clave='dias_vigencia'", [String(v)]);
    }
    if (req.body?.rrhh_email !== undefined) {
      await pool.query("INSERT INTO dealernet_config (clave, valor) VALUES ('rrhh_email', ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)",
        [String(req.body.rrhh_email || '').trim()]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'dealernet', entidad: 'config', detalle: 'Actualizó configuración DealerNet (umbrales / RRHH)' });
    res.json({ success: true, data: { ...(await getConfig()), rrhh_email: await leerRRHHEmail() }, error: null });
  } catch (e) { errSrv(res, e, 'updateConfigEndpoint'); }
};

/* ── Auditoría de uso (promedios por día por tipo + auto/empresa) ──────────── */
const auditoria = async (req, res) => {
  try {
    const dias = Math.min(365, Math.max(1, parseInt(req.query.dias) || 30));
    // SOLO llamadas reales a DealerNet (gastan saldo): se cuenta sobre dealernet_consultas,
    // NO sobre dealernet_informes (que es el repositorio). La reutilización del repositorio
    // nunca inserta en dealernet_consultas, por lo que no infla la auditoría.
    const [prods] = await pool.query('SELECT codigo, nombre FROM dealernet_productos');
    const nombreProd = c => (prods.find(p => String(p.codigo) === String(c)) || {}).nombre || c;
    const [cons] = await pool.query(
      `SELECT c.id_usuario, c.productos, TRIM(CONCAT(u.nombre,' ',COALESCE(u.apellido,''))) usuario_nombre
       FROM dealernet_consultas c LEFT JOIN usuarios u ON u.id_usuario = c.id_usuario
       WHERE c.retcode='0' AND c.created_at >= NOW() - INTERVAL ? DAY`, [dias]);
    const usuarios = {};
    for (const r of cons) {
      const k = r.id_usuario != null ? 'u' + r.id_usuario : 'n' + (r.usuario_nombre || '');
      if (!usuarios[k]) usuarios[k] = { id_usuario: r.id_usuario, usuario: r.usuario_nombre || '—', total: 0, _porTipo: {} };
      const codigos = String(r.productos || '').split(',').map(s => s.trim()).filter(Boolean);
      for (const cod of codigos) {
        usuarios[k]._porTipo[cod] = (usuarios[k]._porTipo[cod] || 0) + 1;
        usuarios[k].total += 1;
      }
    }
    const porUsuario = Object.values(usuarios)
      .map(u => ({ id_usuario: u.id_usuario, usuario: u.usuario, total: u.total,
        promedio_dia: +(u.total / dias).toFixed(2),
        porTipo: Object.entries(u._porTipo).map(([codigo, n]) => ({ codigo, nombre: nombreProd(codigo), n })) }))
      .sort((a, b) => b.total - a.total);

    // Auto-consultas (RUT propio) y consultas a otros usuarios de la empresa — últimos 90 días.
    const [users] = await pool.query("SELECT id_usuario, nombre, apellido, rut FROM usuarios WHERE rut IS NOT NULL AND rut<>''");
    const rutToUser = {}, myRut = {};
    users.forEach(u => { const n = rutNum(u.rut); if (n) { rutToUser[n] = `${u.nombre} ${u.apellido || ''}`.trim(); myRut[u.id_usuario] = n; } });
    const [inf90] = await pool.query(
      `SELECT c.id_usuario, TRIM(CONCAT(u.nombre,' ',COALESCE(u.apellido,''))) usuario_nombre, c.rut
       FROM dealernet_consultas c LEFT JOIN usuarios u ON u.id_usuario = c.id_usuario
       WHERE c.retcode='0' AND c.created_at >= NOW() - INTERVAL 90 DAY AND c.id_usuario IS NOT NULL`);
    const propio = {}, empresa = {};
    for (const r of inf90) {
      const n = String(r.rut), nombre = r.usuario_nombre || '—';
      if (myRut[r.id_usuario] && myRut[r.id_usuario] === n) {
        (propio[r.id_usuario] ||= { id_usuario: r.id_usuario, usuario: nombre, n: 0 }).n++;
      } else if (rutToUser[n]) {
        (empresa[r.id_usuario] ||= { id_usuario: r.id_usuario, usuario: nombre, n: 0 }).n++;
      }
    }
    res.json({ success: true, data: {
      dias, porUsuario,
      autoConsulta: Object.values(propio).sort((a, b) => b.n - a.n),
      consultaEmpresa: Object.values(empresa).sort((a, b) => b.n - a.n),
    }, error: null });
  } catch (e) { errSrv(res, e, 'auditoria'); }
};

/* ── Costos en UF + facturación prepago ───────────────────────────────────── */
async function ufUltimoDiaMes(mes) {
  const { getUF } = require('../../../../shared/uf');   // MOTOR ÚNICO de UF por fecha
  const [y, m] = mes.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  const fstr = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return (await getUF(fstr)) || 0;
}
function mesAnterior() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function recomendarPlan(consumo_uf, plan_uf) {
  let rec = PLANES_UF.find(t => t >= consumo_uf);
  if (rec == null) rec = PLANES_UF[PLANES_UF.length - 1];
  if (consumo_uf <= 0) rec = PLANES_UF[0];
  const accion = rec > plan_uf ? 'subir' : rec < plan_uf ? 'bajar' : 'mantener';
  return { accion, plan_recomendado_uf: rec };
}
async function calcularConsumoMes(mes) {
  const ini = mes + '-01';
  const [y, m] = mes.split('-').map(Number);
  const sigY = m === 12 ? y + 1 : y, sigM = m === 12 ? 1 : m + 1;
  const fin = `${sigY}-${String(sigM).padStart(2, '0')}-01`;
  // Precio del tramo del plan contratado
  const [[cfg]] = await pool.query("SELECT valor FROM dealernet_config WHERE clave='plan_uf'");
  const plan_uf = Number(cfg?.valor) || 40;
  const col = COLS_UF[plan_uf] || 'precio_uf_40';
  const [prods] = await pool.query(`SELECT codigo, nombre, ${col} AS precio_uf FROM dealernet_productos`);
  const pmap = {}; prods.forEach(p => pmap[String(p.codigo)] = p);
  const [cnt] = await pool.query(
    `SELECT codigo_producto, COUNT(*) n FROM dealernet_informes
     WHERE retcode='0' AND created_at >= ? AND created_at < ? GROUP BY codigo_producto`, [ini, fin]);
  const uf = await ufUltimoDiaMes(mes);
  let consumo_uf = 0;
  const items = cnt.map(c => {
    const p = pmap[String(c.codigo_producto)] || { nombre: c.codigo_producto, precio_uf: 0 };
    const sub_uf = Number(c.n) * Number(p.precio_uf || 0);
    consumo_uf += sub_uf;
    return { codigo: c.codigo_producto, nombre: p.nombre, n: Number(c.n), precio_uf: Number(p.precio_uf || 0),
      subtotal_uf: +sub_uf.toFixed(4), subtotal_clp: Math.round(sub_uf * uf) };
  }).sort((a, b) => b.subtotal_uf - a.subtotal_uf);
  return { mes, uf, items, consumo_uf: +consumo_uf.toFixed(4), consumo_clp: Math.round(consumo_uf * uf) };
}

const getCostos = async (req, res) => {
  try {
    const [prods] = await pool.query('SELECT codigo, nombre, precio_uf_10, precio_uf_20, precio_uf_40, precio_uf_80, activo, orden FROM dealernet_productos ORDER BY orden, codigo');
    const [[c]] = await pool.query("SELECT valor FROM dealernet_config WHERE clave='plan_uf'");
    res.json({ success: true, data: { productos: prods, plan_uf: Number(c?.valor) || 40, planes: PLANES_UF }, error: null });
  } catch (e) { errSrv(res, e, 'getCostos'); }
};
const updateCostos = async (req, res) => {
  try {
    // precios = { codigo: { '10':n, '20':n, '40':n, '80':n } }
    const precios = req.body?.precios || {};
    for (const [cod, tramos] of Object.entries(precios)) {
      if (!tramos || typeof tramos !== 'object') continue;
      const sets = [], vals = [];
      for (const t of PLANES_UF) {
        const n = Number(tramos[t]);
        if (!isNaN(n) && n >= 0) { sets.push(`${COLS_UF[t]}=?`); vals.push(n); }
      }
      if (sets.length) { vals.push(cod); await pool.query(`UPDATE dealernet_productos SET ${sets.join(', ')} WHERE codigo=?`, vals); }
    }
    if (req.body?.plan_uf !== undefined) {
      const p = Number(req.body.plan_uf);
      if (p > 0) await pool.query("INSERT INTO dealernet_config (clave, valor) VALUES ('plan_uf', ?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)", [String(p)]);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'dealernet', entidad: 'costos', detalle: 'Actualizó costos/plan DealerNet' });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { errSrv(res, e, 'updateCostos'); }
};
const facturacion = async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes : mesAnterior();
    const calc = await calcularConsumoMes(mes);
    const [[c]] = await pool.query("SELECT valor FROM dealernet_config WHERE clave='plan_uf'");
    const plan_uf = Number(c?.valor) || 40;
    const rec = recomendarPlan(calc.consumo_uf, plan_uf);
    const [[guardado]] = await pool.query('SELECT * FROM dealernet_facturacion WHERE mes=?', [mes]);
    res.json({ success: true, data: { ...calc, plan_uf, plan_clp: Math.round(plan_uf * calc.uf), ...rec, guardado: guardado || null }, error: null });
  } catch (e) { errSrv(res, e, 'facturacion'); }
};
const guardarFacturacion = async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(req.body?.mes || '') ? req.body.mes : null;
    if (!mes) return res.status(400).json({ success: false, data: null, error: 'Mes inválido (YYYY-MM)' });
    const calc = await calcularConsumoMes(mes);
    const [[c]] = await pool.query("SELECT valor FROM dealernet_config WHERE clave='plan_uf'");
    const plan_uf = Number(c?.valor) || 40;
    const rec = recomendarPlan(calc.consumo_uf, plan_uf);
    let facturado = req.body?.facturado_real_clp;
    facturado = (facturado === '' || facturado == null) ? null : Number(facturado);
    await pool.query(
      `INSERT INTO dealernet_facturacion (mes, consumo_uf, uf_valor, consumo_clp, plan_uf, facturado_real_clp, recomendacion, plan_recomendado_uf, detalle)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE consumo_uf=VALUES(consumo_uf), uf_valor=VALUES(uf_valor), consumo_clp=VALUES(consumo_clp), plan_uf=VALUES(plan_uf),
         facturado_real_clp=COALESCE(VALUES(facturado_real_clp), facturado_real_clp), recomendacion=VALUES(recomendacion),
         plan_recomendado_uf=VALUES(plan_recomendado_uf), detalle=VALUES(detalle)`,
      [mes, calc.consumo_uf, calc.uf, calc.consumo_clp, plan_uf, facturado, rec.accion, rec.plan_recomendado_uf, JSON.stringify(calc.items)]);
    auditar({ req, accion: 'EDITAR', modulo: 'dealernet', entidad: 'facturacion', detalle: `Guardó facturación ${mes}: ${calc.consumo_uf} UF` });
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { errSrv(res, e, 'guardarFacturacion'); }
};
const historialFacturacion = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT mes, consumo_uf, uf_valor, consumo_clp, plan_uf, facturado_real_clp, recomendacion, plan_recomendado_uf,
        (facturado_real_clp - consumo_clp) AS diff_clp, updated_at
       FROM dealernet_facturacion ORDER BY mes DESC LIMIT 36`);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { errSrv(res, e, 'historialFacturacion'); }
};

/* ── GET /api/dealernet/informes/repositorio — todos los RUT con informes ──
   Solo Administrador (funcionalidad dealernet_repositorio). Nombre del titular
   desde clientes (si es cliente) o desde el propio informe (perfil comercial). */
const repositorio = async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT i.rut, i.dv,
             COUNT(*) AS informes,
             SUM(i.retcode='0') AS ok,
             MAX(i.created_at) AS ultimo,
             GROUP_CONCAT(DISTINCT i.nombre_producto ORDER BY i.nombre_producto SEPARATOR ', ') AS productos,
             SUBSTRING_INDEX(GROUP_CONCAT(i.usuario_nombre ORDER BY i.created_at DESC SEPARATOR '||'), '||', 1) AS ultimo_usuario
        FROM dealernet_informes i
       GROUP BY i.rut, i.dv`);
    // nombre del titular desde clientes (match por rut normalizado sin DV)
    const [clis] = await pool.query(`
      SELECT REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','') AS rutn,
             COALESCE(NULLIF(TRIM(nombre_completo),''),
                      TRIM(CONCAT(IFNULL(nombres,''),' ',IFNULL(apellido_paterno,''),' ',IFNULL(apellido_materno,'')))) AS nombre
        FROM clientes`);
    // clientes.rut incluye DV → indexar por cuerpo sin DV
    const mCuerpo = new Map();
    clis.forEach(c => { const s = String(c.rutn || ''); if (s.length > 1) mCuerpo.set(s.slice(0, -1), c.nombre); });
    const data = rows.map(r => ({
      rut: r.rut, dv: r.dv, informes: Number(r.informes), ok: Number(r.ok),
      ultimo: r.ultimo, productos: r.productos, ultimo_usuario: r.ultimo_usuario,
      nombre: mCuerpo.get(String(r.rut)) || null,
    })).sort((a, b) => new Date(b.ultimo) - new Date(a.ultimo));
    res.json({ success: true, data, error: null });
  } catch (e) { errSrv(res, e, 'repositorio'); }
};

/* Seed: funcionalidad dealernet_repositorio (solo Administrador, id_perfil=1) */
require('../../../../shared/migrate').enFila('dealernet-ws', async () => {
  try {
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='dealernet_repositorio' LIMIT 1");
    let idf = ex && ex.id_funcionalidad;
    if (!idf) {
      const [r] = await pool.query("INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (380001,'Repositorio de Informes','dealernet_repositorio',NULL,'bi-archive')");
      idf = r.insertId;
    }
    await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
  } catch (e) { console.error('[dealernet-repositorio migration]', e.message); }
});

module.exports = { getProductos, fichaInformes, asegurarInformes, analizarInforme, addProducto, updateProducto, deleteProducto, reordenarProductos, consultar, listConsultas, estado,
  verificarRepositorio, solicitarInformes, productosActivos, historicos, verInforme, descargarPdf, getConfigEndpoint, updateConfigEndpoint,
  clasificarRut, auditoria, getCostos, updateCostos, facturacion, guardarFacturacion, historialFacturacion, repositorio };
