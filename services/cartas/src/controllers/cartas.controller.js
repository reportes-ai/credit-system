'use strict';
const pool = require('../../../../shared/config/database');

// Auto-migración: crea tablas si no existen
(async () => {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS cartas_ejecutivos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nombre VARCHAR(150) NOT NULL,
      mail VARCHAR(150) DEFAULT NULL,
      tel VARCHAR(30) DEFAULT NULL,
      activo TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS cartas_parametros (
      \`key\` VARCHAR(100) NOT NULL PRIMARY KEY,
      \`value\` LONGTEXT NOT NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      updated_by VARCHAR(150) DEFAULT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS cartas_aprobacion (
      id INT AUTO_INCREMENT PRIMARY KEY,
      op_carta VARCHAR(30) DEFAULT NULL,
      op_origen VARCHAR(30) DEFAULT NULL,
      tipo VARCHAR(50) DEFAULT NULL,
      ejecutivo_idx INT DEFAULT NULL,
      ejecutivo_nombre VARCHAR(150) DEFAULT NULL,
      ejecutivo_mail VARCHAR(150) DEFAULT NULL,
      ejecutivo_tel VARCHAR(30) DEFAULT NULL,
      cliente VARCHAR(200) DEFAULT NULL,
      rut_cliente VARCHAR(20) DEFAULT NULL,
      tipo_vehiculo VARCHAR(50) DEFAULT NULL,
      marca VARCHAR(100) DEFAULT NULL,
      modelo VARCHAR(100) DEFAULT NULL,
      anio VARCHAR(10) DEFAULT NULL,
      patente VARCHAR(20) DEFAULT NULL,
      prenda VARCHAR(10) DEFAULT NULL,
      precio_venta BIGINT DEFAULT NULL,
      pie BIGINT DEFAULT NULL,
      saldo BIGINT DEFAULT NULL,
      plazo INT DEFAULT NULL,
      acreedor VARCHAR(100) DEFAULT NULL,
      parque VARCHAR(150) DEFAULT NULL,
      concesionario VARCHAR(200) DEFAULT NULL,
      rut_conc VARCHAR(20) DEFAULT NULL,
      vendedor VARCHAR(150) DEFAULT NULL,
      part_neto BIGINT DEFAULT NULL,
      part_iva BIGINT DEFAULT NULL,
      part_bruto BIGINT DEFAULT NULL,
      fecha DATE DEFAULT NULL,
      fecha_creacion DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      creado_por VARCHAR(150) DEFAULT NULL,
      creado_por_nombre VARCHAR(200) DEFAULT NULL,
      creado_por_initials VARCHAR(10) DEFAULT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDIENTE',
      aprobado_por VARCHAR(150) DEFAULT NULL,
      aprobado_por_nombre VARCHAR(200) DEFAULT NULL,
      aprobado_por_initials VARCHAR(10) DEFAULT NULL,
      fecha_aprobacion DATETIME DEFAULT NULL,
      rechazado_por VARCHAR(150) DEFAULT NULL,
      rechazado_por_nombre VARCHAR(200) DEFAULT NULL,
      fecha_rechazo DATETIME DEFAULT NULL,
      motivo_rechazo TEXT DEFAULT NULL,
      anulado_por VARCHAR(150) DEFAULT NULL,
      fecha_anulacion DATETIME DEFAULT NULL,
      eliminado_por VARCHAR(150) DEFAULT NULL,
      fecha_eliminacion DATETIME DEFAULT NULL,
      fecha_correccion DATETIME DEFAULT NULL,
      corregido_por VARCHAR(150) DEFAULT NULL,
      otorgado TINYINT(1) NOT NULL DEFAULT 0,
      fecha_otorgado DATETIME DEFAULT NULL,
      tasa_credito DECIMAL(8,4) DEFAULT NULL,
      monto_credito_clp BIGINT DEFAULT NULL,
      monto_credito_uf DECIMAL(12,4) DEFAULT NULL,
      excepciones JSON DEFAULT NULL,
      excepciones_comentarios JSON DEFAULT NULL,
      INDEX idx_status (status),
      INDEX idx_fecha (fecha),
      INDEX idx_rut_cliente (rut_cliente),
      INDEX idx_creado_por (creado_por)
    )`
  ];
  for (const sql of sqls) {
    try { await pool.query(sql); }
    catch (e) { console.error('[cartas migration]', e.message); }
  }

  // Agregar columnas numero_credito_creado e id_credito_creado si no existen
  try {
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS numero_credito_creado VARCHAR(30) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS id_credito_creado INT DEFAULT NULL`);
  } catch(e) { /* columna ya existe */ }

  // Seed ejecutivos si la tabla está vacía
  try {
    const [[{ cnt }]] = await pool.query('SELECT COUNT(*) AS cnt FROM cartas_ejecutivos');
    if (cnt === 0) {
      const seed = [
        ['Solange Vucina',      'solange.vucina@autofacilchile.cl',      '+56976354089'],
        ['Tatiana Arriagada',   'tatiana.arriagada@autofacilchile.cl',   '+56949808667'],
        ['Alvaro Pinochet',     'alvaro.pinochet@autofacilchile.cl',     '+56978730681'],
        ['Alvaro Vargas',       'alvaro.vargas@autofacilchile.cl',       '+56934998273'],
        ['Carlo Moreno',        'carlo.moreno@autofacilchile.cl',        '+56932280210'],
        ['Karen Farías',        'karen.farias@autofacilchile.cl',        '+56931250518'],
        ['Luis Soto Ravello',   'luis.soto@autofacilchile.cl',           '+56981980972'],
        ['Florencia Bazan',     'florencia.bazan@autofacilchile.cl',     '+56951930421'],
        ['Sebastian Millar',    'sebastian.millar@autofacilchile.cl',    '+56937496188'],
        ['Juan Muñoz',          'juan.munoz@autofacilchile.cl',          '+56966184542'],
        ['Cristina Peña',       'cristina.pena@autofacilchile.cl',       '+56932645136'],
        ['Catherinne Vargas',   'catherinne.vargas@autofacilchile.cl',   '+56989216789'],
        ['Claudia Vergara',     'claudia.vergara@autofacilchile.cl',     '+56968796402'],
      ];
      for (const [nombre, mail, tel] of seed) {
        await pool.query(
          'INSERT IGNORE INTO cartas_ejecutivos (nombre, mail, tel) VALUES (?,?,?)',
          [nombre, mail, tel]
        );
      }
      console.log('✓ cartas_ejecutivos: seeded con lista inicial de ejecutivos');
    }
  } catch (e) { console.error('[cartas ejecutivos seed]', e.message); }
})();

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseJSON(val) {
  if (!val) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return null; }
}

function mapRow(r) {
  return {
    id:                       r.id,
    opCarta:                  r.op_carta,
    opOrigen:                 r.op_origen,
    tipo:                     r.tipo,
    ejecutivoIdx:             r.ejecutivo_idx,
    ejecutivoNombre:          r.ejecutivo_nombre,
    ejecutivoMail:            r.ejecutivo_mail,
    ejecutivoTel:             r.ejecutivo_tel,
    cliente:                  r.cliente,
    rutCliente:               r.rut_cliente,
    tipoVehiculo:             r.tipo_vehiculo,
    marca:                    r.marca,
    modelo:                   r.modelo,
    anio:                     r.anio,
    patente:                  r.patente,
    prenda:                   r.prenda,
    precioVenta:              r.precio_venta,
    pie:                      r.pie,
    saldo:                    r.saldo,
    plazo:                    r.plazo,
    acreedor:                 r.acreedor,
    parque:                   r.parque,
    concesionario:            r.concesionario,
    rutConc:                  r.rut_conc,
    vendedor:                 r.vendedor,
    partNeto:                 r.part_neto,
    partIVA:                  r.part_iva,
    partBruto:                r.part_bruto,
    fecha:                    r.fecha,
    fechaCreacion:            r.fecha_creacion,
    creadoPor:                r.creado_por,
    creadoPorNombre:          r.creado_por_nombre,
    creadoPorInitials:        r.creado_por_initials,
    status:                   r.status,
    aprobadoPor:              r.aprobado_por,
    aprobadoPorNombre:        r.aprobado_por_nombre,
    aprobadoPorInitials:      r.aprobado_por_initials,
    fechaAprobacion:          r.fecha_aprobacion,
    rechazadoPor:             r.rechazado_por,
    rechazadoPorNombre:       r.rechazado_por_nombre,
    fechaRechazo:             r.fecha_rechazo,
    motivoRechazo:            r.motivo_rechazo,
    anuladoPor:               r.anulado_por,
    fechaAnulacion:           r.fecha_anulacion,
    eliminadoPor:             r.eliminado_por,
    fechaEliminacion:         r.fecha_eliminacion,
    fechaCorreccion:          r.fecha_correccion,
    corregidoPor:             r.corregido_por,
    otorgado:                 !!r.otorgado,
    fechaOtorgado:            r.fecha_otorgado,
    tasaCredito:              r.tasa_credito ? parseFloat(r.tasa_credito) : 0,
    montoCreditoCLP:          r.monto_credito_clp,
    montoCreditoUF:           r.monto_credito_uf ? parseFloat(r.monto_credito_uf) : 0,
    excepciones:              parseJSON(r.excepciones) || [],
    excepcionesComentarios:   parseJSON(r.excepciones_comentarios),
    numeroCreditoCreado:      r.numero_credito_creado || null,
    idCreditoCreado:          r.id_credito_creado || null,
  };
}

// ── Controladores ─────────────────────────────────────────────────────────────

const getAll = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM cartas_aprobacion ORDER BY fecha_creacion DESC'
    );
    res.json({ success: true, data: rows.map(mapRow), error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const upsert = async (req, res) => {
  try {
    const c = req.body;
    const vals = [
      c.opCarta, c.opOrigen, c.tipo,
      c.ejecutivoIdx || null, c.ejecutivoNombre, c.ejecutivoMail, c.ejecutivoTel,
      c.cliente, c.rutCliente,
      c.tipoVehiculo, c.marca, c.modelo, c.anio, c.patente, c.prenda,
      c.precioVenta || null, c.pie || null, c.saldo || null,
      c.plazo || null, c.acreedor, c.parque,
      c.concesionario, c.rutConc, c.vendedor,
      c.partNeto || null, c.partIVA || null, c.partBruto || null,
      c.fecha || null, c.fechaCreacion || new Date(),
      c.creadoPor, c.creadoPorNombre, c.creadoPorInitials,
      c.status || 'PENDIENTE',
      c.aprobadoPor || null, c.aprobadoPorNombre || null, c.aprobadoPorInitials || null,
      c.fechaAprobacion || null,
      c.rechazadoPor || null, c.rechazadoPorNombre || null,
      c.fechaRechazo || null, c.motivoRechazo || null,
      c.anuladoPor || null, c.fechaAnulacion || null,
      c.eliminadoPor || null, c.fechaEliminacion || null,
      c.fechaCorreccion || null, c.corregidoPor || null,
      c.otorgado ? 1 : 0, c.fechaOtorgado || null,
      c.tasaCredito || null,
      c.montoCreditoCLP || null,
      c.montoCreditoUF || null,
      c.excepciones ? JSON.stringify(c.excepciones) : null,
      c.excepcionesComentarios ? JSON.stringify(c.excepcionesComentarios) : null,
      c.numeroCreditoCreado || null,
      c.idCreditoCreado || null,
    ];

    if (c.id) {
      // UPDATE existente
      await pool.query(
        `UPDATE cartas_aprobacion SET
          op_carta=?, op_origen=?, tipo=?,
          ejecutivo_idx=?, ejecutivo_nombre=?, ejecutivo_mail=?, ejecutivo_tel=?,
          cliente=?, rut_cliente=?,
          tipo_vehiculo=?, marca=?, modelo=?, anio=?, patente=?, prenda=?,
          precio_venta=?, pie=?, saldo=?,
          plazo=?, acreedor=?, parque=?,
          concesionario=?, rut_conc=?, vendedor=?,
          part_neto=?, part_iva=?, part_bruto=?,
          fecha=?, fecha_creacion=?,
          creado_por=?, creado_por_nombre=?, creado_por_initials=?,
          status=?,
          aprobado_por=?, aprobado_por_nombre=?, aprobado_por_initials=?,
          fecha_aprobacion=?,
          rechazado_por=?, rechazado_por_nombre=?,
          fecha_rechazo=?, motivo_rechazo=?,
          anulado_por=?, fecha_anulacion=?,
          eliminado_por=?, fecha_eliminacion=?,
          fecha_correccion=?, corregido_por=?,
          otorgado=?, fecha_otorgado=?,
          tasa_credito=?, monto_credito_clp=?, monto_credito_uf=?,
          excepciones=?, excepciones_comentarios=?,
          numero_credito_creado=?, id_credito_creado=?
        WHERE id=?`,
        [...vals, c.id]
      );
      res.json({ success: true, data: { id: c.id }, error: null });
    } else {
      // INSERT nuevo
      const [r] = await pool.query(
        `INSERT INTO cartas_aprobacion (
          op_carta, op_origen, tipo,
          ejecutivo_idx, ejecutivo_nombre, ejecutivo_mail, ejecutivo_tel,
          cliente, rut_cliente,
          tipo_vehiculo, marca, modelo, anio, patente, prenda,
          precio_venta, pie, saldo,
          plazo, acreedor, parque,
          concesionario, rut_conc, vendedor,
          part_neto, part_iva, part_bruto,
          fecha, fecha_creacion,
          creado_por, creado_por_nombre, creado_por_initials,
          status,
          aprobado_por, aprobado_por_nombre, aprobado_por_initials,
          fecha_aprobacion,
          rechazado_por, rechazado_por_nombre,
          fecha_rechazo, motivo_rechazo,
          anulado_por, fecha_anulacion,
          eliminado_por, fecha_eliminacion,
          fecha_correccion, corregido_por,
          otorgado, fecha_otorgado,
          tasa_credito, monto_credito_clp, monto_credito_uf,
          excepciones, excepciones_comentarios,
          numero_credito_creado, id_credito_creado
        ) VALUES (${vals.map(() => '?').join(',')})`,
        vals
      );
      res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
    }
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

module.exports = { getAll, upsert };
