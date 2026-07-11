'use strict';
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const SEED_DOCS = [
  ['Carnet de Identidad',              'Ambos lados en un solo archivo',  1, 1,  10],
  ['Comprobante de Domicilio',          null,                              1, 1,  20],
  ['Certificado AFP',                   null,                              1, 1,  30],
  ['Certificado RNDPA',                 null,                              1, 1,  40],
  ['Certificado Anotaciones Vigentes',  null,                              1, 1,  50],
  ['Certificado Historia Vehículo',     null,                              1, 1,  60],
  ['Liquidaciones de Sueldo',           'Últimas 3 liquidaciones',         1, 1,  70],
  ['Declaración de Impuestos',          null,                              0, 1,  80],
  ['Referencias',                       null,                              0, 1,  90],
];

require('../../../../shared/migrate').enFila('tipos-documento', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tipos_documento (
        id_tipo     INT AUTO_INCREMENT PRIMARY KEY,
        nombre      VARCHAR(200) NOT NULL,
        descripcion VARCHAR(500) NULL,
        obligatorio TINYINT(1)  DEFAULT 1,
        activo      TINYINT(1)  DEFAULT 1,
        orden       INT         DEFAULT 0,
        financiera  VARCHAR(20) NOT NULL DEFAULT 'AUTOFACIL',
        created_at  DATETIME    DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migración: agregar columna financiera si no existe
    await pool.query(
      `ALTER TABLE tipos_documento ADD COLUMN IF NOT EXISTS financiera VARCHAR(20) NOT NULL DEFAULT 'AUTOFACIL'`
    ).catch(() => {});

    // Migración: fusionar Carnet Frente + Reverso si aún existen separados
    const [frente] = await pool.query(`SELECT id_tipo FROM tipos_documento WHERE nombre LIKE '%Carnet%Frente%' LIMIT 1`);
    const [reverso] = await pool.query(`SELECT id_tipo FROM tipos_documento WHERE nombre LIKE '%Carnet%Reverso%' LIMIT 1`);
    if (frente.length && reverso.length) {
      await pool.query(`UPDATE tipos_documento SET nombre='Carnet de Identidad', descripcion='Ambos lados en un solo archivo', orden=10 WHERE id_tipo=?`, [frente[0].id_tipo]);
      await pool.query(`DELETE FROM tipos_documento WHERE id_tipo=?`, [reverso[0].id_tipo]);
    }

    // Seed por financiera si no hay registros para esa financiera
    for (const fin of ['AUTOFACIL', 'AUTOFIN', 'UNIDAD']) {
      const [[{ n }]] = await pool.query(`SELECT COUNT(*) as n FROM tipos_documento WHERE financiera=?`, [fin]);
      if (n === 0) {
        for (const [nombre, desc, obl, act, ord] of SEED_DOCS) {
          await pool.query(
            'INSERT INTO tipos_documento (nombre, descripcion, obligatorio, activo, orden, financiera) VALUES (?,?,?,?,?,?)',
            [nombre, desc, obl, act, ord, fin]
          );
        }
        console.log(`✓ tipos_documento: seeded para ${fin}`);
      }
    }
  } catch(e) { if (e.errno !== 1050) console.error('[tipos_documento migration]', e.message); }
});

/* ── AutoFácil: documentos por OCUPACIÓN del cliente (recursos propios) ─────────── */
const SEED_OCUPACION = [
  ['Dependiente Renta Fija', [
    'Cédula de identidad (extranjeros con permanencia definitiva)',
    'Últimas 3 liquidaciones de sueldos',
    'Certificado de cotizaciones de AFP últimos 12 períodos',
    '2 referencias telefónicas',
    'Comprobante de domicilio',
    'Verificación laboral',
  ]],
  ['Dependiente Renta Variable', [
    'Cédula de identidad',
    'Últimas 6 liquidaciones de sueldos',
    'Certificado de cotizaciones de AFP últimos 24 períodos',
    '2 referencias telefónicas',
    'Comprobante de domicilio',
    'Verificación laboral',
  ]],
  ['Independiente', [
    'Cédula de identidad (extranjeros con permanencia definitiva)',
    '12 últimos pagos de IVA',
    '2 últimas declaraciones anuales de impuesto a la renta',
    'Minutas DAI últimos 2 años',
    'Comprobante de domicilio',
    '2 referencias telefónicas',
  ]],
  ['Persona Jurídica', [
    'RUT empresa',
    'RUT de los socios constituyentes',
    '12 últimos pagos de IVA',
    '2 últimas declaraciones anuales de impuesto a la renta',
    'Minutas DAI últimos 2 años',
    'Comprobante de domicilio empresa',
    'Comprobante de domicilio socios',
    '2 referencias telefónicas',
    'Constitución de sociedad, modificaciones, extracto, publicación y registro de comercio vigente',
  ]],
  ['Jubilado', [
    'Cédula de identidad (extranjeros con permanencia definitiva)',
    'Última liquidación de pensiones',
    'Comprobante de domicilio',
    '2 referencias telefónicas',
  ]],
  ['Rentista', [
    'Cédula de identidad (extranjeros con permanencia definitiva)',
    'Contratos de arriendos notariados',
    'Dominio de la propiedad arrendada y donde vive',
    'Comprobante de domicilio',
    '2 referencias telefónicas',
  ]],
  ['Taxista / Colectivo', [
    'Cédula de identidad (extranjeros con permanencia definitiva)',
    'CAV de vehículo con registro nacional vigente en MTT',
    'Dominio de propiedad donde vive',
    'Comprobante de domicilio',
    '2 referencias telefónicas',
  ]],
  ['Transportista Escolar', [
    'Cédula de identidad (extranjeros con permanencia definitiva)',
    'CAV de vehículo con registro nacional vigente en MTT',
    'Dominio de propiedad donde vive',
    'Comprobante de domicilio',
    '2 referencias telefónicas',
  ]],
  ['Feriantes', [
    'Cédula de identidad (extranjeros con permanencia definitiva)',
    'Patente municipal actual',
    'Patente municipal antigua mínimo 2 años',
    'Dominio de la propiedad arrendada y donde vive',
    'Comprobante de domicilio',
    '2 referencias telefónicas',
  ]],
];

require('../../../../shared/migrate').enFila('tipos-documento', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS documentos_ocupacion (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        ocupacion   VARCHAR(80)  NOT NULL,
        documento   VARCHAR(300) NOT NULL,
        obligatorio TINYINT(1)   DEFAULT 1,
        activo      TINYINT(1)   DEFAULT 1,
        orden       INT          DEFAULT 0,
        created_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ocup (ocupacion)
      )
    `);
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM documentos_ocupacion');
    if (n === 0) {
      for (const [ocupacion, docs] of SEED_OCUPACION) {
        let orden = 10;
        for (const documento of docs) {
          await pool.query(
            'INSERT INTO documentos_ocupacion (ocupacion, documento, obligatorio, activo, orden) VALUES (?,?,1,1,?)',
            [ocupacion, documento, orden]);
          orden += 10;
        }
      }
      console.log('✓ documentos_ocupacion: seeded');
    }
  } catch(e) { if (e.errno !== 1050) console.error('[documentos_ocupacion migration]', e.message); }
});

const getAll = async (req, res) => {
  try {
    const fin = req.query.financiera || null;
    const [rows] = fin
      ? await pool.query('SELECT * FROM tipos_documento WHERE financiera=? ORDER BY orden, id_tipo', [fin])
      : await pool.query('SELECT * FROM tipos_documento ORDER BY financiera, orden, id_tipo');
    res.json({ success: true, data: rows, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const getActivos = async (req, res) => {
  try {
    const fin = req.query.financiera || null;
    const [rows] = fin
      ? await pool.query('SELECT * FROM tipos_documento WHERE activo=1 AND financiera=? ORDER BY orden, id_tipo', [fin])
      : await pool.query('SELECT * FROM tipos_documento WHERE activo=1 ORDER BY financiera, orden, id_tipo');
    res.json({ success: true, data: rows, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const create = async (req, res) => {
  try {
    const { nombre, descripcion, obligatorio, activo, orden, financiera } = req.body;
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'nombre es requerido' });
    const [r] = await pool.query(
      'INSERT INTO tipos_documento (nombre, descripcion, obligatorio, activo, orden, financiera) VALUES (?,?,?,?,?,?)',
      [nombre, descripcion || null, obligatorio ? 1 : 0, activo !== false ? 1 : 0, orden || 0, financiera || 'AUTOFACIL']
    );
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'tipo_documento', entidad_id: r.insertId, detalle: `Creó el tipo de documento "${nombre}" (${financiera || 'AUTOFACIL'})`, meta: req.body });
    res.status(201).json({ success: true, data: { id_tipo: r.insertId }, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const update = async (req, res) => {
  try {
    const { nombre, descripcion, obligatorio, activo, orden, financiera } = req.body;
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'nombre es requerido' });
    await pool.query(
      'UPDATE tipos_documento SET nombre=?, descripcion=?, obligatorio=?, activo=?, orden=?, financiera=? WHERE id_tipo=?',
      [nombre, descripcion || null, obligatorio ? 1 : 0, activo !== false ? 1 : 0, orden || 0, financiera || 'AUTOFACIL', req.params.id]
    );
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'tipo_documento', entidad_id: req.params.id, detalle: `Editó el tipo de documento "${nombre}" (#${req.params.id})`, meta: req.body });
    res.json({ success: true, data: { id_tipo: req.params.id }, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const remove = async (req, res) => {
  try {
    await pool.query('DELETE FROM tipos_documento WHERE id_tipo=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'tipo_documento', entidad_id: req.params.id, detalle: `Eliminó el tipo de documento #${req.params.id}` });
    res.json({ success: true, data: { mensaje: 'Tipo de documento eliminado' }, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

// ── Documentos por ocupación (AutoFácil) ───────────────────────────────────────
const getOcupaciones = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM documentos_ocupacion ORDER BY ocupacion, orden, id');
    res.json({ success: true, data: rows, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const createOcupacion = async (req, res) => {
  try {
    const { ocupacion, documento, obligatorio, activo, orden } = req.body;
    if (!ocupacion || !documento) return res.status(400).json({ success: false, data: null, error: 'ocupacion y documento son requeridos' });
    const [r] = await pool.query(
      'INSERT INTO documentos_ocupacion (ocupacion, documento, obligatorio, activo, orden) VALUES (?,?,?,?,?)',
      [String(ocupacion).trim(), String(documento).trim(), obligatorio ? 1 : 0, activo !== false ? 1 : 0, orden || 0]);
    auditar({ req, accion: 'CREAR', modulo: 'mantenedores', entidad: 'documento_ocupacion', entidad_id: r.insertId, detalle: `Creó documento "${documento}" para ocupación "${ocupacion}"`, meta: req.body });
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const updateOcupacion = async (req, res) => {
  try {
    const { ocupacion, documento, obligatorio, activo, orden } = req.body;
    if (!ocupacion || !documento) return res.status(400).json({ success: false, data: null, error: 'ocupacion y documento son requeridos' });
    await pool.query(
      'UPDATE documentos_ocupacion SET ocupacion=?, documento=?, obligatorio=?, activo=?, orden=? WHERE id=?',
      [String(ocupacion).trim(), String(documento).trim(), obligatorio ? 1 : 0, activo !== false ? 1 : 0, orden || 0, req.params.id]);
    auditar({ req, accion: 'EDITAR', modulo: 'mantenedores', entidad: 'documento_ocupacion', entidad_id: req.params.id, detalle: `Editó documento de ocupación #${req.params.id}`, meta: req.body });
    res.json({ success: true, data: { id: req.params.id }, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

const removeOcupacion = async (req, res) => {
  try {
    await pool.query('DELETE FROM documentos_ocupacion WHERE id=?', [req.params.id]);
    auditar({ req, accion: 'ELIMINAR', modulo: 'mantenedores', entidad: 'documento_ocupacion', entidad_id: req.params.id, detalle: `Eliminó documento de ocupación #${req.params.id}` });
    res.json({ success: true, data: { mensaje: 'Documento eliminado' }, error: null });
  } catch(e) { (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'})); }
};

module.exports = { getAll, getActivos, create, update, remove, getOcupaciones, createOcupacion, updateOcupacion, removeOcupacion };
