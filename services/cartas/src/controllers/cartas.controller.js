'use strict';
const pool = require('../../../../shared/config/database');
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
const { auditar } = require('../../../../shared/audit');
const { publicarAnuncio } = require('../../../../shared/anuncios');
const { marcarForzadosCalculo } = require('../../../creditos/src/utils/recalcular-mes');
const pdf = require('pdf-parse');

/* Genera numero_credito igual que creditos.controller (YYMMXXX) */
async function generarNumeroCreditoDesdeCartas() {
  const hoy = new Date();
  const yy = String(hoy.getFullYear()).slice(-2);
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const prefix = `${yy}${mm}`;
  const [[row]] = await pool.query(
    `SELECT numero_credito FROM creditos WHERE numero_credito LIKE ? ORDER BY id DESC LIMIT 1`,
    [prefix + '%']
  );
  const seq = row ? parseInt(row.numero_credito.slice(4)) + 1 : 1;
  return prefix + String(seq).padStart(3, '0');
}

/* Crea registro en creditos a partir de una carta y devuelve { id, numero_credito } */
async function crearCreditoDesdeCartas(c) {
  const rutNorm = (c.rut_cliente || c.rutCliente || '').replace(/\./g, '').toUpperCase().trim();
  const [[cliRow]] = await pool.query('SELECT id_cliente FROM clientes WHERE rut = ? LIMIT 1', [rutNorm]).catch(() => [[null]]);
  const numero_credito = await generarNumeroCreditoDesdeCartas();
  // Mapear acreedor → financiera
  const finMap = { 'AUTOFIN': 'AUTOFIN', 'AUTOFACIL': 'AUTOFACIL', 'UNIDAD': 'UNIDAD DE CREDITO', 'UNIDAD DE CREDITO': 'UNIDAD DE CREDITO' };
  const financiera = finMap[(c.acreedor || '').toUpperCase()] || 'AUTOFACIL';
  const saldo = c.saldo || null;
  const precio = c.precio_venta || c.precioVenta || null;
  const pie = c.pie || null;
  const pct = (precio && saldo) ? saldo / precio : null;

  const [r] = await pool.query(`
    INSERT INTO creditos
      (numero_credito, financiera, estado_eval, estado,
       id_cliente, rut_dealer, vendedor,
       fecha_otorgado, mes, valor_vehiculo, pie, saldo_precio, pct_financiado,
       monto_financiado, plazo, tascli_real,
       tipo_vehiculo, marca, modelo, anio, patente,
       automotora, ejecutivo, comdea_real,
       created_at, updated_at)
    VALUES (?,?,
            'OTORGADO','INGRESO',
            ?,?,?,
            NULL, DATE_FORMAT(NOW(),'%Y-%m-01'), ?,?,?,?,
            ?,?,?,
            ?,?,?,?,?,
            ?,?,?,
            NOW(),NOW())
  `, [
    numero_credito, financiera,
    cliRow?.id_cliente || null,
    (c.rut_conc || c.rutConc || null),
    (c.vendedor || null),
    precio, pie, saldo, pct,
    (c.monto_credito_clp || c.montoCreditoCLP || null),
    (c.plazo || null),
    (c.tasa_credito || c.tasaCredito || null),
    (c.tipo_vehiculo || c.tipoVehiculo || null),
    (c.marca || null), (c.modelo || null), (c.anio || null), (c.patente || null),
    (c.concesionario || null),
    (c.ejecutivo_nombre || c.ejecutivoNombre || null),
    (c.part_bruto || c.partBruto || null),
  ]);
  // La participación de la carta (part_bruto) es una negociación especial: si difiere
  // del cálculo, comdea_real queda forzado (no se sobrescribe en el recálculo).
  const partCarta = c.part_bruto ?? c.partBruto;
  if (partCarta != null && String(partCarta).trim() !== '') {
    try { await marcarForzadosCalculo(r.insertId, { campos: ['comdea_real'] }); }
    catch (e) { console.error('[forzados carta]', e.message); }
  }
  return { id: r.insertId, numero_credito };
}

/* Usuarios activos con permiso de revisar cartas (incluye Administradores) */
async function idsRevisores(excluirEmail) {
  const [rows] = await pool.query(
    `SELECT u.id_usuario FROM usuarios u
       JOIN perfiles p ON p.id_perfil = u.id_perfil
     WHERE p.nombre = 'Administrador' AND u.estado = 'activo' AND u.email <> ?
     UNION
     SELECT u.id_usuario FROM usuarios u
       JOIN permisos_perfil pp ON pp.id_perfil = u.id_perfil
       JOIN funcionalidades f  ON f.id_funcionalidad = pp.id_funcionalidad
     WHERE f.codigo = 'aprob_revisar' AND pp.habilitado = 1
       AND u.estado = 'activo' AND u.email <> ?`,
    [excluirEmail || '', excluirEmail || '']
  );
  return rows.map(r => r.id_usuario);
}

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
      id_financiera VARCHAR(50) DEFAULT NULL,
      tipo VARCHAR(50) DEFAULT NULL,
      ejecutivo_idx INT DEFAULT NULL,
      ejecutivo VARCHAR(150) DEFAULT NULL,
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
      nombre_dealer VARCHAR(200) DEFAULT NULL,
      rut_dealer VARCHAR(20) DEFAULT NULL,
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
    )`,
    `CREATE TABLE IF NOT EXISTS cartas_documentos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      id_carta INT NULL,
      tipo VARCHAR(30) NOT NULL,
      nombre VARCHAR(255) DEFAULT NULL,
      mime VARCHAR(100) DEFAULT 'application/pdf',
      tamano INT DEFAULT NULL,
      data LONGBLOB,
      extracted JSON NULL,
      subido_por VARCHAR(150) DEFAULT NULL,
      id_subido_por INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_carta (id_carta)
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

  // Desistimiento de carta (vencida o manual): la carta sale de "Vigentes".
  try {
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS desistido_por VARCHAR(150) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS desistido_por_nombre VARCHAR(200) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS fecha_desistimiento DATETIME DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS motivo_desistimiento TEXT DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS desistido_auto TINYINT(1) NOT NULL DEFAULT 0`);
    // Snapshot del TIER UAC vigente al emitir la carta (para la rentabilidad). Se puede recalcular por mes.
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS tier_uac_n INT DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS tier_uac_pct DECIMAL(6,3) DEFAULT NULL`);
  } catch(e) { /* columna ya existe */ }
  // Barrer vencidas al arrancar (por si el servicio estuvo caído al cumplirse el plazo).
  barrerVencidas().catch(e => console.error('[cartas barrerVencidas boot]', e.message));

  // Homologación: renombrar op_origen → id_financiera (alinear con creditos.id_financiera)
  try {
    const [[oc]] = await pool.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'cartas_aprobacion' AND column_name = 'op_origen'`);
    if (oc.c > 0) {
      await pool.query(`ALTER TABLE cartas_aprobacion CHANGE COLUMN op_origen id_financiera VARCHAR(50) DEFAULT NULL`);
    }
  } catch(e) { console.error('[cartas migration rename op_origen]', e.message); }

  // Homologación: renombrar rut_conc → rut_dealer
  try {
    const [[rc]] = await pool.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'cartas_aprobacion' AND column_name = 'rut_conc'`);
    if (rc.c > 0) {
      await pool.query(`ALTER TABLE cartas_aprobacion CHANGE COLUMN rut_conc rut_dealer VARCHAR(20) DEFAULT NULL`);
    }
  } catch(e) { console.error('[cartas migration rename rut_conc]', e.message); }

  // Homologación: renombrar concesionario → nombre_dealer
  try {
    const [[cc]] = await pool.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'cartas_aprobacion' AND column_name = 'concesionario'`);
    if (cc.c > 0) {
      await pool.query(`ALTER TABLE cartas_aprobacion CHANGE COLUMN concesionario nombre_dealer VARCHAR(200) DEFAULT NULL`);
    }
  } catch(e) { console.error('[cartas migration rename concesionario]', e.message); }

  // Homologación: renombrar ejecutivo_nombre → ejecutivo
  try {
    const [[en]] = await pool.query(
      `SELECT COUNT(*) AS c FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'cartas_aprobacion' AND column_name = 'ejecutivo_nombre'`);
    if (en.c > 0) {
      await pool.query(`ALTER TABLE cartas_aprobacion CHANGE COLUMN ejecutivo_nombre ejecutivo VARCHAR(150) DEFAULT NULL`);
    }
  } catch(e) { console.error('[cartas migration rename ejecutivo_nombre]', e.message); }

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

// IVA paramétrico (mantenedor Impuestos). Se refresca en getAll; default 1.19.
let _ivaFactor = 1.19;
async function _refreshIva(){
  try { const [[r]] = await pool.query("SELECT porcentaje FROM impuestos WHERE codigo='IVA'"); if (r) _ivaFactor = 1 + Number(r.porcentaje)/100; } catch(e) {}
}
function mapRow(r) {
  // Participación dealer: usa lo guardado en la carta o, si no viene, deriva del
  // crédito enlazado (comdea_real = bruto con IVA → neto = bruto/1.19).
  const brutoStore = Number(r.part_bruto) || 0;
  const brutoCred  = Number(r.cred_comdea_real) || 0;
  const partBruto  = brutoStore || brutoCred || null;
  const partNeto   = (r.part_neto != null) ? r.part_neto : (partBruto ? Math.round(partBruto / _ivaFactor) : null);
  const partIVA    = (r.part_iva  != null) ? r.part_iva  : (partBruto ? partBruto - Math.round(partBruto / _ivaFactor) : null);
  const cv = (a, b) => (a == null || a === '' || a === 0) ? (b ?? null) : a;
  return {
    id:                       r.id,
    opCarta:                  r.op_carta,
    opOrigen:                 r.id_financiera,
    tipo:                     r.tipo,
    ejecutivoIdx:             r.ejecutivo_idx,
    ejecutivoNombre:          r.ejecutivo,
    ejecutivoMail:            r.ejecutivo_mail,
    ejecutivoTel:             r.ejecutivo_tel,
    cliente:                  r.cliente,
    rutCliente:               r.rut_cliente,
    tipoVehiculo:             cv(r.tipo_vehiculo, r.cred_tipo_vehiculo),
    marca:                    cv(r.marca, r.cred_marca),
    modelo:                   cv(r.modelo, r.cred_modelo),
    anio:                     cv(r.anio, r.cred_anio),
    patente:                  cv(r.patente, r.cred_patente),
    prenda:                   r.prenda,
    precioVenta:              cv(r.precio_venta, r.cred_valor_vehiculo),
    pie:                      cv(r.pie, r.cred_pie),
    saldo:                    r.saldo,
    plazo:                    cv(r.plazo, r.cred_plazo),
    acreedor:                 r.acreedor,
    parque:                   r.parque,
    concesionario:            r.nombre_dealer,
    rutConc:                  r.rut_dealer,
    vendedor:                 r.vendedor,
    partNeto:                 partNeto,
    partIVA:                  partIVA,
    partBruto:                partBruto,
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
    desistidoPorNombre:       r.desistido_por_nombre,
    fechaDesistimiento:       r.fecha_desistimiento,
    motivoDesistimiento:      r.motivo_desistimiento,
    desistidoAuto:            !!r.desistido_auto,
    tierUacN:                 r.tier_uac_n != null ? Number(r.tier_uac_n) : null,
    tierUacPct:               r.tier_uac_pct != null ? parseFloat(r.tier_uac_pct) : null,
    tasaCredito:              r.tasa_credito ? parseFloat(r.tasa_credito) : 0,
    montoCreditoCLP:          r.monto_credito_clp,
    montoCreditoUF:           r.monto_credito_uf ? parseFloat(r.monto_credito_uf) : 0,
    excepciones:              parseJSON(r.excepciones) || [],
    excepcionesComentarios:   parseJSON(r.excepciones_comentarios),
    numeroCreditoCreado:      r.numero_credito_creado || null,
    idCreditoCreado:          r.id_credito_creado || null,
    numOp:                    r.cred_num_op || null,                                  // NUESTRO N° de operación (creditos.num_op)
    numeroCredito:            r.cred_numero_credito || r.numero_credito_creado || null,
  };
}

// ── Permiso aprob_ver_todas: perfil base + override individual ───────────────
// Transición segura: si el perfil NO tiene registro del permiso (no configurado
// aún en Perfiles y Permisos), se mantiene el comportamiento histórico (ve todas).
// Al guardar la matriz de permisos queda 0/1 explícito y se aplica la restricción.
async function puedeVerTodas(usuario) {
  if (!usuario) return false;
  if (usuario.perfil_nombre === 'Administrador') return true;
  try {
    const [[ov]] = await pool.query(
      `SELECT pu.habilitado FROM permisos_usuario pu
       JOIN funcionalidades f ON f.id_funcionalidad = pu.id_funcionalidad
       WHERE pu.id_usuario = ? AND f.codigo = 'aprob_ver_todas'`,
      [usuario.id_usuario]
    );
    if (ov) return ov.habilitado === 1;
  } catch (_) { /* tabla permisos_usuario puede no existir */ }
  try {
    const [[pp]] = await pool.query(
      `SELECT pp.habilitado FROM permisos_perfil pp
       JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
       WHERE pp.id_perfil = ? AND f.codigo = 'aprob_ver_todas'`,
      [usuario.id_perfil]
    );
    return pp ? pp.habilitado === 1 : true; // sin registro → legacy: ve todas
  } catch (_) { return true; }
}

// ── TIER UAC (rentabilidad) ─────────────────────────────────────────────────────
// El % que paga UAC escala con el volumen de operaciones UAC otorgadas en el mes
// (tramos uac_ops_tier*_max). Devuelve { n, pct(%), count }.
async function tierUAC(fechaRef) {
  try {
    const [pr] = await pool.query(
      "SELECT clave, valor FROM parametros_credito WHERE clave IN ('uac_ops_tier1_max','uac_ops_tier2_max','uac_ops_tier3_max','uac_pct_tier1','uac_pct_tier2','uac_pct_tier3','uac_pct_tier4')");
    const P = {}; pr.forEach(r => { P[r.clave] = parseFloat(r.valor); });
    const t1 = P.uac_ops_tier1_max || 5, t2 = P.uac_ops_tier2_max || 10, t3 = P.uac_ops_tier3_max || 15;
    const ref = fechaRef ? new Date(fechaRef) : new Date();
    const ym = isNaN(ref) ? null : `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, '0')}`;
    let count = 0;
    if (ym) {
      const [[c]] = await pool.query(
        "SELECT COUNT(*) n FROM creditos WHERE financiera='UNIDAD DE CREDITO' AND fecha_otorgado IS NOT NULL AND DATE_FORMAT(fecha_otorgado,'%Y-%m')=?", [ym]);
      count = c.n || 0;
    }
    let n, pct;
    if (count <= t1)      { n = 1; pct = P.uac_pct_tier1 || 14; }
    else if (count <= t2) { n = 2; pct = P.uac_pct_tier2 || 16; }
    else if (count <= t3) { n = 3; pct = P.uac_pct_tier3 || 18; }
    else                  { n = 4; pct = P.uac_pct_tier4 || 20; }
    return { n, pct, count };
  } catch (e) { console.error('[tierUAC]', e.message); return { n: 1, pct: 14, count: 0 }; }
}

// Recalcula el snapshot de tier para todas las cartas de un mes (dashboard más aproximado).
async function recalcularTierMes(fechaRef) {
  const t = await tierUAC(fechaRef);
  const ref = fechaRef ? new Date(fechaRef) : new Date();
  if (isNaN(ref)) return t;
  const ym = `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, '0')}`;
  await pool.query("UPDATE cartas_aprobacion SET tier_uac_n=?, tier_uac_pct=? WHERE DATE_FORMAT(COALESCE(fecha, DATE(fecha_creacion)),'%Y-%m')=?", [t.n, t.pct, ym]).catch(() => {});
  return t;
}

// ── Vigencia de la carta (paramétrico) ─────────────────────────────────────────
// Días corridos desde la FECHA de la carta. Configurable en parametros_credito
// (clave vigencia_carta_dias, mantenedor Parámetros de Crédito). Default 5.
async function vigenciaDias() {
  try {
    const [[r]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='vigencia_carta_dias' LIMIT 1");
    const n = r ? parseInt(r.valor, 10) : 0;
    return n > 0 ? n : 5;
  } catch { return 5; }
}

// Best-effort: pasa el crédito vinculado a un estado, solo si viene de un estado de
// originación abierto (no clobberea otorgados/prepagados). Enlaza por FK explícita
// (id_credito_creado) y por num_op = id_financiera (como el sync de cartolas).
async function _ligarCreditoEstado(carta, nuevoEstado, estadosOrigen) {
  const cond = [], args = [];
  if (carta.id_credito_creado) { cond.push('id = ?'); args.push(carta.id_credito_creado); }
  if (carta.id_financiera)     { cond.push('num_op = ?'); args.push(carta.id_financiera); }
  if (!cond.length) return 0;
  const ins = estadosOrigen.map(() => '?').join(',');
  try {
    const [r] = await pool.query(
      `UPDATE creditos SET estado=?, updated_at=NOW() WHERE (${cond.join(' OR ')}) AND estado IN (${ins})`,
      [nuevoEstado, ...args, ...estadosOrigen]);
    return r.affectedRows;
  } catch (e) { console.error('[carta→credito estado]', e.message); return 0; }
}

// Pasa a DESISTIDA (auto) las cartas APROBADA no otorgadas cuyo plazo de vigencia
// (fecha de la carta + N días corridos) ya venció. Quedan no imprimibles.
async function barrerVencidas() {
  const dias = await vigenciaDias();
  const [r] = await pool.query(
    `UPDATE cartas_aprobacion
        SET status='DESISTIDA', desistido_auto=1, fecha_desistimiento=NOW(),
            motivo_desistimiento=CONCAT('Vencida automáticamente (', ?, ' días corridos desde la fecha de la carta).')
      WHERE status='APROBADA' AND otorgado=0 AND fecha IS NOT NULL
        AND DATE_ADD(fecha, INTERVAL ? DAY) < CURDATE()`, [dias, dias]);
  if (r.affectedRows) {
    await pool.query(
      `UPDATE creditos cr JOIN cartas_aprobacion ca ON ca.id_credito_creado = cr.id
          SET cr.estado='DESISTIDO', cr.updated_at=NOW()
        WHERE ca.status='DESISTIDA' AND ca.desistido_auto=1 AND cr.estado='CARTA_APROBACION'`).catch(()=>{});
  }
  return r.affectedRows;
}

// ── Controladores ─────────────────────────────────────────────────────────────

// GET /api/cartas/vigencia → { dias }. Cualquiera autenticado (lo usa la pantalla).
const getVigencia = async (req, res) => {
  try { res.json({ success: true, data: { dias: await vigenciaDias() }, error: null }); }
  catch (e) { console.error('[cartas getVigencia]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// PUT /api/cartas/vigencia → fija los días de vigencia en parametros_credito. Solo aprob_mantenedor.
const setVigencia = async (req, res) => {
  try {
    const n = parseInt(req.body?.dias, 10);
    if (!(n >= 1 && n <= 60)) return res.status(400).json({ success: false, data: null, error: 'Días de vigencia inválidos (1 a 60).' });
    await pool.query(
      `INSERT INTO parametros_credito (clave, valor, descripcion)
       VALUES ('vigencia_carta_dias', ?, 'Vigencia de la Carta de Aprobación (días corridos desde la fecha de la carta; al vencer pasa a DESISTIDA)')
       ON DUPLICATE KEY UPDATE valor=VALUES(valor)`, [n]);
    auditar({ req, accion: 'EDITAR', modulo: 'cartas', entidad: 'config', entidad_id: 'vigencia_carta_dias', detalle: `Vigencia de carta = ${n} días corridos` });
    barrerVencidas().catch(() => {});   // re-aplica el plazo nuevo de inmediato
    res.json({ success: true, data: { dias: n }, error: null });
  } catch (e) { console.error('[cartas setVigencia]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// GET /api/cartas/:id/rentabilidad — refresca el snapshot del tier del mes y lo devuelve.
const rentabilidadTier = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [[ca]] = await pool.query('SELECT fecha, tier_uac_n, tier_uac_pct FROM cartas_aprobacion WHERE id=? LIMIT 1', [id]);
    if (!ca) return res.status(404).json({ success: false, data: null, error: 'Carta no encontrada.' });
    let t = null;
    try { t = await recalcularTierMes(ca.fecha); } catch (_) {}
    const n   = t ? t.n   : (ca.tier_uac_n != null ? Number(ca.tier_uac_n) : 1);
    const pct = t ? t.pct : (ca.tier_uac_pct != null ? parseFloat(ca.tier_uac_pct) : 14);
    res.json({ success: true, data: { tier_uac_n: n, tier_uac_pct: pct, count: t ? t.count : null }, error: null });
  } catch (e) { console.error('[cartas rentabilidadTier]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// POST /api/cartas/:id/otorgar — la carta vigente pasa a OTORGADA: marca otorgado,
// pone el crédito vinculado en OTORGADO y genera la cartola de comisión del mes.
const otorgar = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const [[ca]] = await pool.query('SELECT * FROM cartas_aprobacion WHERE id=? LIMIT 1', [id]);
    if (!ca) return res.status(404).json({ success: false, data: null, error: 'Carta no encontrada.' });
    if (ca.status !== 'APROBADA') return res.status(400).json({ success: false, data: null, error: 'Solo una carta APROBADA puede otorgarse.' });
    if (ca.otorgado) return res.status(400).json({ success: false, data: null, error: 'La carta ya está otorgada.' });

    await pool.query('UPDATE cartas_aprobacion SET otorgado=1, fecha_otorgado=NOW() WHERE id=?', [id]);
    // Enlaza el crédito si ya existe (carga masiva) para poblar la FK
    await pool.query(
      `UPDATE cartas_aprobacion ca JOIN creditos cr ON cr.num_op = ca.id_financiera
          SET ca.id_credito_creado = COALESCE(ca.id_credito_creado, cr.id),
              ca.numero_credito_creado = COALESCE(ca.numero_credito_creado, cr.num_op)
        WHERE ca.id=?`, [id]).catch(()=>{});
    // Crédito vinculado → OTORGADO + fecha_otorgado. La fecha es lo que gatilla Post Venta
    // (su sync crea la fila + etapas FUNDANTES PENDIENTES y COMISION A PAGAR para todo
    //  crédito con fecha_otorgado). El crédito que crea la carta nace con fecha_otorgado NULL.
    {
      const cond = [], args = [];
      if (ca.id_credito_creado) { cond.push('id = ?'); args.push(ca.id_credito_creado); }
      if (ca.id_financiera)     { cond.push('num_op = ?'); args.push(ca.id_financiera); }
      if (cond.length) await pool.query(
        `UPDATE creditos SET estado='OTORGADO', fecha_otorgado=COALESCE(fecha_otorgado, CURDATE()), updated_at=NOW()
          WHERE (${cond.join(' OR ')}) AND estado IN ('CARTA_APROBACION','APROBADO','INGRESO')`, args
      ).catch(e => console.error('[carta otorgar→credito]', e.message));
    }
    // Cartola COMISION del mes (misma lógica que /api/cartolas/sync, acotada a esta carta)
    await pool.query(
      `INSERT INTO cartolas_movimientos
         (mes, id_carta, num_op, movimiento, rut_dealer, nombre_dealer,
          ejecutivo, nombre_cliente, rut_cliente, saldo, comision,
          estado_comision, num_carta, vendedor, acreedor)
       SELECT DATE_FORMAT(COALESCE(ca.fecha_otorgado, NOW()), '%Y-%m'),
              ca.id, ca.id_financiera, 'COMISION', ca.rut_dealer, ca.nombre_dealer,
              ca.ejecutivo, ca.cliente, ca.rut_cliente, ca.saldo,
              COALESCE(NULLIF(ca.part_bruto,0), crx.comdea_real),
              'PENDIENTE', ca.op_carta, ca.vendedor, ca.acreedor
         FROM cartas_aprobacion ca
         LEFT JOIN creditos crx ON crx.id = ca.id_credito_creado
        WHERE ca.id = ? AND ca.otorgado = 1 AND ca.status = 'APROBADA'
          AND NOT EXISTS (SELECT 1 FROM cartolas_movimientos m WHERE m.id_carta = ca.id AND m.movimiento = 'COMISION')`,
      [id]).catch(e => console.error('[carta otorgar→cartola]', e.message));
    // Otorgar una UAC puede subir el tier del mes → refresca el snapshot de ese mes
    recalcularTierMes(ca.fecha).catch(() => {});
    auditar({ req, accion: 'OTORGAR', modulo: 'cartas', entidad: 'carta', entidad_id: id,
      detalle: `Carta ${ca.op_carta || id} otorgada (crédito → OTORGADO + cartola de comisión)` });
    // Anuncio push a toda la app (mensaje/colores/sonido configurables en mantenedor de Alertas)
    const ejec = String(ca.ejecutivo || '').trim().toLowerCase().replace(/\b\p{L}/gu, m => m.toUpperCase());
    if (ejec) publicarAnuncio('credito_otorgado', { ejecutivo: ejec }).catch(() => {});
    res.json({ success: true, data: { id, otorgado: true }, error: null });
  } catch (e) { console.error('[cartas otorgar]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// POST /api/cartas/:id/desistir — la carta vigente pasa a DESISTIDA (manual) y el
// crédito vinculado a DESISTIDO. Deja de ser imprimible.
const desistir = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const motivo = String(req.body?.motivo == null ? '' : req.body.motivo).trim().slice(0, 500) || null;
    const [[ca]] = await pool.query('SELECT * FROM cartas_aprobacion WHERE id=? LIMIT 1', [id]);
    if (!ca) return res.status(404).json({ success: false, data: null, error: 'Carta no encontrada.' });
    if (ca.status !== 'APROBADA') return res.status(400).json({ success: false, data: null, error: 'Solo una carta APROBADA puede pasar a Desistida.' });
    if (ca.otorgado) return res.status(400).json({ success: false, data: null, error: 'La carta ya está otorgada; no puede desistirse.' });
    const nombre = [req.usuario?.nombre, req.usuario?.apellido].filter(Boolean).join(' ') || req.usuario?.email || '';
    await pool.query(
      `UPDATE cartas_aprobacion
          SET status='DESISTIDA', desistido_auto=0, desistido_por=?, desistido_por_nombre=?,
              fecha_desistimiento=NOW(), motivo_desistimiento=? WHERE id=?`,
      [req.usuario?.email || null, nombre, motivo, id]);
    await _ligarCreditoEstado(ca, 'DESISTIDO', ['CARTA_APROBACION', 'APROBADO', 'INGRESO']);
    auditar({ req, accion: 'DESISTIR', modulo: 'cartas', entidad: 'carta', entidad_id: id,
      detalle: `Carta ${ca.op_carta || id} desistida${motivo ? ': ' + motivo : ''}` });
    res.json({ success: true, data: { id, status: 'DESISTIDA' }, error: null });
  } catch (e) { console.error('[cartas desistir]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

const getAll = async (req, res) => {
  try {
    await barrerVencidas().catch(() => {});   // mantiene la lista de vigentes al día
    const verTodas = await puedeVerTodas(req.usuario);
    const login = req.usuario?.email || String(req.usuario?.id_usuario || '');
    // JOIN al crédito enlazado: NUESTRO N° de operación (num_op), numero_credito,
    // y datos de vehículo/participación como respaldo cuando la carta no los trae.
    const SEL = `SELECT ca.*, cr.num_op AS cred_num_op, cr.numero_credito AS cred_numero_credito,
                   cr.tipo_vehiculo AS cred_tipo_vehiculo, cr.marca AS cred_marca, cr.modelo AS cred_modelo,
                   cr.anio AS cred_anio, cr.patente AS cred_patente, cr.valor_vehiculo AS cred_valor_vehiculo,
                   cr.pie AS cred_pie, cr.plazo AS cred_plazo, cr.comdea_real AS cred_comdea_real
                 FROM cartas_aprobacion ca
                 LEFT JOIN creditos cr ON cr.id = ca.id_credito_creado`;
    const [rows] = verTodas
      ? await pool.query(`${SEL} ORDER BY ca.fecha_creacion DESC`)
      : await pool.query(`${SEL} WHERE ca.creado_por = ? ORDER BY ca.fecha_creacion DESC`, [login]);
    await _refreshIva();
    res.json({ success: true, data: rows.map(mapRow), verTodas, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const upsert = async (req, res) => {
  try {
    const c = req.body;
    // Estado previo (para detectar transiciones que generan notificación)
    let prevStatus = null;
    if (c.id) {
      const [[prev]] = await pool.query('SELECT status FROM cartas_aprobacion WHERE id = ?', [c.id]);
      prevStatus = prev?.status || null;
    }
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
          op_carta=?, id_financiera=?, tipo=?,
          ejecutivo_idx=?, ejecutivo=?, ejecutivo_mail=?, ejecutivo_tel=?,
          cliente=?, rut_cliente=?,
          tipo_vehiculo=?, marca=?, modelo=?, anio=?, patente=?, prenda=?,
          precio_venta=?, pie=?, saldo=?,
          plazo=?, acreedor=?, parque=?,
          nombre_dealer=?, rut_dealer=?, vendedor=?,
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
      // Sincronizar estado del crédito vinculado
      if (c.idCreditoCreado || c.id_credito_creado) {
        const idCred = c.idCreditoCreado || c.id_credito_creado;
        if (c.status === 'APROBADA') {
          pool.query(`UPDATE creditos SET estado='CARTA_APROBACION', updated_at=NOW() WHERE id=? AND estado='INGRESO'`, [idCred]).catch(e => console.error('[carta→credito estado]', e.message));
        } else if (c.status === 'RECHAZADA') {
          pool.query(`UPDATE creditos SET estado='INGRESO', updated_at=NOW() WHERE id=? AND estado='CARTA_APROBACION'`, [idCred]).catch(e => console.error('[carta→credito estado]', e.message));
        }
      }
      notificarCambios(c, prevStatus, req);
    } else {
      // INSERT nuevo: crear crédito asociado primero
      let credCreado = null;
      try { credCreado = await crearCreditoDesdeCartas(c); } catch(e) { console.error('[carta→credito]', e.message); }
      if (credCreado) {
        vals[vals.length - 2] = credCreado.numero_credito; // numero_credito_creado
        vals[vals.length - 1] = credCreado.id;             // id_credito_creado
      }
      const [r] = await pool.query(
        `INSERT INTO cartas_aprobacion (
          op_carta, id_financiera, tipo,
          ejecutivo_idx, ejecutivo, ejecutivo_mail, ejecutivo_tel,
          cliente, rut_cliente,
          tipo_vehiculo, marca, modelo, anio, patente, prenda,
          precio_venta, pie, saldo,
          plazo, acreedor, parque,
          nombre_dealer, rut_dealer, vendedor,
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
      // Snapshot del TIER UAC vigente al generar la carta (para la rentabilidad)
      tierUAC(c.fecha).then(t => pool.query('UPDATE cartas_aprobacion SET tier_uac_n=?, tier_uac_pct=? WHERE id=?', [t.n, t.pct, r.insertId])).catch(() => {});
      res.status(201).json({ success: true, data: { id: r.insertId, numero_credito_creado: credCreado?.numero_credito || null }, error: null });
      notificarCambios(c, null, req);
    }
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* Notificaciones del flujo (no bloquea la respuesta HTTP) */
function notificarCambios(c, prevStatus, req) {
  (async () => {
    try {
      const esNuevaPendiente   = !prevStatus && c.status === 'PENDIENTE';
      const vuelveAlPool       = prevStatus === 'RECHAZADA' && c.status === 'PENDIENTE';
      const resuelta           = prevStatus === 'PENDIENTE' && (c.status === 'APROBADA' || c.status === 'RECHAZADA');

      if (esNuevaPendiente || vuelveAlPool) {
        const ids = await idsRevisores(c.creadoPor);
        // Cliente esperando → alta prioridad y sonido distinto para que no pase desapercibida
        await notificar(ids, {
          tipo: 'CARTA_NUEVA',
          titulo: vuelveAlPool ? '🔁 Carta corregida para revisión' : '🛎️ Nueva carta para revisión',
          mensaje: `${c.creadoPorNombre || 'Un ejecutivo'} envió la carta ${c.opCarta || ''} — ${c.cliente || ''}`,
          href: '/aprobaciones/?tab=revision',
          prioridad: 'alta', sonar: 1, son_tipo: 'dingdong',
        });
      }
      if (resuelta) {
        const [[u]] = await pool.query('SELECT id_usuario FROM usuarios WHERE email = ? LIMIT 1', [c.creadoPor]);
        if (u) {
          const ok = c.status === 'APROBADA';
          // Resolución → al ejecutivo, alta prioridad (también tiene al cliente esperando)
          await notificar([u.id_usuario], {
            tipo: 'CARTA_' + c.status,
            titulo: ok ? '✅ Carta aprobada' : '❌ Carta rechazada',
            mensaje: ok
              ? `Tu carta ${c.opCarta || ''} (${c.cliente || ''}) fue aprobada — ya puedes imprimirla`
              : `Tu carta ${c.opCarta || ''} fue rechazada${c.motivoRechazo ? ': ' + c.motivoRechazo : ''}. Corrígela y reenvíala.`,
            href: '/aprobaciones/',
            prioridad: 'alta', sonar: 1, son_tipo: ok ? 'dingdong' : 'alarma',
          });
        }
        const excs = Array.isArray(c.excepciones) ? c.excepciones.filter(Boolean).length : 0;
        auditar({ req, accion: c.status === 'APROBADA' ? 'APROBAR' : 'RECHAZAR', modulo: 'cartas', entidad: 'carta', entidad_id: c.id,
          detalle: `Carta de aprobación ${c.opCarta || ''} — ${c.cliente || ''} → ${c.status}`
            + (excs ? ` · ${excs} excepción(es)` : '')
            + (c.motivoRechazo ? ` · "${c.motivoRechazo}"` : ''),
          rut: c.rutCliente, meta: { excepciones: c.excepciones || [], excepciones_comentarios: c.excepcionesComentarios || null } });
      }
    } catch (e) { console.error('[cartas notif]', e.message); }
  })();
}

/* ── Carga masiva de Cartas de Aprobación (histórico) ──────────────────────────
   Por cada fila: genera op_carta = YY + N°ID + iniciales ejecutivo; enlaza al crédito
   por N° OPERACIÓN si existe (respeta sus datos), o crea cliente+crédito (YYMMxxx) si falta. */
const _inicEjec = (nombre) => {
  const w = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  return ((w[0]?.[0] || '') + (w[1]?.[0] || '')).toUpperCase();
};
const _normRut = (r) => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();
const _num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return isNaN(n) ? null : Math.round(n); };
async function _numeroCreditoMes(yy, mm) {
  const prefix = `${yy}${mm}`;
  const [[row]] = await pool.query(
    `SELECT numero_credito FROM creditos WHERE numero_credito LIKE ? ORDER BY numero_credito DESC LIMIT 1`, [prefix + '%']);
  const seq = row && /^\d+$/.test(row.numero_credito.slice(4)) ? parseInt(row.numero_credito.slice(4)) + 1 : 1;
  return prefix + String(seq).padStart(3, '0');
}

const cargaMasivaCartas = async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ success: false, data: null, error: 'Sin filas para cargar' });
    const u = req.usuario || {};
    const creadoPor = u.email || 'carga-masiva';
    const creadoPorNombre = ((u.nombre || '') + ' ' + (u.apellido || '')).trim() || 'Carga Masiva';
    const finMap = { AUTOFIN: 'AUTOFIN', AUTOFACIL: 'AUTOFACIL', UNIDAD: 'UNIDAD DE CREDITO', 'UNIDAD DE CREDITO': 'UNIDAD DE CREDITO' };

    let creadas = 0, omitidas = 0, enlazadas = 0, creditosCreados = 0, clientesCreados = 0;
    const errores = [];

    for (const r of rows) {
      try {
        const nId = String(r.nId || '').trim();
        const ejec = String(r.ejecutivo || '').trim();
        const nOp = String(r.nOp || '').trim();
        if (!nId || !ejec) { errores.push({ nOp, error: 'Falta N° ID o ejecutivo' }); continue; }

        const fecha = r.mes ? new Date(r.mes) : null;
        const valida = fecha && !isNaN(fecha);
        const yy = String(valida ? fecha.getFullYear() : new Date().getFullYear()).slice(-2);
        const mm = String((valida ? fecha.getMonth() : new Date().getMonth()) + 1).padStart(2, '0');
        const fechaISO = valida ? fecha.toISOString().slice(0, 10) : null;
        const opCarta = `${yy}${nId}${_inicEjec(ejec)}`;

        const [[ya]] = await pool.query('SELECT id FROM cartas_aprobacion WHERE op_carta=? LIMIT 1', [opCarta]);
        if (ya) { omitidas++; continue; }

        const rutCli = _normRut(r.rutCliente);
        const rutConc = _normRut(r.rutConc);
        const saldo = _num(r.saldo);
        const comision = _num(r.comision);
        const financiera = finMap[String(r.acreedor || '').toUpperCase()] || 'AUTOFACIL';

        // Enlazar a crédito existente por N° OPERACIÓN, o crear cliente+crédito
        let idCredito = null, numeroCredito = null, veh = {};
        let credito = null;
        if (nOp) { const [[cr]] = await pool.query('SELECT * FROM creditos WHERE num_op=? LIMIT 1', [nOp]); credito = cr || null; }
        if (credito) {
          idCredito = credito.id;
          numeroCredito = credito.numero_credito || null;
          veh = { tipo_vehiculo: credito.tipo_vehiculo, marca: credito.marca, modelo: credito.modelo,
                  anio: credito.anio, patente: credito.patente, precio: credito.valor_vehiculo,
                  pie: credito.pie, plazo: credito.plazo };
          enlazadas++;
        } else {
          let idCliente = null;
          if (rutCli) {
            const [[clx]] = await pool.query('SELECT id_cliente FROM clientes WHERE rut=? LIMIT 1', [rutCli]);
            if (clx) idCliente = clx.id_cliente;
            else { const [ci] = await pool.query('INSERT INTO clientes (rut, nombre_completo) VALUES (?,?)', [rutCli, r.cliente || null]); idCliente = ci.insertId; clientesCreados++; }
          }
          numeroCredito = await _numeroCreditoMes(yy, mm);
          const [ci] = await pool.query(
            `INSERT INTO creditos (numero_credito, num_op, financiera, estado_eval, estado, id_cliente,
               rut_dealer, vendedor, fecha_otorgado, mes, saldo_precio, automotora, ejecutivo, comdea_real, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW())`,
            [numeroCredito, nOp || null, financiera, 'OTORGADO', 'INGRESO', idCliente,
             rutConc || null, r.vendedor || null, fechaISO, valida ? fechaISO.slice(0, 7) + '-01' : null,
             saldo, r.concesionario || null, ejec, comision]);
          idCredito = ci.insertId; creditosCreados++;
          // Participación de la carta distinta al cálculo → comdea_real forzado
          if (comision != null && String(comision).trim() !== '') {
            try { await marcarForzadosCalculo(idCredito, { campos: ['comdea_real'] }); }
            catch (e) { console.error('[forzados carta bulk]', e.message); }
          }
        }

        await pool.query(
          `INSERT INTO cartas_aprobacion
             (op_carta, id_financiera, ejecutivo, cliente, rut_cliente,
              tipo_vehiculo, marca, modelo, anio, patente, precio_venta, pie, saldo, plazo,
              acreedor, nombre_dealer, rut_dealer, vendedor, part_bruto, fecha,
              creado_por, creado_por_nombre, status, otorgado, fecha_otorgado, fecha_aprobacion,
              numero_credito_creado, id_credito_creado)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [opCarta, nId, ejec, r.cliente || null, rutCli || null,
           veh.tipo_vehiculo || null, veh.marca || null, veh.modelo || null, veh.anio || null, veh.patente || null,
           veh.precio || null, veh.pie || null, saldo, veh.plazo || null,
           r.acreedor || null, r.concesionario || null, rutConc || null, r.vendedor || null, comision, fechaISO,
           creadoPor, creadoPorNombre, 'APROBADA', 1, fechaISO, fechaISO,
           numeroCredito, idCredito]);
        creadas++;
      } catch (eRow) { errores.push({ nOp: r.nOp, error: eRow.message }); }
    }
    res.json({ success: true, data: { total: rows.length, creadas, enlazadas, creditosCreados, clientesCreados, omitidas, errores }, error: null });
  } catch (e) {
    console.error('[cartas cargaMasiva]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── Documentos Unidad: parseo (autocompletar) + almacenamiento (revisión) ──
   La Carta Compromiso de pago trae la mayoría de los datos; la Cotización
   confirma N° de operación y cifras. Ambos PDF se guardan asociados a la carta
   para que el Analista de Crédito los revise al recibir la solicitud. */
const _numU   = v => { const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10); return isNaN(n) ? null : n; };
const _fechaU = s => { const m = String(s || '').match(/(\d{2})-(\d{2})-(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
function _splitNombre(full) {
  const t = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (t.length >= 4) return { nombres: t.slice(0, t.length - 2).join(' '), apPaterno: t[t.length - 2], apMaterno: t[t.length - 1] };
  if (t.length === 3) return { nombres: t[0], apPaterno: t[1], apMaterno: t[2] };
  if (t.length === 2) return { nombres: t[0], apPaterno: t[1], apMaterno: '' };
  return { nombres: full || '', apPaterno: '', apMaterno: '' };
}
function parseCartaCompromiso(t) {
  const g = (re, i = 1) => { const m = t.match(re); return m ? String(m[i]).trim() : null; };
  const nombre = g(/Nombre:\s*([^\n]+)/), sp = _splitNombre(nombre);
  return {
    opOrigen:        g(/N° Operación\s*\n?\s*(\d{4,})/),
    fecha:           _fechaU(g(/Fecha:\s*(\d{2}-\d{2}-\d{4})/)),
    rutCliente:      g(/Rut:\s*([\d.]+-[\dkK])/),
    nombre, nombres: sp.nombres, apPaterno: sp.apPaterno, apMaterno: sp.apMaterno,
    plazo:           _numU(g(/Número de cuotas:\s*(\d+)/)),
    saldo:           _numU(g(/Saldo precio:\s*([\d.]+)/)),
    tasaCredito:     (g(/Tasa de interés Nominal:\s*([\d,]+)/) || '').replace(',', '.') || null,
    montoCreditoCLP: _numU(g(/Total a pagar:\s*([\d.]+)/)),
    concesionario:   g(/Dealers:\s*([^\n]+?)Sucursal/),
    vendedor:        g(/F&I:\s*([^\n]+?)Ejecutivo/),
    patente:         g(/placa patente\s+([A-Z0-9]+)\s+Marca/),
    marca:           g(/Marca\s+([A-ZÁÉÍÓÚ]+)\s*,/),
    modelo:          g(/Modelo\s+([A-ZÁÉÍÓÚ0-9 ]+?)\s*,\s*año/),
    anio:            g(/año\s+(\d{4})/),
    precioVenta:     _numU(g(/precio de venta[^$]*\$\s*([\d.]+)/)),
    pie:             _numU(g(/pie entregado[^$]*\$\s*([\d.]+)/)),
    partBruto:       _numU(g(/Participación\s*\$\s*([\d.]+)\s*IVA/)),
    rutConc:         (g(/RUT\s+([\d,]+-[\dkK])/) || '').replace(/,/g, '.').toUpperCase() || null,
    acreedor:        /Unidad Cr[eé]ditos/i.test(t) ? 'UNIDAD DE CREDITO' : null,
  };
}
function parseCotizacion(t) {
  const g = (re, i = 1) => { const m = t.match(re); return m ? String(m[i]).trim() : null; };
  return {
    opOrigen: g(/N°\s*0*(\d{4,})/),
    cae:      g(/CAE\s*::\s*([\d,]+)\s*%/),
    titular:  g(/Titular[\s\S]*?::\s*([A-ZÁÉÍÓÚÑ ]+?)\s*\n/),
  };
}
// Carta de Aprobación Autofin (formato 2 columnas; pdf-parse lo aplana → anclas por contexto).
function parseCartaAutofin(t) {
  const g = (re, i = 1) => { const m = t.match(re); return m ? String(m[i]).trim() : null; };
  const nameOp = t.match(/\n([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ ]{5,}?)\n(\d{6,8})\n:/);   // nombre cliente + N° crédito
  const nombre = nameOp ? nameOp[1].trim() : null, sp = _splitNombre(nombre);
  const tasaRaw = g(/\n(\d{1,2},\d{3,6})\n/);
  const cuadro = (t.match(/CUADRO DE PAGO([\s\S]*?)(?:DOCUMENTOS|$)/i) || [, ''])[1];
  const plazo = (cuadro.match(/\d{2}\/\d{2}\/\d{4}/g) || []).length || null;   // 1 fecha de vencimiento por cuota
  const precioVenta = _numU(g(/([\d.]+)\n\d{7,8}-[\dkK]/));        // valor antes del RUT
  const pie = _numU(g(/([\d.]+)\s*\(\d{1,3},\d{1,2}\s*%\)/));      // el monto con % es el PIE (producto "70% PIE")
  const saldo = (precioVenta != null && pie != null) ? Math.max(0, precioVenta - pie) : null;  // saldo precio = monto solicitado
  // Total pagaré (monto del crédito) = valor tras el RUT y el saldo (en el PDF va pegado al total de recargos).
  const totalPagare = _numU(g(/\d{7,8}-[\dkK]\n[\d.]+\n(\d{1,3}(?:\.\d{3})+)/));
  const fechaRaw = g(/(\d{2}\/\d{2}\/\d{4})/);
  return {
    opOrigen: nameOp ? nameOp[2] : null,
    fecha: fechaRaw ? fechaRaw.split('/').reverse().join('-') : null,
    rutCliente: g(/(\d{7,8}-[\dkK])/),
    nombre, nombres: sp.nombres, apPaterno: sp.apPaterno, apMaterno: sp.apMaterno,
    marca: g(/\n([A-ZÁÉÍÓÚ]{3,})\n(?::\n)+[\d.]+\n\d{7,8}-/),
    modelo: g(/\n([A-Z0-9][A-Z0-9 ]{0,11})\nModelo\n/),
    anio: g(/\n(\d{4})\n:?Año/),
    patente: g(/PPU\s+([A-Z]{4}\d{2}|[A-Z]{2}\d{4})/),
    precioVenta, pie, saldo, plazo,
    tasaCredito: tasaRaw ? Number(tasaRaw.replace(',', '.')).toFixed(2) : null,
    montoCreditoCLP: totalPagare != null ? totalPagare : saldo,
    ejecutivo: g(/\n([A-ZÁÉÍÓÚ][A-ZÁÉÍÓÚ ]+?) \(AFA\)\n/),
    acreedor: 'AUTOFIN',
  };
}
const _toBuf = b64 => Buffer.from(String(b64).replace(/^data:[^;]+;base64,/, ''), 'base64');

// POST /api/cartas/parse-unidad → extrae campos sin guardar (autocompletar)
const parseUnidad = async (req, res) => {
  try {
    const { compromiso_base64, cotizacion_base64 } = req.body || {};
    if (!compromiso_base64 && !cotizacion_base64)
      return res.status(400).json({ success: false, data: null, error: 'Adjunta al menos un documento' });
    const out = { warnings: [] };
    if (compromiso_base64) {
      try { out.compromiso = parseCartaCompromiso((await pdf(_toBuf(compromiso_base64))).text); }
      catch (e) { out.warnings.push('No se pudo leer la Carta Compromiso: ' + e.message); }
    }
    if (cotizacion_base64) {
      try { out.cotizacion = parseCotizacion((await pdf(_toBuf(cotizacion_base64))).text); }
      catch (e) { out.warnings.push('No se pudo leer la Cotización: ' + e.message); }
    }
    const c = out.compromiso || {}, q = out.cotizacion || {};
    out.fields = {
      opOrigen: c.opOrigen || q.opOrigen || null, fecha: c.fecha || null, rutCliente: c.rutCliente || null,
      nombres: c.nombres || null, apPaterno: c.apPaterno || null, apMaterno: c.apMaterno || null,
      acreedor: c.acreedor || 'UNIDAD DE CREDITO',
      marca: c.marca || null, modelo: c.modelo || null, anio: c.anio || null, patente: c.patente || null,
      precioVenta: c.precioVenta || null, pie: c.pie || null, saldo: c.saldo || null,
      plazo: c.plazo || null, tasaCredito: c.tasaCredito || null, montoCreditoCLP: c.montoCreditoCLP || null,
      partBruto: c.partBruto || null,
      concesionario: c.concesionario || null, rutConc: c.rutConc || null, vendedor: c.vendedor || null,
    };
    if (c.opOrigen && q.opOrigen && c.opOrigen !== q.opOrigen)
      out.warnings.push(`El N° de operación no coincide: Carta ${c.opOrigen} vs Cotización ${q.opOrigen}`);
    res.json({ success: true, data: out, error: null });
  } catch (e) { console.error('[parseUnidad]', e.message); res.status(500).json({ success: false, data: null, error: 'No se pudo procesar el documento' }); }
};

// POST /api/cartas/parse-autofin → extrae campos de la Carta de Aprobación Autofin
const parseAutofin = async (req, res) => {
  try {
    const b64 = req.body && (req.body.carta_base64 || req.body.compromiso_base64);
    if (!b64) return res.status(400).json({ success: false, data: null, error: 'Adjunta la Carta de Aprobación (PDF)' });
    const out = { warnings: [] };
    try { out.carta = parseCartaAutofin((await pdf(_toBuf(b64))).text); }
    catch (e) { return res.status(422).json({ success: false, data: null, error: 'No se pudo leer la carta: ' + e.message }); }
    const c = out.carta || {};
    out.fields = {
      opOrigen: c.opOrigen || null, fecha: c.fecha || null, rutCliente: c.rutCliente || null,
      nombres: c.nombres || null, apPaterno: c.apPaterno || null, apMaterno: c.apMaterno || null,
      acreedor: 'AUTOFIN',
      marca: c.marca || null, modelo: c.modelo || null, anio: c.anio || null, patente: c.patente || null,
      precioVenta: c.precioVenta || null, pie: c.pie || null, saldo: c.saldo || null,
      plazo: c.plazo || null, tasaCredito: c.tasaCredito || null, montoCreditoCLP: c.montoCreditoCLP || null,
      ejecutivo: c.ejecutivo || null,
    };
    res.json({ success: true, data: out, error: null });
  } catch (e) { console.error('[parseAutofin]', e.message); res.status(500).json({ success: false, data: null, error: 'No se pudo procesar la carta' }); }
};

// POST /api/cartas/:id/documentos → guarda el PDF asociado a la carta
const subirDocumento = async (req, res) => {
  try {
    const idCarta = parseInt(req.params.id, 10) || null;
    const { tipo, nombre, mime, data_base64, extracted } = req.body || {};
    if (!data_base64) return res.status(400).json({ success: false, data: null, error: 'Archivo requerido' });
    if (!['COMPROMISO_UNIDAD', 'COTIZACION_UNIDAD', 'CARTA_AUTOFIN'].includes(String(tipo)))
      return res.status(400).json({ success: false, data: null, error: 'Tipo de documento inválido' });
    const buf = _toBuf(data_base64);
    if (!buf.length) return res.status(400).json({ success: false, data: null, error: 'Archivo vacío' });
    if (buf.length > 12 * 1024 * 1024) return res.status(413).json({ success: false, data: null, error: 'Máximo 12 MB por archivo' });
    if (idCarta) await pool.query('DELETE FROM cartas_documentos WHERE id_carta=? AND tipo=?', [idCarta, tipo]); // re-subida: reemplaza
    const [r] = await pool.query(
      `INSERT INTO cartas_documentos (id_carta, tipo, nombre, mime, tamano, data, extracted, subido_por, id_subido_por)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [idCarta, tipo, nombre || 'documento.pdf', mime || 'application/pdf', buf.length, buf,
       extracted ? JSON.stringify(extracted) : null, req.usuario?.email || null, req.usuario?.id_usuario || null]);
    res.status(201).json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) { console.error('[subirDocumento]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// GET /api/cartas/:id/documentos → lista (sin blob)
const listarDocumentos = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT id, tipo, nombre, mime, tamano, created_at FROM cartas_documentos WHERE id_carta=? ORDER BY tipo', [req.params.id]);
    res.json({ success: true, data: rows, error: null });
  } catch (e) { console.error('[listarDocumentos]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

// GET /api/cartas/documentos/:docId → stream inline del PDF
const verDocumento = async (req, res) => {
  try {
    const [[d]] = await pool.query('SELECT nombre, mime, data FROM cartas_documentos WHERE id=?', [req.params.docId]);
    if (!d || !d.data) return res.status(404).json({ success: false, data: null, error: 'Documento no encontrado' });
    const fname = String(d.nombre || 'documento.pdf');
    const safe = fname.replace(/"/g, '').replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', d.mime || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(d.data);
  } catch (e) { console.error('[verDocumento]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getAll, upsert, otorgar, desistir, getVigencia, setVigencia, rentabilidadTier, cargaMasivaCartas, parseUnidad, parseAutofin, subirDocumento, listarDocumentos, verDocumento };
