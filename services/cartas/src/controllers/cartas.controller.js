'use strict';
const pool = require('../../../../shared/config/database');
const RUT = require('../../../../api-gateway/public/js/rut-core');  // enforcement: RUT canónico
const { notificar } = require('../../../notificaciones/src/controllers/notificaciones.controller');
const { auditar } = require('../../../../shared/audit');
const almacen = require('../../../../shared/almacen-docs');
const { publicarAnuncio } = require('../../../../shared/anuncios');
const { marcarForzadosCalculo, recalcularPorOps } = require('../../../creditos/src/utils/recalcular-mes');
// Motor único de etapa: otorgar escribe las TRES columnas de una sola vez.
const { SET_ETAPA_SQL, valoresEtapa } = require('../../../../shared/etapa-credito');
const pdf = require('pdf-parse');

/* numero_credito (YYMM###) — motor único en shared/num-op.js. La versión
   robusta de esta función fue la que se llevó allá: era la única de las cuatro
   copias que resolvía la secuencia por MAX() y no por "el último por id". */
const { numeroCreditoCarta } = require('../../../../shared/num-op');
const generarNumeroCreditoDesdeCartas = () => numeroCreditoCarta();

/* Persiste en la CARTA las primas/gastos del documento de la financiera (los
   trae el autofill del PDF). Antes solo viajaban en el request y se perdían si
   el crédito ya existía. Fire & forget: no frena el guardado de la carta. */
function persistirPrimasCarta(idCarta, c) {
  if (!idCarta) return;
  if (c.segRdh === undefined && c.segDesgravamen === undefined && c.segCesantia === undefined
      && c.segRep === undefined && c.gps === undefined && c.gastos === undefined) return;
  const rdhT = (c.segRdh != null || c.segDesgravamen != null)
    ? (Number(c.segRdh || 0) + Number(c.segDesgravamen || 0)) : null;
  pool.query(`UPDATE cartas_aprobacion SET
      seg_rdh = COALESCE(?, seg_rdh), seg_cesantia = COALESCE(?, seg_cesantia),
      seg_rep = COALESCE(?, seg_rep), gps_monto = COALESCE(?, gps_monto),
      gastos_monto = COALESCE(?, gastos_monto) WHERE id = ?`,
    [rdhT, c.segCesantia != null ? Number(c.segCesantia) : null,
     c.segRep != null ? Number(c.segRep) : null,
     c.gps != null ? Number(c.gps) : null,
     c.gastos != null ? Number(c.gastos) : null, idCarta]
  ).catch(e => console.error('[carta primas persist]', e.message));
}

/* Sincroniza hacia el CRÉDITO enlazado lo que la carta sabe y el crédito no:
   dealer/parque, primas/GPS/gastos, plazo/tasa/vendedor. Solo RELLENA (COALESCE
   sobre NULL) — jamás pisa un dato ya digitado. Corre tanto al EDITAR la carta
   como al CREARLA ya enlazada a un crédito de carga masiva: ese segundo camino
   no sincronizaba NADA y las operaciones caían a "datos faltantes" (6189618,
   6189286) aunque la carta traía todo. */
function sincronizarCreditoDesdeCarta(c, idCred) {
  if (!idCred) return;
  // Dealer/parque corregidos en la carta → al crédito NO otorgado (caso 2607043:
  // guardaron con un dealer, corrigieron la carta y el crédito quedó con el viejo)
  if (c.concesionario || c.rutConc || c.rut_conc) {
    pool.query(`UPDATE creditos SET
        automotora = COALESCE(?, automotora), rut_dealer = COALESCE(?, rut_dealer),
        parque = COALESCE(?, parque), updated_at = NOW()
      WHERE id = ? AND estado_credito <> 'OTORGADO'`,
      [c.concesionario || null, (c.rutConc || c.rut_conc || null), (c.parque || null), idCred]
    ).catch(e => console.error('[carta→credito dealer]', e.message));
  }
  // Primas/GPS digitadas o corregidas en la carta → al crédito (0 explícito válido)
  if (c.segRdh !== undefined || c.segDesgravamen !== undefined || c.segCesantia !== undefined || c.segRep !== undefined || c.gps !== undefined || c.gastos !== undefined) {
    const rdhT = (c.segRdh != null || c.segDesgravamen != null) ? (Number(c.segRdh || 0) + Number(c.segDesgravamen || 0)) : null;
    const ces  = c.segCesantia != null ? Number(c.segCesantia) : null;
    const rep  = c.segRep != null ? Number(c.segRep) : null;
    const tot  = (rdhT != null || ces != null || rep != null) ? (Number(rdhT || 0) + Number(ces || 0) + Number(rep || 0)) : null;
    pool.query(`UPDATE creditos SET
        seguro_rdh = COALESCE(?, seguro_rdh), seguro_cesantia = COALESCE(?, seguro_cesantia),
        seguro_rep_menor = COALESCE(?, seguro_rep_menor), seguros = COALESCE(?, seguros),
        gps = COALESCE(?, gps), gastos = COALESCE(?, gastos), updated_at = NOW() WHERE id = ?`,
      [rdhT, ces, rep, tot, (c.gps != null ? Number(c.gps) : null),
       (c.gastos != null ? Number(c.gastos) : null), idCred]
    ).catch(e => console.error('[carta→credito primas]', e.message));
  }
  // Plazo/tasa/vendedor: la carta los trae; el crédito de carga masiva a veces no.
  // El vendedor del crédito solo se rellena si está vacío o es el placeholder
  // "VENDEDOR (AFA) …" (que es nuestro ejecutivo, no el vendedor del dealer).
  pool.query(`UPDATE creditos SET
      plazo = COALESCE(plazo, ?), tascli_real = COALESCE(tascli_real, ?),
      vendedor = CASE WHEN COALESCE(vendedor,'')='' OR UPPER(vendedor) LIKE 'VENDEDOR (AFA)%' OR UPPER(vendedor) LIKE 'VENDEDOR%PARQUE%'
                      THEN COALESCE(?, vendedor) ELSE vendedor END,
      updated_at = NOW() WHERE id = ?`,
    [c.plazo || null, (c.tasa_credito || c.tasaCredito || null), (c.vendedor || null), idCred]
  ).catch(e => console.error('[carta→credito datos]', e.message));
}

/* Crea registro en creditos a partir de una carta y devuelve { id, numero_credito } */
async function crearCreditoDesdeCartas(c) {
  const rutNorm = RUT.normalizar(c.rut_cliente || c.rutCliente) || (c.rut_cliente || c.rutCliente || '').replace(/\./g, '').toUpperCase().trim();
  let [[cliRow]] = await pool.query('SELECT id_cliente FROM clientes WHERE rut = ? LIMIT 1', [rutNorm]).catch(() => [[null]]);
  // Cliente nuevo de la carta: si aún no existe en `clientes`, se crea (rut + nombre) para que
  // el crédito quede vinculado y muestre RUT/nombre (antes id_cliente quedaba NULL → fila en blanco).
  if (!cliRow && rutNorm) {
    const nombre = (c.cliente || c.nombre_cliente || c.nombreCliente || '').trim();
    try {
      const [ins] = await pool.query(
        'INSERT INTO clientes (rut, nombre_completo) VALUES (?, ?) ON DUPLICATE KEY UPDATE id_cliente = LAST_INSERT_ID(id_cliente)',
        [rutNorm, nombre || null]);
      cliRow = { id_cliente: ins.insertId };
    } catch (e) { console.error('[carta→cliente]', e.message); }
  }
  const numero_credito = await generarNumeroCreditoDesdeCartas();
  // Mapear acreedor → financiera
  const finMap = { 'AUTOFIN': 'AUTOFIN', 'AUTOFACIL': 'AUTOFACIL', 'UNIDAD': 'UNIDAD DE CREDITO', 'UNIDAD DE CREDITO': 'UNIDAD DE CREDITO' };
  const financiera = finMap[(c.acreedor || '').toUpperCase()] || 'AUTOFACIL';
  const saldo = c.saldo || null;
  const precio = c.precio_venta || c.precioVenta || null;
  const pie = c.pie || null;
  const pct = (precio && saldo) ? saldo / precio : null;

  // Primas reales de la ficha AutoFin (si vinieron del escaneo): RDH incluye el
  // desgravamen (modelo 2026-07); 0 explícito = digitado (empresas sin seguros).
  const segRdhTot = (c.segRdh != null || c.segDesgravamen != null)
    ? (Number(c.segRdh || 0) + Number(c.segDesgravamen || 0)) : null;
  const segCes = c.segCesantia != null ? Number(c.segCesantia) : null;
  const segRep = c.segRep != null ? Number(c.segRep) : null;
  const segTotal = (segRdhTot != null || segCes != null || segRep != null)
    ? (Number(segRdhTot || 0) + Number(segCes || 0) + Number(segRep || 0)) : null;
  /* El correlativo se pide DENTRO de conNumOpAF: si otro otorgamiento gana la
     carrera y choca contra uq_num_op, reintenta con el siguiente número en vez
     de devolverle un 500 al usuario (auditoría 03-08-2026, A-8). */
  const { conNumOpAF } = require('../../../../shared/num-op');
  const r = await conNumOpAF(null, async (numOpAF) => {
  const [rIns] = await pool.query(`
    INSERT INTO creditos
      (numero_credito, num_op, financiera, id_financiera, estado_eval, estado,
       id_cliente, rut_dealer, vendedor,
       fecha_otorgado, mes, valor_vehiculo, pie, saldo_precio, pct_financiado,
       monto_financiado, plazo, tascli_real,
       seguro_rdh, seguro_cesantia, seguro_rep_menor, seguros, gps, gastos,
       tipo_vehiculo, marca, modelo, anio, patente,
       automotora, ejecutivo, comdea_real,
       created_at, updated_at)
    VALUES (?,?,?,?,
            'APROBADO','INGRESO',   -- nace de una carta APROBADA; estado_eval pasa a OTORGADO recién al otorgar (el dashboard clasifica por estado_eval)
            ?,?,?,
            NULL, DATE_FORMAT(NOW(),'%Y-%m-01'), ?,?,?,?,
            ?,?,?,
            ?,?,?,?,?,?,
            ?,?,?,?,?,
            ?,?,?,
            NOW(),NOW())
  `, [
    /* num_op = correlativo AutoFácil desde que nace (motor único shared/num-op.js,
       regla ago-2026). numero_credito (YYMM###) sigue siendo el N° interno del
       crédito de carta; la OP es la serie única del negocio. */
    numero_credito, numOpAF, financiera,
    // ID de la operación en la financiera: el frontend lo manda como opOrigen
    (c.id_financiera ?? c.idFinanciera ?? c.opOrigen ?? c.op_origen ?? null),
    cliRow?.id_cliente || null,
    (c.rut_conc || c.rutConc || null),
    (c.vendedor || null),
    precio, pie, saldo, pct,
    (c.monto_credito_clp || c.montoCreditoCLP || null),
    (c.plazo || null),
    (c.tasa_credito || c.tasaCredito || null),
    segRdhTot, segCes, segRep, segTotal, (c.gps != null ? Number(c.gps) : null),
    (c.gastos != null ? Number(c.gastos) : null),
    (c.tipo_vehiculo || c.tipoVehiculo || null),
    (c.marca || null), (c.modelo || null), (c.anio || null), (c.patente || null),
    (c.concesionario || null),
    /* Ejecutivo en MAYÚSCULAS: los agrupados (dashboard, comisiones, rankings)
       agrupan por texto exacto — un "Fernando Contreras" digitado así en la
       carta partía al ejecutivo en dos y su conteo del mes salía corto. */
    (c.ejecutivo_nombre || c.ejecutivoNombre ? String(c.ejecutivo_nombre || c.ejecutivoNombre).trim().toUpperCase() : null),
    (c.part_bruto || c.partBruto || null),
  ]);
    return rIns;
  });
  // Parque/Calle desde el mantenedor de dealers (por RUT): la carta no lo trae y
  // dejaba el campo vacío en la cola de digitación (mismo criterio de dealerBuscar).
  try {
    const rutD = (c.rut_conc || c.rutConc || '').trim();
    if (rutD) {
      const rd = rutD.replace(/\D/g, '');
      const [[dl]] = await pool.query(
        `SELECT ccs_parque FROM dealers WHERE REPLACE(REPLACE(REPLACE(rut,'.',''),'-',''),' ','') = ? LIMIT 1`, [rd]);
      if (dl && dl.ccs_parque) {
        const t = String(dl.ccs_parque).toUpperCase();
        const tipoU = t.includes('PARQUE') ? 'PARQUE' : 'CALLE';
        await pool.query('UPDATE creditos SET tipo_ubicacion=?, parque=COALESCE(NULLIF(parque,\'\'), ?) WHERE id=?',
          [tipoU, tipoU, r.insertId]);
      }
    }
  } catch (e) { console.error('[carta→parque]', e.message); }
  // La participación de la carta (part_bruto) es una negociación especial: si difiere
  // del cálculo, comdea_real queda forzado (no se sobrescribe en el recálculo).
  const partCarta = c.part_bruto ?? c.partBruto;
  if (partCarta != null && String(partCarta).trim() !== '') {
    try { await marcarForzadosCalculo(r.insertId, { campos: ['comdea_real'] }); }
    catch (e) { console.error('[forzados carta]', e.message); }
  }
  return { id: r.insertId, numero_credito };
}

/* Quién recibe los avisos de cartas: se define en el mantenedor Avisos
   (/mantenedores/avisos/), no acá. Antes era una query fija "Administrador +
   permiso aprob_revisar", que metía en el pool a las cuentas de servicio y no
   se podía ajustar sin tocar código. */
const AVISOS = require('../../../../shared/avisos');
AVISOS.registrarAviso({
  evento: 'carta_nueva', nombre: 'Nueva carta para revisión', modulo: 'Cartas',
  descripcion: 'Un ejecutivo envía una carta al pool (o reenvía una corregida). Avisa a quien deba revisarla.',
  base_func: 'aprob_revisar', prioridad: 'alta', sonido_tipo: 'dingdong',
});
AVISOS.registrarAviso({
  evento: 'carta_resuelta', nombre: 'Carta aprobada o rechazada', modulo: 'Cartas',
  descripcion: 'Avisa al ejecutivo que creó la carta cuando se resuelve. Siempre le llega a él; acá se agregan otros que quieran enterarse.',
  base_func: null, incluir_admin: 0, prioridad: 'alta', sonido_tipo: 'dingdong',
});

/* id del usuario dueño de un correo (para excluirlo o avisarle) */
async function idPorEmail(email) {
  if (!email) return null;
  try {
    const [[u]] = await pool.query('SELECT id_usuario FROM usuarios WHERE email = ? LIMIT 1', [email]);
    return u ? u.id_usuario : null;
  } catch (e) { return null; }
}

// Auto-migración: crea tablas si no existen
// Fallback IA: cuando el PDF de la financiera viene escaneado (sin capa de texto),
// Haiku lo lee con visión. Gobernado desde el mantenedor Subsistema IA (nace apagada).
require('../../../../shared/migrate').enFila('cartas-ia-ocr', async () => {
  await require('../../../../shared/ia').registrarFuncionalidad({
    codigo: 'cartas_pdf_ia',
    nombre: 'Lectura IA de PDFs escaneados (cartas)',
    descripcion: 'Cuando la Carta Compromiso / Cotización de Unidad o la Carta de Aprobación AutoFin llega escaneada (imagen sin texto), Haiku extrae los campos con visión para el autocompletar del Generador de Cartas. El ejecutivo siempre revisa antes de guardar.',
    modelo: 'claude-haiku-4-5',
  });
});

require('../../../../shared/migrate').enFila('cartas', async () => {
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
    // Código de excepción del Simulador (fase 3): sella la aprobación automática
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS codigo_excepcion VARCHAR(10) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS codigo_excepcion_tipo VARCHAR(10) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS desistido_auto TINYINT(1) NOT NULL DEFAULT 0`);
    // Snapshot del TIER UAC vigente al emitir la carta (para la rentabilidad). Se puede recalcular por mes.
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS tier_uac_n INT DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS tier_uac_pct DECIMAL(6,3) DEFAULT NULL`);
    /* Primas y gastos de la carta de la financiera (v168.2): el autofill del PDF
       los extraía pero la carta NO los guardaba — si el crédito ya existía (carga
       masiva), las primas se PERDÍAN y la operación caía a "datos faltantes".
       La carta es el documento que las trae: ahora las persiste y las sincroniza. */
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS seg_rdh DECIMAL(12,2) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS seg_cesantia DECIMAL(12,2) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS seg_rep DECIMAL(12,2) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS gps_monto DECIMAL(12,2) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS gastos_monto DECIMAL(12,2) DEFAULT NULL`);
    /* Corrección de Cartas de Aprobación: la corrección NO edita la carta emitida —
       emite una carta NUEVA (sufijo -C1, -C2…) y deja la anterior en REEMPLAZADA
       apuntando a su reemplazo. Estas columnas son la cadena entre ambas. */
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS reemplazada_por_id INT DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS reemplazada_por_op VARCHAR(40) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS corrige_a_id INT DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS corrige_a_op VARCHAR(40) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS correccion_n INT NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS motivo_correccion VARCHAR(400) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS corregida_por_nombre VARCHAR(200) DEFAULT NULL`);
    await pool.query(`ALTER TABLE cartas_aprobacion ADD COLUMN IF NOT EXISTS fecha_correccion_carta DATETIME DEFAULT NULL`);
    // Dónde vive el PDF adjunto (shared/almacen-docs.js): 161 documentos = 10,5 MB.
    for (const ddl of almacen.sqlColumnas('cartas_documentos')) {
      try { await pool.query(ddl); } catch (e) { if (e.errno !== 1060) console.error('[cartas docs almacen]', e.message); }
    }
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
  // Casilla "Corregir dealer de carta aprobada" — por defecto SOLO Administrador
  try {
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='aprob_corregir_dealer'");
    if (!ex) {
      const [[mod]] = await pool.query(
        "SELECT f.id_modulo FROM funcionalidades f WHERE f.codigo='aprob_crear' LIMIT 1");
      if (mod) {
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href) VALUES (?,?,?,NULL)',
          [mod.id_modulo, 'Corregir dealer de carta aprobada', 'aprob_corregir_dealer']);
        await pool.query(
          `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
           SELECT id_perfil, ?, IF(nombre='Administrador',1,0) FROM perfiles`, [ins.insertId]);
        console.log('✓ funcionalidad aprob_corregir_dealer creada (solo Admin)');
      }
    }
  } catch (e) { console.error('[cartas seed corregir-dealer]', e.message); }
  /* Módulo "Corrección Cartas de Aprobación": card + permiso, ambos en BD (anti-hardcode).
     Por defecto SOLO Administrador — reemplaza un documento ya emitido y firmado. */
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM funcionalidades WHERE codigo='aprob_crear' LIMIT 1");
    if (mod) {
      const alta = async (nombre, codigo, href, icono) => {
        const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=?', [codigo]);
        if (ex) return;
        const [ins] = await pool.query(
          'INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [mod.id_modulo, nombre, codigo, href, icono]);
        await pool.query(
          `INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
           SELECT id_perfil, ?, IF(nombre='Administrador',1,0) FROM perfiles`, [ins.insertId]);
        console.log(`✓ funcionalidad ${codigo} creada (solo Admin)`);
      };
      await alta('Corrección Cartas de Aprobación', 'aprob_corregir_carta', '/cartas-correccion/', 'bi-pencil-square');
    }
  } catch (e) { console.error('[cartas seed corregir-carta]', e.message); }
});

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
    codigoExcepcion:          r.codigo_excepcion || null,
    codigoExcepcionTipo:      r.codigo_excepcion_tipo || null,
    revisionAuto:             parseJSON(r.revision_auto),
    numeroCreditoCreado:      r.numero_credito_creado || null,
    idCreditoCreado:          r.id_credito_creado || null,
    // Cadena de corrección (solo lectura: upsert usa lista explícita de columnas, no vuelven a la BD)
    reemplazadaPorId:         r.reemplazada_por_id || null,
    reemplazadaPorOp:         r.reemplazada_por_op || null,
    corrigeAId:               r.corrige_a_id || null,
    corrigeAOp:               r.corrige_a_op || null,
    correccionN:              r.correccion_n || 0,
    motivoCorreccion:         r.motivo_correccion || null,
    corregidaPorNombre:       r.corregida_por_nombre || null,
    fechaCorreccionCarta:     r.fecha_correccion_carta || null,
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
    // Parámetros de AMBOS modelos + cuál está activo — motor único uac-tier.js
    const [pr] = await pool.query(
      "SELECT clave, valor FROM parametros_credito WHERE clave LIKE 'uac%'");
    const P = {}; pr.forEach(r => { P[r.clave] = parseFloat(r.valor); });
    const ref = fechaRef ? new Date(fechaRef) : new Date();
    const ym = isNaN(ref) ? null : `${ref.getFullYear()}-${String(ref.getMonth() + 1).padStart(2, '0')}`;
    let count = 0;
    if (ym) {
      const [[c]] = await pool.query(
        "SELECT COUNT(*) n FROM creditos WHERE financiera='UNIDAD DE CREDITO' AND fecha_otorgado IS NOT NULL AND DATE_FORMAT(fecha_otorgado,'%Y-%m')=?", [ym]);
      count = c.n || 0;
    }
    const { tierUACInfo } = require('../../../creditos/src/utils/uac-tier');
    const { n, pct } = tierUACInfo(count, P);
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
  // Estado propio VENCIDA (distinto de DESISTIDA, que es baja manual). El plazo corre desde la
  // FECHA de la carta (dato de negocio). Aplica a pendientes y aprobadas aún no otorgadas.
  const [r] = await pool.query(
    `UPDATE cartas_aprobacion
        SET status='VENCIDA', desistido_auto=1, fecha_desistimiento=NOW(),
            motivo_desistimiento=CONCAT('Vencida automáticamente (', ?, ' días corridos desde la fecha de la carta).')
      WHERE status IN ('PENDIENTE','APROBADA') AND otorgado=0 AND fecha IS NOT NULL
        AND DATE_ADD(DATE(fecha), INTERVAL ? DAY) < CURDATE()`, [dias, dias]);
  if (r.affectedRows) {
    await pool.query(
      `UPDATE creditos cr JOIN cartas_aprobacion ca ON ca.id_credito_creado = cr.id
          SET cr.estado='DESISTIDO', cr.updated_at=NOW()
        WHERE ca.status='VENCIDA' AND ca.desistido_auto=1 AND cr.estado='CARTA_APROBACION'`).catch(()=>{});
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

/* GET /api/cartas/:id/ficha — TODO lo que se digitó al crear la carta.
   Existe aparte del listado a propósito: la carta impresa va al dealer y solo muestra
   lo que a él le corresponde, mientras que el revisor necesita ver la ficha completa
   (tasa, monto del crédito, primas de seguros, GPS, gastos, excepciones, trazabilidad).
   Es de SOLO LECTURA y no se suma a mapCarta() porque ese objeto se re-envía por POST
   al aprobar, y devolver aquí las primas haría que se reescribieran en el crédito. */
const fichaCompleta = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, data: null, error: 'ID inválido.' });
    const [[r]] = await pool.query('SELECT * FROM cartas_aprobacion WHERE id=? LIMIT 1', [id]);
    if (!r) return res.status(404).json({ success: false, data: null, error: 'Carta no encontrada.' });
    const num = v => v == null || v === '' ? null : Number(v);
    res.json({ success: true, error: null, data: {
      // Identificación
      opCarta: r.op_carta, idFinanciera: r.id_financiera, tipo: r.tipo, acreedor: r.acreedor,
      fecha: r.fecha, status: r.status,
      // Ejecutivo
      ejecutivo: r.ejecutivo, ejecutivoMail: r.ejecutivo_mail, ejecutivoTel: r.ejecutivo_tel,
      // Cliente
      cliente: r.cliente, rutCliente: r.rut_cliente,
      // Vehículo
      tipoVehiculo: r.tipo_vehiculo, marca: r.marca, modelo: r.modelo, anio: r.anio,
      patente: r.patente, prenda: r.prenda,
      // Operación
      precioVenta: num(r.precio_venta), pie: num(r.pie), saldo: num(r.saldo), plazo: num(r.plazo),
      tasaCredito: num(r.tasa_credito), montoCreditoCLP: num(r.monto_credito_clp), montoCreditoUF: num(r.monto_credito_uf),
      // Primas y accesorios (NO van en la carta al dealer)
      segRdh: num(r.seg_rdh), segCesantia: num(r.seg_cesantia), segRep: num(r.seg_rep),
      gps: num(r.gps_monto), gastos: num(r.gastos_monto),
      // Dealer y comisión
      parque: r.parque, nombreDealer: r.nombre_dealer, rutDealer: r.rut_dealer, vendedor: r.vendedor,
      partNeto: num(r.part_neto), partIVA: num(r.part_iva), partBruto: num(r.part_bruto),
      tierUacN: num(r.tier_uac_n), tierUacPct: num(r.tier_uac_pct),
      // Excepciones
      excepciones: parseJSON(r.excepciones) || [], excepcionesComentarios: parseJSON(r.excepciones_comentarios),
      codigoExcepcion: r.codigo_excepcion, codigoExcepcionTipo: r.codigo_excepcion_tipo,
      // Trazabilidad
      fechaCreacion: r.fecha_creacion, creadoPorNombre: r.creado_por_nombre,
      aprobadoPorNombre: r.aprobado_por_nombre, fechaAprobacion: r.fecha_aprobacion,
      comentarioAprobacion: r.comentario_aprobacion,
      rechazadoPorNombre: r.rechazado_por_nombre, fechaRechazo: r.fecha_rechazo, motivoRechazo: r.motivo_rechazo,
      fechaCorreccion: r.fecha_correccion, corregidoPor: r.corregido_por,
      otorgado: !!r.otorgado, fechaOtorgado: r.fecha_otorgado,
      numeroCreditoCreado: r.numero_credito_creado,
    } });
  } catch (e) { console.error('[cartas ficha]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
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
      // Participación PACTADA de la carta: al otorgar manda sobre el cálculo. Concilia
      // creditos.comdea_real = part_bruto para que el dashboard (lee comdea_real) y la
      // cartola (usa COALESCE(part_bruto, comdea_real)) muestren el MISMO monto. Solo si
      // la carta trae part_bruto (>0); si no, se respeta el comdea_real del motor.
      const partB = Number(ca.part_bruto) || 0;
      if (cond.length) {
        await pool.query(
          `UPDATE creditos SET ${SET_ETAPA_SQL},
                  fecha_otorgado=COALESCE(fecha_otorgado, CURDATE()),
                  comdea_real = CASE WHEN ? > 0 THEN ? ELSE comdea_real END, updated_at=NOW()
            WHERE (${cond.join(' OR ')})
              AND (estado IN ('CARTA_APROBACION','APROBADO','INGRESO','DIGITADO')
                   /* Créditos de carga masiva: estado NULL, el estado vive en estado_credito.
                      Sin esta rama, otorgar la carta no movía la operación a OTORGADO. */
                   OR (estado IS NULL AND COALESCE(estado_credito,'') IN ('APROBADO','DIGITADO','PENDIENTE')))`,
          [...valoresEtapa('OTORGADO'), partB, partB, ...args]
        ).catch(e => console.error('[carta otorgar→credito]', e.message));
        // El crédito de la carta nace sin num_op → correlativo AutoFácil (motor único).
        try {
          const [[sinOp]] = await pool.query(
            `SELECT id FROM creditos WHERE (${cond.join(' OR ')}) AND num_op IS NULL LIMIT 1`, args);
          if (sinOp) await pool.query('UPDATE creditos SET num_op=? WHERE id=? AND num_op IS NULL',
            [await require('../../../../shared/num-op').siguienteNumOpAF(), sinOp.id]);   // secuencial: sin carrera
        } catch (e) { console.error('[carta otorgar→num_op nuevo]', e.message); }
        /* RESPALDO de numeración (motor único shared/num-op.js): desde agosto 2026
           toda operación nace ya con correlativo AutoFácil (lo asigna la carga
           Trinidad al insertar). Este bloque cubre solo las filas ANTERIORES a la
           regla que aún traen el ID de la financiera como num_op: al otorgarse,
           reciben el suyo. Nunca pisa un correlativo ya puesto. */
        try {
          const { siguienteNumOpAF, esIdFinanciera } = require('../../../../shared/num-op');
          const [[cr]] = await pool.query(
            `SELECT id, num_op FROM creditos WHERE (${cond.join(' OR ')}) LIMIT 1`, args);
          if (cr && esIdFinanciera(cr.num_op)) {
            const nuevo = await siguienteNumOpAF();
            await pool.query('UPDATE creditos SET num_op=? WHERE id=? AND num_op BETWEEN 1000000 AND 19999999', [nuevo, cr.id]);
            console.log(`[carta otorgar] num_op AutoFácil ${nuevo} asignado (antes ${cr.num_op}, id ${cr.id})`);
          }
        } catch (e) { console.error('[carta otorgar→num_op AF]', e.message); }
        /* MOTOR DE CÁLCULO tras otorgar (Máxima 1 + recálculo automático en toda
           vía): sin esto el crédito quedaba con plazo/tasa/primas completos pero
           monto_comision_fin, com_* e ingreso_neto_total en NULL — "sin ingreso
           por colocación ni por seguros" en el dashboard (2608001-2608004).
           Fire-and-forget: respeta forzados y meses cerrados. */
        pool.query(`SELECT id FROM creditos WHERE (${cond.join(' OR ')}) LIMIT 1`, args)
          .then(([[cr2]]) => cr2 && recalcularPorOps([cr2.id]))
          .catch(e => console.error('[carta otorgar→recalculo]', e.message));
        // comdea_real pactado: márcalo forzado para que el recálculo mensual lo respete
        // (marcarForzadosCalculo re-compara contra el motor: solo queda forzado si difiere).
        if (partB > 0) {
          try {
            const [[cr]] = await pool.query(`SELECT id FROM creditos WHERE (${cond.join(' OR ')}) LIMIT 1`, args);
            if (cr && cr.id) await marcarForzadosCalculo(cr.id, { campos: ['comdea_real'] });
          } catch (e) { console.error('[carta otorgar→forzado]', e.message); }
        }
      }
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
    /* Sin aprob_ver_todas: ve las cartas que ÉL digitó + las de SUS ejecutivos
       (motor único de visibilidad — las cartas las digita Operaciones, así que
       filtrar solo por creado_por dejaba al ejecutivo sin sus propias operaciones). */
    let rows;
    if (verTodas) {
      [rows] = await pool.query(`${SEL} ORDER BY ca.fecha_creacion DESC`);
    } else {
      const { ejecutivosVisibles } = require('../../../../shared/visibilidad-ejecutivos');
      const vis = await ejecutivosVisibles(req.usuario);
      if (!vis.all && vis.lista && vis.lista.length) {
        [rows] = await pool.query(
          `${SEL} WHERE ca.creado_por = ? OR UPPER(TRIM(ca.ejecutivo)) IN (?) ORDER BY ca.fecha_creacion DESC`,
          [login, vis.lista.map(e => String(e).trim().toUpperCase())]);
      } else {
        [rows] = await pool.query(`${SEL} WHERE ca.creado_por = ? ORDER BY ca.fecha_creacion DESC`, [login]);
      }
    }
    await _refreshIva();
    res.json({ success: true, data: rows.map(mapRow), verTodas, error: null });
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

const upsert = async (req, res) => {
  try {
    const c = req.body;
    // Rellenos tipo "XXX" en el nombre del cliente (empresas sin apellidos): se
    // limpian solos — el nombre real es lo que queda sin el relleno. Si TODO el
    // nombre es relleno, se detiene la digitación (caso 266100081DI).
    if (c.cliente) {
      const limpio = String(c.cliente).replace(/\b[Xx]{3,}\b/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (!limpio)
        return res.status(400).json({ success: false, data: null, error: 'El nombre del cliente no puede ser un relleno (XXX...). Escribe el nombre real.' });
      c.cliente = limpio;
    }
    // Estado previo (para detectar transiciones que generan notificación)
    let prevStatus = null;
    if (c.id) {
      const [[prev]] = await pool.query('SELECT status FROM cartas_aprobacion WHERE id = ?', [c.id]);
      prevStatus = prev?.status || null;
    }
    /* ── 4 OJOS EN EL SERVIDOR (auditoría del Revisor, hallazgo pre-existente) ──
       Antes el principio vivía solo en el front: por API bastaba aprob_crear para
       mandar status='APROBADA'. Ahora resolver una carta (APROBADA/RECHAZADA)
       exige el permiso aprob_revisar Y que quien resuelve NO sea quien la creó
       — la regla vale también para el Administrador, igual que en la pantalla.
       El Revisor Automático no pasa por aquí (escribe directo con su firma). */
    if (['APROBADA', 'RECHAZADA'].includes(c.status) && prevStatus !== c.status) {
      const { tieneFunc } = require('../../../../shared/middleware/permisos');
      if (!(await tieneFunc(req.usuario?.id_usuario, 'aprob_revisar')))
        return res.status(403).json({ success: false, data: null, error: 'Aprobar o rechazar una carta exige el permiso de revisión (aprob_revisar).' });
      const creador = String((c.id ? (await pool.query('SELECT creado_por FROM cartas_aprobacion WHERE id=?', [c.id]))[0][0]?.creado_por : c.creadoPor) || '').toLowerCase();
      if (creador && creador === String(req.usuario?.email || '').toLowerCase())
        return res.status(403).json({ success: false, data: null, error: 'Principio de 4 ojos: no puedes aprobar ni rechazar una carta que tú mismo creaste.' });
    }
    // No se puede aprobar una carta ya vencida (fecha + vigencia < hoy).
    if (c.status === 'APROBADA' && prevStatus !== 'APROBADA' && c.fecha) {
      const dias = await vigenciaDias();
      const vence = new Date(c.fecha + 'T00:00:00'); vence.setDate(vence.getDate() + dias);
      const hoy = new Date(); hoy.setHours(0, 0, 0, 0); vence.setHours(0, 0, 0, 0);
      if (vence < hoy)
        return res.status(400).json({ success: false, data: null,
          error: `La carta está vencida (${dias} días corridos desde su fecha) y no puede aprobarse.` });
    }
    // Regla de negocio (2026-07-23): el ID de la financiera es ÚNICO por operación.
    // Si ya existe en otra carta viva o en un crédito VIVO, se detiene la digitación
    // (evita cartas gemelas KT/DI y choques con uq_id_financiera al crear el crédito).
    // Una carta DESISTIDA/VENCIDA no bloquea: la operación se puede volver a digitar
    // (caso real: carta desistida por error de concesionario → se re-crea con el mismo ID).
    if (c.opOrigen) {
      const [[caDup]] = await pool.query(
        `SELECT op_carta FROM cartas_aprobacion
          WHERE id_financiera = ? AND status NOT IN ('ELIMINADA','ANULADA','RECHAZADA','DESISTIDA','VENCIDA','REEMPLAZADA')
            AND id <> COALESCE(?, 0) LIMIT 1`, [c.opOrigen, c.id || null]);
      if (caDup) return res.status(409).json({ success: false, data: null,
        error: `El ID de la financiera ${c.opOrigen} ya se encuentra ingresado (carta ${caDup.op_carta}).` });
      const MUERTOS = "('DESISTIDO','ANULADO','RECHAZADO')";
      const [[crDup]] = await pool.query(
        `SELECT id, num_op, numero_credito, id_financiera,
                UPPER(COALESCE(estado,'')) estado_u, UPPER(COALESCE(estado_credito,'')) estado_credito_u
           FROM creditos WHERE id_financiera = ?
            AND id <> COALESCE(?, 0)
            AND UPPER(COALESCE(estado,''))         NOT IN ${MUERTOS}
            AND UPPER(COALESCE(estado_credito,'')) NOT IN ${MUERTOS}
          LIMIT 1`, [c.opOrigen, c.idCreditoCreado || c.id_credito_creado || null]);
      if (crDup) {
        /* Una fila con num_op IGUAL al id_financiera todavía NO tiene numeración
           nuestra: la creó la carga masiva y está esperando su carta. Su estado
           OTORGADO es el de la financiera, no el nuestro, así que no es duplicado
           aunque diga OTORGADO — es la misma operación que se está digitando. */
        const sinNumeracionPropia = String(crDup.num_op || '') === String(crDup.id_financiera || '');
        // Ya OTORGADO con numeración nuestra → duplicado real: la operación ya se cursó.
        if (!sinNumeracionPropia && (crDup.estado_u === 'OTORGADO' || crDup.estado_credito_u === 'OTORGADO')) {
          const opDup = crDup.num_op || crDup.numero_credito;
          /* Si la carta que otorgó ese crédito está ANULADA, el bloqueo tiene una
             causa concreta y una salida concreta — decirla acá ahorra el rato de
             no entender por qué el sistema se niega (pasó el 04-08-2026). */
          const [[cartaMuerta]] = await pool.query(
            `SELECT op_carta FROM cartas_aprobacion
              WHERE id_credito_creado = ? AND status IN ('ANULADA','ELIMINADA') LIMIT 1`, [crDup.id]);
          return res.status(409).json({ success: false, data: null,
            error: cartaMuerta
              ? `La operación ${opDup} sigue OTORGADA y mantiene tomado el ID ${c.opOrigen}. Su carta (${cartaMuerta.op_carta}) se anuló, pero anular la carta NO anula la operación: hay que anularla en Créditos → Anular Operación (requiere una segunda firma). Recién entonces se puede generar la carta nueva.`
              : `El ID de la financiera ${c.opOrigen} ya se encuentra ingresado (crédito ${opDup}).` });
        }
        // Crédito vivo NO otorgado (carga masiva de aprobadas, digitación): es la MISMA
        // operación esperando su carta → la carta se ENLAZA a ese crédito en vez de
        // bloquear o crear un gemelo. Al otorgar, ese mismo crédito pasa a OTORGADO.
        const [[caViva]] = await pool.query(
          `SELECT op_carta FROM cartas_aprobacion
            WHERE id_credito_creado = ? AND status NOT IN ('ELIMINADA','ANULADA','RECHAZADA','DESISTIDA','VENCIDA','REEMPLAZADA')
              AND id <> COALESCE(?, 0) LIMIT 1`, [crDup.id, c.id || null]);
        if (caViva) return res.status(409).json({ success: false, data: null,
          error: `El ID de la financiera ${c.opOrigen} ya tiene una carta viva (${caViva.op_carta}).` });
        c.idCreditoCreado = crDup.id;
        c.numeroCreditoCreado = crDup.numero_credito || crDup.num_op || null;
      }
      // uq_id_financiera es UNIQUE: si un crédito MUERTO retiene el ID, hay que
      // soltárselo ahora o el INSERT del crédito nuevo reventaría igual. El ID
      // identifica la operación VIVA en la financiera; el muerto conserva su num_op.
      await pool.query(
        `UPDATE creditos SET id_financiera = NULL, updated_at = NOW()
          WHERE id_financiera = ? AND id <> COALESCE(?, 0)
            AND (UPPER(COALESCE(estado,'')) IN ${MUERTOS} OR UPPER(COALESCE(estado_credito,'')) IN ${MUERTOS})`,
        [c.opOrigen, c.idCreditoCreado || c.id_credito_creado || null]
      ).catch(e => console.error('[carta liberar id_financiera]', e.message));
    }
    /* El navegador manda las horas con new Date().toISOString() → viene en UTC
       ("...T18:33:44.000Z"). Como string, MySQL la guardaba TAL CUAL en una columna
       que se lee en hora de Chile: toda carta quedaba ~4 horas en el futuro (de ahí
       los "-238 min en el pool"). Convertida a Date, mysql2 la escribe en la zona
       del pool y la hora queda buena. Las que ya vienen en hora local (sin Z ni
       offset) se dejan intactas: convertirlas sí las movería. */
    const dt = v => {
      if (!v) return null;
      if (v instanceof Date) return v;
      return /[Zz]$|[+-]\d{2}:?\d{2}$/.test(String(v).trim()) ? new Date(v) : v;
    };
    /* Código de excepción del Simulador (fase 3): se valida y CONSUME al guardar,
       SERVER-SIDE (saldo ± tolerancia, RUT, vigencia, un solo uso). Si no pasa,
       la carta no se guarda. Re-guardar la misma carta con su código ya usado
       es válido (consumirCodigo lo reconoce por op_carta). */
    let codExc = null, codExcTipo = null;
    if (c.codigoExcepcion) {
      const { consumirCodigo } = require('../../../excepciones/src/controllers/excepciones.controller');
      const rc = await consumirCodigo({ codigo: c.codigoExcepcion, saldo_precio: c.saldo, rut_cliente: c.rutCliente, op_carta: c.opCarta,
        ejecutivo_carta: c.ejecutivoNombre });   // la estrella es del ejecutivo de la CARTA (auditoría 2026-08-08)
      if (!rc.ok) return res.status(400).json({ success: false, data: null, error: rc.error });
      codExc = String(c.codigoExcepcion).trim(); codExcTipo = rc.tipo;
    }
    const sellarCodigo = (idCarta) => { if (codExc) pool.query(
      'UPDATE cartas_aprobacion SET codigo_excepcion=?, codigo_excepcion_tipo=? WHERE id=?',
      [codExc, codExcTipo, idCarta]).catch(e => console.error('[carta codigo excepcion]', e.message)); };

    const vals = [
      c.opCarta, c.opOrigen, c.tipo,
      c.ejecutivoIdx || null, c.ejecutivoNombre, c.ejecutivoMail, c.ejecutivoTel,
      c.cliente, c.rutCliente,
      c.tipoVehiculo, c.marca, c.modelo, c.anio, c.patente, c.prenda,
      c.precioVenta || null, c.pie || null, c.saldo || null,
      c.plazo || null, c.acreedor, c.parque,
      c.concesionario, c.rutConc, c.vendedor,
      c.partNeto || null, c.partIVA || null, c.partBruto || null,
      c.fecha || null, dt(c.fechaCreacion) || new Date(),
      c.creadoPor, c.creadoPorNombre, c.creadoPorInitials,
      c.status || 'PENDIENTE',
      c.aprobadoPor || null, c.aprobadoPorNombre || null, c.aprobadoPorInitials || null,
      dt(c.fechaAprobacion),
      c.rechazadoPor || null, c.rechazadoPorNombre || null,
      dt(c.fechaRechazo), c.motivoRechazo || null,
      c.anuladoPor || null, dt(c.fechaAnulacion),
      c.eliminadoPor || null, dt(c.fechaEliminacion),
      dt(c.fechaCorreccion), c.corregidoPor || null,
      c.otorgado ? 1 : 0, dt(c.fechaOtorgado),
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
      sellarCodigo(c.id);
      persistirPrimasCarta(c.id, c);
      // Sincronizar estado del crédito vinculado
      if (c.idCreditoCreado || c.id_credito_creado) {
        const idCred = c.idCreditoCreado || c.id_credito_creado;
        sincronizarCreditoDesdeCarta(c, idCred);
        if (c.status === 'APROBADA') {
          pool.query(`UPDATE creditos SET estado='CARTA_APROBACION', updated_at=NOW() WHERE id=? AND estado='INGRESO'`, [idCred]).catch(e => console.error('[carta→credito estado]', e.message));
        } else if (c.status === 'RECHAZADA') {
          pool.query(`UPDATE creditos SET estado='INGRESO', updated_at=NOW() WHERE id=? AND estado='CARTA_APROBACION'`, [idCred]).catch(e => console.error('[carta→credito estado]', e.message));
        } else if (c.status === 'ANULADA' && prevStatus !== 'ANULADA') {
          avisarOperacionViva(c, idCred, req);
        }
      }
      notificarCambios(c, prevStatus, req);
      // Carta corregida que vuelve PENDIENTE (Unidad o Autofin) → nueva pasada del Revisor
      if (c.status === 'PENDIENTE' && /UNIDAD|AUTOFIN/.test(String(c.acreedor || '').toUpperCase()))
        setImmediate(() => require('../revisor-unidad').procesarCarta(c.id));
    } else {
      // INSERT nuevo: crear crédito asociado primero — salvo que la carta ya venga
      // ENLAZADA a un crédito existente (operación de carga masiva esperando carta).
      let credCreado = null;
      if (!c.idCreditoCreado)
        try { credCreado = await crearCreditoDesdeCartas(c); } catch(e) { console.error('[carta→credito]', e.message); }
      if (credCreado) {
        vals[vals.length - 2] = credCreado.numero_credito; // numero_credito_creado
        vals[vals.length - 1] = credCreado.id;             // id_credito_creado
      }
      /* Redigitación: si el número ya existe (la carta anterior de esta operación
         murió y se está volviendo a digitar), la nueva sale como -R1, -R2… El número
         se arma con año + ID financiera + iniciales, así que sin esto nacía duplicada
         y las dos se veían idénticas en pantalla. */
      const opLibre = await opCartaLibre(c.opCarta);
      if (opLibre !== c.opCarta) {
        console.log(`[cartas] ${c.opCarta} ya existe → la nueva se emite como ${opLibre}`);
        c.opCarta = opLibre;
        vals[0] = opLibre;
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
      /* UNA SOLA CARTA VIGENTE POR OPERACIÓN (regla de Pato, 31-07-2026).
         Al nacer una carta nueva para el mismo ID Financiera, las anteriores que
         sigan vivas (PENDIENTE o APROBADA) se ANULAN. Antes convivían varias
         aprobadas a la vez: además de prestarse a confusión, el motor de cartolas
         generaba UNA COMISIÓN POR CARTA — 9 operaciones quedaron con comisión
         duplicada por $4.499.700. La carta vigente es siempre la última. */
      anularCartasPrevias(r.insertId, c.id_financiera, req).catch(() => {});
      sellarCodigo(r.insertId);
      persistirPrimasCarta(r.insertId, c);
      /* Carta nueva ya ENLAZADA a un crédito de carga masiva: sincronizar igual
         que en la edición — este camino no sincronizaba nada y las primas del
         PDF de la financiera se perdían (operación a "datos faltantes"). */
      if (c.idCreditoCreado) sincronizarCreditoDesdeCarta(c, c.idCreditoCreado);
      // Snapshot del TIER UAC vigente al generar la carta (para la rentabilidad)
      tierUAC(c.fecha).then(t => pool.query('UPDATE cartas_aprobacion SET tier_uac_n=?, tier_uac_pct=? WHERE id=?', [t.n, t.pct, r.insertId])).catch(() => {});
      // op_carta va en la respuesta: si hubo redigitación, el número asignado NO es el
      // que mandó el navegador y la pantalla tiene que mostrar el real.
      res.status(201).json({ success: true, data: { id: r.insertId, op_carta: c.opCarta, numero_credito_creado: credCreado?.numero_credito || null }, error: null });
      notificarCambios(c, null, req, r.insertId);
    }
  } catch (e) {
    (console.error('[error]', e), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ─────────────────────────────────────────────────────────────────────────────
   Anular una carta que YA OTORGÓ no deshace la operación.

   Caso real del 04-08-2026: se anuló la carta 266230115FM porque iba con un
   error, pero el crédito 26080005 que esa carta había otorgado quedó VIVO y
   OTORGADO. Consecuencia: el ID de la financiera seguía tomado y el sistema no
   dejaba generar la carta corregida — con un mensaje que no explicaba por qué.

   Anularla automáticamente NO corresponde: anular una operación otorgada retira
   comisión de la cartola y por eso exige DOBLE FIRMA de Operaciones
   (`/creditos/anulaciones.html`). Saltarse ese control desde el módulo de cartas
   sería peor que el problema.

   Entonces: se AVISA, con el número de operación y el enlace directo. El aviso
   va por campanita y no por un mensaje pasajero a propósito — queda pendiente
   hasta que alguien lo atienda, que es justo lo que faltó acá.
   Fire & forget: no frena el guardado de la carta.
   ───────────────────────────────────────────────────────────────────────────── */
async function avisarOperacionViva(c, idCredito, req) {
  try {
    const MUERTOS = ['DESISTIDO', 'ANULADO', 'RECHAZADO'];
    const [[cr]] = await pool.query(
      `SELECT id, num_op, id_financiera, UPPER(COALESCE(estado,'')) e1,
              UPPER(COALESCE(estado_credito,'')) e2
         FROM creditos WHERE id = ? LIMIT 1`, [idCredito]);
    if (!cr) return;
    // Si el crédito ya está muerto, no hay nada que avisar.
    if (MUERTOS.includes(cr.e1) || MUERTOS.includes(cr.e2)) return;

    const op = cr.num_op || cr.id_financiera || idCredito;
    const quien = req && req.usuario ? req.usuario.id_usuario : null;
    let destinatarios = quien ? [quien] : [];
    try {   // más el pool de Operaciones, que es quien puede aprobar la anulación
      const [ops] = await pool.query(
        `SELECT DISTINCT u.id_usuario FROM usuarios u
           JOIN permisos_perfil pp ON pp.id_perfil = u.id_perfil AND pp.habilitado = 1
           JOIN funcionalidades f ON f.id_funcionalidad = pp.id_funcionalidad
          WHERE f.codigo = 'operacion_anular_aprobar' AND u.estado = 'activo'`);
      destinatarios = destinatarios.concat(ops.map(o => o.id_usuario));
    } catch (_) {}

    await notificar(destinatarios, {
      tipo: 'carta_anulada_operacion_viva',
      titulo: `La operación ${op} sigue vigente`,
      mensaje: `Se anuló la carta ${c.opCarta || c.op_carta || ''} pero el crédito ${op} que había otorgado NO se anuló: sigue OTORGADO y mantiene tomado el ID de la financiera ${cr.id_financiera || ''}. Mientras siga así no se puede generar una carta nueva para esa operación. Anúlala en Créditos → Anular Operación (requiere una segunda firma).`,
      href: '/creditos/anulaciones.html',
      prioridad: 'alta',
      clave: `carta_anulada_op_viva:${idCredito}`,
    });
  } catch (e) { console.error('[carta anulada → operación viva]', e.message); }
}

/* Una sola carta vigente por operación: anula las anteriores del mismo ID Financiera.
   Fire & forget — no frena la creación de la carta nueva. */
async function anularCartasPrevias(idNueva, idFinanciera, req) {
  const idFin = String(idFinanciera || '').trim();
  if (!idFin || !idNueva) return;
  const quien = req && req.usuario ? ([req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') || req.usuario.email) : 'Sistema';
  const [prev] = await pool.query(
    "SELECT id, op_carta, status FROM cartas_aprobacion WHERE id_financiera = ? AND id <> ? AND status IN ('PENDIENTE','APROBADA')",
    [idFin, idNueva]);
  if (!prev.length) return;
  await pool.query(
    `UPDATE cartas_aprobacion SET status='ANULADA', anulado_por=?, fecha_anulacion=NOW(),
            motivo_rechazo=CONCAT('Anulada automáticamente: se generó una carta nueva para la operación ', ?)
      WHERE id IN (?)`,
    [quien, idFin, prev.map(p => p.id)]);
  /* La comisión que esa carta haya dejado en la cartola se retira, salvo que ya
     se haya enviado al dealer (ahí el movimiento se respeta y se regulariza aparte). */
  await pool.query(
    "DELETE FROM cartolas_movimientos WHERE id_carta IN (?) AND mes_cartola IS NULL",
    [prev.map(p => p.id)]).catch(() => {});
  try {
    const { auditar } = require('../../../../shared/audit');
    auditar({ req, accion: 'ANULAR_CARTA_PREVIA', modulo: 'cartas', entidad: 'carta', entidad_id: idNueva,
      detalle: `Se anularon ${prev.length} carta(s) previas de la operación ${idFin} al generar una nueva: ${prev.map(p => p.op_carta + ' (' + p.status + ')').join(', ')}`,
      meta: { anuladas: prev.map(p => p.id), id_financiera: idFin } });
  } catch (_) {}
}

/* Notificaciones del flujo (no bloquea la respuesta HTTP) */
/* `idCarta`: al CREAR, `c` es el body y todavía no trae id — el id real es el
   insertId. Sin este parámetro la clave salía 'carta:undefined' para TODAS las
   cartas nuevas: compartían una sola clave, así que la segunda ya no avisaba
   ("ya existe") y retirar una las retiraba todas. */
function notificarCambios(c, prevStatus, req, idCarta) {
  (async () => {
    try {
      const idC = idCarta || c.id;
      const esNuevaPendiente   = !prevStatus && c.status === 'PENDIENTE';
      const vuelveAlPool       = prevStatus === 'RECHAZADA' && c.status === 'PENDIENTE';
      const resuelta           = prevStatus === 'PENDIENTE' && (c.status === 'APROBADA' || c.status === 'RECHAZADA');

      if (esNuevaPendiente || vuelveAlPool) {
        // Al autor no se le avisa de su propia carta
        const autorId = await idPorEmail(c.creadoPor);
        await AVISOS.avisar('carta_nueva', {
          tipo: 'CARTA_NUEVA',
          titulo: vuelveAlPool ? '🔁 Carta corregida para revisión' : '🛎️ Nueva carta para revisión',
          mensaje: `${c.creadoPorNombre || 'Un ejecutivo'} envió la carta ${c.opCarta || ''} — ${c.cliente || ''}`,
          href: '/aprobaciones/?tab=revision',
          // clave del hecho: al aprobarse o rechazarse se retira del pool.
          clave: 'carta:' + idC,
        }, { excluir: [autorId] });
      }
      if (resuelta) {
        // El pool ya no tiene nada que revisar en esta carta.
        AVISOS.retirar('carta:' + idC).catch(() => {});
        const autorId = await idPorEmail(c.creadoPor);
        if (autorId) {
          const ok = c.status === 'APROBADA';
          // Resolución → al ejecutivo (siempre) + quien el mantenedor agregue
          await AVISOS.avisar('carta_resuelta', {
            tipo: 'CARTA_' + c.status,
            titulo: ok ? '✅ Carta aprobada' : '❌ Carta rechazada',
            mensaje: ok
              ? `Tu carta ${c.opCarta || ''} (${c.cliente || ''}) fue aprobada — ya puedes imprimirla`
              : `Tu carta ${c.opCarta || ''} fue rechazada${c.motivoRechazo ? ': ' + c.motivoRechazo : ''}. Corrígela y reenvíala.`,
            href: '/aprobaciones/',
            son_tipo: ok ? 'dingdong' : 'alarma',
          }, { extra: [autorId] });
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
        // MAYÚSCULAS: los agrupados por ejecutivo son por texto exacto (ver INSERT de arriba).
        const ejec = String(r.ejecutivo || '').trim().toUpperCase() || null;
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
            const rcN = RUT.normalizar(rutCli) || rutCli;
            const [[clx]] = await pool.query('SELECT id_cliente FROM clientes WHERE rut=? LIMIT 1', [rcN]);
            if (clx) idCliente = clx.id_cliente;
            else { const [ci] = await pool.query('INSERT INTO clientes (rut, nombre_completo) VALUES (?,?)', [rcN, r.cliente || null]); idCliente = ci.insertId; clientesCreados++; }
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
  const _saldo = _numU(g(/Saldo precio:\s*([\d.]+)/));
  /* Monto del crédito en UNIDAD = "Monto Bruto del Crédito" (líquido + impuesto +
     primas), el equivalente exacto del "Total pagaré" de AutoFin: ambos son el
     CAPITAL del pagaré, que es lo que alimenta creditos.monto_financiado.
     NO se usa el "Costo Total Crédito": ese es la suma de las cuotas e incluye los
     intereses del plazo completo (deja el monto al doble).
     Red de seguridad: "Total a pagar" NO siempre es el capital — en varios PDF es
     la CUOTA mensual. Caso real: llegó $148.570 como monto de un crédito con
     $7.980.000 de saldo y la carta pasó la revisión sin que nadie lo notara.
     El monto JAMÁS es menor al saldo precio, así que bajo el 80% se descarta. */
  const _bruto = _numU(g(/Monto Bruto del Cr[eé]dito[^\n:]*::?\s*([\d.]+)/i));
  const _totalPagar = _bruto != null ? _bruto : _numU(g(/Total a pagar:\s*([\d.]+)/));
  const _monto = (_saldo && _totalPagar && _totalPagar < _saldo * 0.8) ? _saldo : _totalPagar;
  return {
    opOrigen:        g(/N° Operación\s*\n?\s*(\d{4,})/),
    fecha:           _fechaU(g(/Fecha:\s*(\d{2}-\d{2}-\d{4})/)),
    rutCliente:      g(/Rut:\s*([\d.]+-[\dkK])/),
    nombre, nombres: sp.nombres, apPaterno: sp.apPaterno, apMaterno: sp.apMaterno,
    plazo:           _numU(g(/Número de cuotas:\s*(\d+)/)),
    saldo:           _saldo,
    tasaCredito:     (g(/Tasa de interés Nominal:\s*([\d,]+)/) || '').replace(',', '.') || null,
    montoCreditoCLP: _monto,
    concesionario:   g(/Dealers:\s*([^\n]+?)Sucursal/),
    vendedor:        g(/F&I:\s*([^\n]+?)Ejecutivo/),
    patente:         g(/placa patente\s+([A-Z]{4}\d{2}|[A-Z]{2}\d{4})/i),
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
  /* Monto del crédito en UNIDAD = "Monto Bruto del Crédito" (líquido + impuesto +
     primas). Es el equivalente exacto del "Total pagaré" de AutoFin: ambos son el
     CAPITAL del pagaré, y es el que alimenta creditos.monto_financiado.
     NO se usa el "Costo Total Crédito": ese es la suma de las cuotas (capital +
     intereses de todo el plazo) y deja el monto al doble. Verificado contra la
     base única: la cotización 616237 (op 89211) tiene Monto Bruto 6.792.662 y
     Costo Total 11.089.548 — INDEXA registra 6.792.662. */
  const out = {
    opOrigen:        g(/N°\s*0*(\d{4,})/),
    cae:             g(/CAE\s*::\s*([\d,]+)\s*%/),
    titular:         g(/Titular[\s\S]*?::\s*([A-ZÁÉÍÓÚÑ ]+?)\s*\n/),
    montoCreditoCLP: _numU(g(/Monto Bruto del Cr[eé]dito[^\n:]*::?\s*([\d.]+)/i)),
    saldo:           _numU(g(/Monto L[ií]quido del Cr[eé]dito[^\n:]*::?\s*([\d.]+)/i)),
    costoTotal:      _numU(g(/Costo Total Cr[eé]dito[^\n:]*::?\s*([\d.]+)/i)),  // informativo (lo que paga el cliente)
    plazo:           _numU(g(/Plazo del Cr[eé]dito[^\n:]*::?\s*(\d+)/i)),
    cuota:           _numU(g(/Valor de Cuota[^\n:]*::?\s*([\d.]+)/i)),
  };
  /* Fallback POSICIONAL: hay un segundo layout donde pdf-parse aplana cada cuadro
     en bloque — primero TODAS las etiquetas, después TODOS los valores "::" en el
     mismo orden (ops 26080283/26080285: el bruto quedaba a 2 líneas de su etiqueta
     y las anclas en línea no calzaban). Se aparean etiqueta n → valor n. */
  if (out.montoCreditoCLP == null) {
    const b = t.match(/Impuestos\s*\nNotar[ií]a\s*\nMonto Bruto del Cr[eé]dito[^\n]*\nGarant[ií]as Asociadas\s*\n::\s*([\d.]+)\s*\n::\s*([\d.]+)\s*\n::\s*([\d.]+)/i);
    if (b) out.montoCreditoCLP = _numU(b[3]);
  }
  if (out.saldo == null) {
    const b = t.match(/Monto L[ií]quido del Cr[eé]dito[^\n]*\nPlazo del Cr[eé]dito[^\n]*\nValor de Cuota[^\n]*\nCosto Total Cr[eé]dito[^\n]*\nCAE[^\n]*\n[^\n]*\n::\s*([\d.]+)\s*\n::\s*(\d+)\s*\n::\s*([\d.]+)\s*\n::\s*([\d.]+)/i);
    if (b) {
      out.saldo = _numU(b[1]);
      if (out.plazo == null) out.plazo = _numU(b[2]);
      if (out.cuota == null) out.cuota = _numU(b[3]);
      if (out.costoTotal == null) out.costoTotal = _numU(b[4]);
    }
  }
  return out;
}
// Carta de Aprobación Autofin (formato 2 columnas; pdf-parse lo aplana → anclas por contexto).
function parseCartaAutofin(t) {
  /* pdf-parse a veces PEGA dos montos en una misma línea ("6.690.0007.413.083" =
     monto solicitado + total pagaré). Eso corría todo una posición y el total
     pagaré terminaba siendo el campo siguiente: los recargos ($148.570) llegaron
     como monto del crédito. Se separan antes de aplicar las anclas. El corte es
     inequívoco: un monto es \d{1,3}(.\d{3})+ y el pegado parte justo donde
     termina el patrón. Dos pasadas por si vienen tres montos juntos. */
  const SEP = /(\d{1,3}(?:\.\d{3})+)(\d{1,3}(?:\.\d{3})+)/g;
  t = String(t).replace(SEP, '$1\n$2').replace(SEP, '$1\n$2');
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
  // ── PRIMAS DE SEGURO (bloque posicional del encabezado): el PDF aplanado parte con
  //    rut / monto solicitado / total pagaré / total recargos / DESGRAVAMEN / CESANTÍA /
  //    impuesto timbre / tasa / cuotas / fecha curse (orden de la columna de valores).
  const blk1 = t.match(/(\d{7,8}-[\dkK])\n([\d.]+)\n([\d.]+)\n([\d.]+)\n([\d.]*)\n([\d.]*)\n([\d.]*)\n(\d{1,2},\d{1,4})\n(\d{1,3})\n(\d{2}\/\d{2}\/\d{4})/);
  const segDesgravamen = blk1 ? _numU(blk1[5]) : null;
  const segCesantia    = blk1 ? _numU(blk1[6]) : null;
  // Segundo bloque de valores (antes de "Nº Crédito"): RDH+E / Reparaciones Menores / GPS / …
  const blk2 = t.match(/\n([\d.]*)\n([\d.]*)\n([\d.]*)\n([\d.]*)\n([\d.]*)\nNº Crédito/);
  /* Fallback por ETIQUETA: en varios PDF el aplanado deja las etiquetas separadas
     de los valores ("Seguro RDH+E:\nReparaciones Menores\n515.209\n0") y el
     bloque posicional no calza. Se busca el primer número tras cada etiqueta,
     saltando hasta 3 líneas de texto intermedias. */
  const trasEtiqueta = (label, nth) => {
    const m = t.match(new RegExp(label + ':?\\s*\\n(?:[^\\n\\d][^\\n]*\\n){0,3}?\\s*([\\d.]+)\\s*\\n\\s*([\\d.]+)?', 'i'));
    return m ? _numU(m[nth || 1]) : null;
  };
  const segRdh = blk2 ? _numU(blk2[1]) : trasEtiqueta('Seguro RDH\\+E');
  const segRep = blk2 ? _numU(blk2[2]) : trasEtiqueta('Seguro RDH\\+E', 2);
  const gps    = blk2 ? _numU(blk2[3]) : trasEtiqueta('GPS');
  /* GASTOS del PDF (fuera de las primas): inscripción + mantenciones prepagadas
     + garantía mecánica + seguro pérdida total. Van a creditos.gastos. */
  const _gastosDet = {
    inscripcion:  trasEtiqueta('Inscripci[oó]n'),
    mantenciones: trasEtiqueta('Mantenciones Prepagadas'),
    garantia:     trasEtiqueta('Garant[ií]a Mec[aá]nica'),
    perdidaTotal: trasEtiqueta('Seguro Perdida Total'),
  };
  const _gVals = Object.values(_gastosDet).filter(v => v != null);
  const gastos = _gVals.length ? _gVals.reduce((a, b) => a + b, 0) : null;
  return {
    segDesgravamen, segCesantia, segRdh, segRep, gps, gastos, gastosDetalle: _gastosDet,
    opOrigen: nameOp ? nameOp[2] : null,
    fecha: fechaRaw ? fechaRaw.split('/').reverse().join('-') : null,
    rutCliente: g(/(\d{7,8}-[\dkK])/),
    nombre, nombres: sp.nombres, apPaterno: sp.apPaterno, apMaterno: sp.apMaterno,
    marca: g(/\n([A-ZÁÉÍÓÚ]{3,})\n(?::\n)+[\d.]+\n\d{7,8}-/),
    modelo: g(/\n([A-Z0-9][A-Z0-9 ]{0,11})\nModelo\n/),
    anio: g(/\n(\d{4})\n:?Año/),
    patente: g(/PPU\s+([A-Z]{4}\d{2}|[A-Z]{2}\d{4})/),
    precioVenta, pie, saldo, plazo,
    // AutoFin trae 4 decimales; se toman solo los 2 primeros TRUNCADOS hacia abajo
    // (2,8683 → 2,86), nunca al más próximo ni al alza, para no quedar sobre la pizarra.
    tasaCredito: tasaRaw ? (Math.floor(Number(tasaRaw.replace(',', '.')) * 100 + 1e-6) / 100).toFixed(2) : null,
    // Red de seguridad: el monto jamás es menor al saldo precio; si el ancla
    // igual tomó otro campo (recargos, cuota), manda el saldo.
    montoCreditoCLP: (totalPagare != null && !(saldo && totalPagare < saldo * 0.8)) ? totalPagare : saldo,
    ejecutivo: g(/\n([A-ZÁÉÍÓÚ][A-ZÁÉÍÓÚ ]+?) \(AFA\)\n/),
    acreedor: 'AUTOFIN',
  };
}
const _toBuf = b64 => Buffer.from(String(b64).replace(/^data:[^;]+;base64,/, ''), 'base64');

// POST /api/cartas/parse-unidad → extrae campos sin guardar (autocompletar)
/* ── Lectura IA de PDFs escaneados (Haiku con visión) ──
   Devuelve el MISMO shape que los parsers regex, o null si la IA está apagada/falla.
   Los montos vienen como número entero CLP; la tasa como % mensual (ej 2.87). */
const _iaNum = v => { const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10); return isNaN(n) ? null : n; };
const _iaTasa = v => { const n = parseFloat(String(v ?? '').replace(',', '.').replace(/[^\d.]/g, '')); return isNaN(n) ? null : n; };
async function ocrCartaIA(tipoDoc, b64) {
  const ia = require('../../../../shared/ia');
  if (!(await ia.iaActiva('cartas_pdf_ia'))) return null;
  const CAMPOS = {
    COMPROMISO_UNIDAD: 'numero de operacion (opOrigen), fecha del documento (fecha, formato YYYY-MM-DD), rut del cliente (rutCliente, formato 12345678-9), nombres del cliente (nombres), apellido paterno (apPaterno), apellido materno (apMaterno), marca del vehiculo (marca), modelo (modelo), año (anio), patente/placa COMPLETA de 6 caracteres, formato chileno AAAA00 o AA0000 — suele venir en el parrafo como "placa patente XXXX00"; si no se lee completa usa null (patente), precio de venta (precioVenta), pie (pie), saldo de precio (saldo), plazo en cuotas (plazo), tasa mensual en % (tasaCredito), monto del credito = el MONTO BRUTO en pesos (montoCreditoCLP) — nunca el costo total (que incluye intereses) ni la cuota, participacion/comision del dealer en pesos IVA incluido (partBruto), nombre del concesionario/dealer (concesionario), rut del concesionario (rutConc), nombre del vendedor (vendedor)',
    COTIZACION_UNIDAD: 'numero de operacion o cotizacion (opOrigen), MONTO BRUTO del credito en pesos (montoCreditoCLP) — no el liquido ni el costo total, monto liquido del credito (saldo), costo total del credito (costoTotal), plazo en meses (plazo), valor de la cuota (cuota)',
    CARTA_AUTOFIN: 'numero de credito o solicitud (opOrigen), fecha (fecha, YYYY-MM-DD), rut del cliente (rutCliente), nombres (nombres), apellido paterno (apPaterno), apellido materno (apMaterno), marca (marca), modelo (modelo), año (anio), patente/placa COMPLETA de 6 caracteres, formato chileno AAAA00 o AA0000; si no se lee completa usa null (patente), precio de venta (precioVenta), pie (pie), saldo (saldo), plazo en cuotas (plazo), tasa mensual % (tasaCredito), monto del credito = el TOTAL PAGARE en pesos (montoCreditoCLP) — NUNCA el total de recargos ni el valor de una cuota, nombre del ejecutivo (ejecutivo), prima seguro desgravamen (segDesgravamen), prima cesantia (segCesantia), prima RDH/robo-hurto (segRdh), prima reparaciones menores (segRep), gps (gps), gastos = suma de inscripcion + mantenciones prepagadas + garantia mecanica + seguro perdida total (gastos)',
  };
  try {
    const { datos } = await require('../../../../shared/anthropic').analizar({
      codigo: 'cartas_pdf_ia', json: true, max_tokens: 1200,
      documentos: [{ tipo: 'pdf', data: b64 }],
      system: 'Extraes datos de documentos de crédito automotriz chilenos escaneados. Respondes SOLO JSON con las claves pedidas; usa null cuando el dato no aparece. Montos en pesos como entero sin puntos ni $. La tasa mensual como número (ej: 2.87). No inventes datos.',
      prompt: `Extrae de este documento (${tipoDoc.replace(/_/g, ' ')}): ${CAMPOS[tipoDoc]}.`,
    });
    if (!datos) return null;
    // coerción de tipos al shape de los parsers
    for (const k of ['precioVenta', 'pie', 'saldo', 'montoCreditoCLP', 'partBruto', 'segDesgravamen', 'segCesantia', 'segRdh', 'segRep', 'gps', 'gastos']) if (k in datos) datos[k] = _iaNum(datos[k]);
    if ('plazo' in datos) datos.plazo = _iaNum(datos.plazo);
    // Patente: o viene COMPLETA con formato chileno o no viene. Una lectura
    // truncada ("RRL" de RRLB83) autocompletada es peor que el campo vacío.
    if ('patente' in datos && datos.patente != null) {
      const pat = String(datos.patente).toUpperCase().replace(/[^A-Z0-9]/g, '');
      datos.patente = (/^[A-Z]{4}\d{2}$/.test(pat) || /^[A-Z]{2}\d{4}$/.test(pat)) ? pat : null;
    }
    if ('anio' in datos) datos.anio = _iaNum(datos.anio);
    if ('tasaCredito' in datos) datos.tasaCredito = _iaTasa(datos.tasaCredito);
    if (datos.rutCliente) datos.rutCliente = RUT.normalizar(datos.rutCliente) || datos.rutCliente;
    if (datos.rutConc) datos.rutConc = RUT.normalizar(datos.rutConc) || datos.rutConc;
    return datos;
  } catch (e) { console.error('[ocrCartaIA]', e.code || e.message); return null; }
}

const parseUnidad = async (req, res) => {
  try {
    const { compromiso_base64, cotizacion_base64 } = req.body || {};
    if (!compromiso_base64 && !cotizacion_base64)
      return res.status(400).json({ success: false, data: null, error: 'Adjunta al menos un documento' });
    const out = { warnings: [] };
    // Un PDF escaneado/foto no trae capa de texto → no hay nada que extraer
    const esEscaneado = (txt) => String(txt || '').replace(/\s/g, '').length < 40;
    if (compromiso_base64) {
      try {
        const txt = (await pdf(_toBuf(compromiso_base64))).text;
        if (esEscaneado(txt)) {
          out.compromiso = await ocrCartaIA('COMPROMISO_UNIDAD', compromiso_base64);
          out.warnings.push(out.compromiso
            ? 'La Carta Compromiso venía escaneada: se leyó con IA (Haiku) — REVISA los datos antes de guardar.'
            : 'La Carta Compromiso es un PDF escaneado (imagen, sin texto) y la lectura IA no está disponible. Descarga el PDF original desde el sistema de Unidad — igual quedó adjunta para la revisión.');
        }
        else out.compromiso = await completarConIA('COMPROMISO_UNIDAD', compromiso_base64, parseCartaCompromiso(txt), CLAVES_COMPROMISO, out.warnings);
      }
      catch (e) { out.warnings.push('No se pudo leer la Carta Compromiso: ' + e.message); }
    }
    if (cotizacion_base64) {
      try {
        const txt = (await pdf(_toBuf(cotizacion_base64))).text;
        if (esEscaneado(txt)) {
          out.cotizacion = await ocrCartaIA('COTIZACION_UNIDAD', cotizacion_base64);
          out.warnings.push(out.cotizacion
            ? 'La Cotización venía escaneada: se leyó con IA (Haiku) — REVISA los datos antes de guardar.'
            : 'La Cotización es un PDF escaneado (imagen, sin texto) y la lectura IA no está disponible. Descarga el PDF original desde el sistema de Unidad — igual quedó adjunta para la revisión.');
        }
        else out.cotizacion = await completarConIA('COTIZACION_UNIDAD', cotizacion_base64, parseCotizacion(txt), CLAVES_COTIZACION, out.warnings);
      }
      catch (e) { out.warnings.push('No se pudo leer la Cotización: ' + e.message); }
    }
    const c = out.compromiso || {}, q = out.cotizacion || {};
    out.fields = {
      opOrigen: c.opOrigen || q.opOrigen || null, fecha: c.fecha || null, rutCliente: c.rutCliente || null,
      nombres: c.nombres || null, apPaterno: c.apPaterno || null, apMaterno: c.apMaterno || null,
      acreedor: c.acreedor || 'UNIDAD DE CREDITO',
      marca: c.marca || null, modelo: c.modelo || null, anio: c.anio || null, patente: c.patente || null,
      precioVenta: c.precioVenta || null, pie: c.pie || null, saldo: c.saldo || null,
      plazo: c.plazo || null, tasaCredito: c.tasaCredito || null,
      /* Monto del crédito: manda la COTIZACIÓN (declara "Monto Bruto del Crédito"
         explícito). La Carta Compromiso no lo trae y su fallback "Total a pagar"
         puede ser la cuota → terminaba guardando el saldo (caso 26634853CV). */
      montoCreditoCLP: q.montoCreditoCLP || c.montoCreditoCLP || null,
      partBruto: c.partBruto || null,
      concesionario: c.concesionario || null, rutConc: c.rutConc || null, vendedor: c.vendedor || null,
    };
    if (c.opOrigen && q.opOrigen && c.opOrigen !== q.opOrigen)
      out.warnings.push(`El N° de operación no coincide: Carta ${c.opOrigen} vs Cotización ${q.opOrigen}`);
    if (c.montoCreditoCLP && q.montoCreditoCLP && c.montoCreditoCLP !== q.montoCreditoCLP)
      out.warnings.push(`El monto del crédito difiere: Carta Compromiso $${c.montoCreditoCLP.toLocaleString('es-CL')} vs Cotización $${q.montoCreditoCLP.toLocaleString('es-CL')} — se usa el Monto Bruto de la Cotización.`);
    res.json({ success: true, data: out, error: null });
  } catch (e) { console.error('[parseUnidad]', e.message); res.status(500).json({ success: false, data: null, error: 'No se pudo procesar el documento' }); }
};

/* Segunda lectura con IA cuando el parser de texto dejó campos CLAVE vacíos.
   El PDF sí tiene texto, pero el aplanado de pdf-parse a veces revuelve las
   columnas y las anclas no calzan (montos pegados, etiquetas separadas de los
   valores). Regla: lo leído del texto SIEMPRE manda; Haiku solo llena huecos.
   Definición de Pato: cuando hay problemas para leer, se lee con Haiku. */
async function completarConIA(tipoDoc, b64, parsed, claves, warnings) {
  try {
    const faltan = claves.filter(k => parsed == null || parsed[k] == null || parsed[k] === '');
    if (!faltan.length) return parsed;
    const ia = await ocrCartaIA(tipoDoc, b64);
    if (!ia) return parsed;
    const out = { ...(parsed || {}) };
    const llenados = [];
    for (const [k, v] of Object.entries(ia)) {
      if (v == null || v === '') continue;
      if (out[k] == null || out[k] === '') { out[k] = v; llenados.push(k); }
    }
    if (llenados.length) warnings.push(
      `El texto del PDF no dejó leer ${llenados.join(', ')}: se completó con IA (Haiku) — REVISA esos datos antes de guardar.`);
    return out;
  } catch (e) { console.error('[completarConIA]', e.message); return parsed; }
}
const CLAVES_AUTOFIN = ['precioVenta', 'pie', 'montoCreditoCLP', 'tasaCredito', 'plazo', 'segRdh'];
const CLAVES_COMPROMISO = ['saldo', 'montoCreditoCLP', 'plazo', 'tasaCredito'];
const CLAVES_COTIZACION = ['montoCreditoCLP', 'saldo', 'plazo'];

// POST /api/cartas/parse-autofin → extrae campos de la Carta de Aprobación Autofin
const parseAutofin = async (req, res) => {
  try {
    const b64 = req.body && (req.body.carta_base64 || req.body.compromiso_base64);
    if (!b64) return res.status(400).json({ success: false, data: null, error: 'Adjunta la Carta de Aprobación (PDF)' });
    const out = { warnings: [] };
    try {
      const txt = (await pdf(_toBuf(b64))).text;
      if (String(txt || '').replace(/\s/g, '').length < 40) {
        out.carta = await ocrCartaIA('CARTA_AUTOFIN', b64);
        if (!out.carta)
          return res.status(422).json({ success: false, data: null, error: 'La carta es un PDF escaneado (imagen, sin texto) y la lectura IA no está disponible. Descarga el PDF original desde Trinidad/AutoFin y súbelo de nuevo.' });
        out.warnings.push('La carta venía escaneada: se leyó con IA (Haiku) — REVISA los datos antes de guardar.');
      }
      else out.carta = await completarConIA('CARTA_AUTOFIN', b64, parseCartaAutofin(txt), CLAVES_AUTOFIN, out.warnings);
    }
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
      // primas reales de la ficha AutoFin (0 explícito es válido — ej. empresas sin desgravamen)
      segDesgravamen: c.segDesgravamen, segCesantia: c.segCesantia,
      segRdh: c.segRdh, segRep: c.segRep, gps: c.gps,
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
    if (!['COMPROMISO_UNIDAD', 'COTIZACION_UNIDAD', 'CARTA_AUTOFIN', 'PANTALLAZO_AUTOFIN'].includes(String(tipo)))
      return res.status(400).json({ success: false, data: null, error: 'Tipo de documento inválido' });
    const buf = _toBuf(data_base64);
    if (!buf.length) return res.status(400).json({ success: false, data: null, error: 'Archivo vacío' });
    if (buf.length > 12 * 1024 * 1024) return res.status(413).json({ success: false, data: null, error: 'Máximo 12 MB por archivo' });
    /* AUDITORÍA REVISOR (hallazgo 4): con la carta ya resuelta no se reemplazan
       documentos — el checklist firmado quedaría descolgado de lo adjunto. */
    if (idCarta) {
      const [[caDoc]] = await pool.query('SELECT status, otorgado FROM cartas_aprobacion WHERE id=? LIMIT 1', [idCarta]);
      if (caDoc && (caDoc.otorgado || !['PENDIENTE', 'RECHAZADA'].includes(caDoc.status)))
        return res.status(409).json({ success: false, data: null, error: `La carta está ${caDoc.otorgado ? 'OTORGADA' : caDoc.status}: sus documentos ya no se pueden reemplazar.` });
    }
    /* Re-subida: la fila anterior se borra, así que hay que quedarse con su ruta
       antes o el objeto queda huérfano en el bucket para siempre. */
    let rutasViejas = [];
    if (idCarta) {
      [rutasViejas] = await pool.query('SELECT doc_ruta FROM cartas_documentos WHERE id_carta=? AND tipo=? AND doc_ruta IS NOT NULL', [idCarta, tipo]);
      await pool.query('DELETE FROM cartas_documentos WHERE id_carta=? AND tipo=?', [idCarta, tipo]); // re-subida: reemplaza
    }
    /* extracted lo calcula SIEMPRE el SERVIDOR — nunca se acepta del cliente
       (auditoría del Revisor, hallazgo 1: un extracted forjado por API haría
       aprobar cartas con documentos que dicen otra cosa). */
    void extracted;   // ignorado deliberadamente
    let ext = null;
    /* Pantallazo del sistema Autofin (imagen): Haiku lee el ID de solicitud y el
       ESTADO (Revisión Firma / Cursado / etc.) — es el fundante del lado Autofin. */
    if (!ext && tipo === 'PANTALLAZO_AUTOFIN') {
      try {
        const ia = require('../../../../shared/ia');
        if (await ia.iaActiva('cartas_pdf_ia')) {
          const { datos, texto, stop_reason } = await require('../../../../shared/anthropic').analizar({
            codigo: 'cartas_pdf_ia', json: true, max_tokens: 700,
            documentos: [{ tipo: 'image', media_type: mime || 'image/png', data: data_base64.replace(/^data:[^;]+;base64,/, '') }],
            system: 'Lees pantallazos del sistema de créditos Autofin (Chile). Respondes SOLO JSON; null cuando el dato no se ve o es ambiguo. No inventes.',
            prompt: 'El pantallazo debe mostrar UNA solicitud puntual (su ficha o su fila única de búsqueda por ID). Extrae: numero de solicitud o ID visible (idSolicitud), ESTADO de ESA solicitud tal como aparece (estado — ej REVISIONFIRMA, REVISION FIRMA, CURSADO, APROBADA, PRE-CURSE), rut del cliente si se ve (rutCliente), fecha de curse si se ve (fechaCurse, YYYY-MM-DD). Si la imagen es un LISTADO con varias solicitudes y no está claro cuál es, responde {"idSolicitud":null,"estado":null,"listado":true}.',
          });
          // La respuesta cruda queda guardada cuando no hubo JSON — sin ella no se puede depurar
          ext = datos || { error_lectura: 'IA sin JSON', texto_ia: String(texto || '').slice(0, 400), stop_reason: stop_reason || null };
        } else ext = { sin_ia: true };
      } catch (e) { ext = { error_lectura: e.message }; }
    }
    if (!ext && String(mime || 'application/pdf').includes('pdf')) {
      try {
        const txt = (await pdf(buf)).text;
        if (String(txt || '').replace(/\s/g, '').length < 40) ext = { escaneado: true };
        else ext = tipo === 'COTIZACION_UNIDAD' ? parseCotizacion(txt)
                 : tipo === 'COMPROMISO_UNIDAD' ? parseCartaCompromiso(txt)
                 : parseCartaAutofin(txt);
      } catch (e) { ext = { error_lectura: e.message }; }
    }
    const d = await almacen.colocar({ ambito: 'cartas', clave: idCarta || 'sin-carta', buffer: buf, mime, nombre: nombre || 'documento.pdf' });
    const [r] = await pool.query(
      `INSERT INTO cartas_documentos (id_carta, tipo, nombre, mime, tamano, data, doc_storage, doc_ruta, doc_bytes, extracted, subido_por, id_subido_por)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [idCarta, tipo, nombre || 'documento.pdf', mime || 'application/pdf', buf.length, d.blob, d.storage, d.ruta, d.bytes,
       ext ? JSON.stringify(ext) : null, req.usuario?.email || null, req.usuario?.id_usuario || null]);
    for (const v of rutasViejas) await almacen.borrar(v.doc_ruta);
    res.status(201).json({ success: true, data: { id: r.insertId, extracted: ext || null }, error: null });
    /* Revisor Automático (Unidad y Autofin): con cada documento que llega intenta
       la revisión completa — aprueba solo cuando están todos y todo cuadra. */
    if (idCarta) setImmediate(() => require('../revisor-unidad').procesarCarta(idCarta));
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
    const [[d]] = await pool.query('SELECT nombre, mime, data, doc_ruta FROM cartas_documentos WHERE id=?', [req.params.docId]);
    if (!d) return res.status(404).json({ success: false, data: null, error: 'Documento no encontrado' });
    const contenido = await almacen.obtener({ ruta: d.doc_ruta, blob: d.data });
    if (!contenido) return res.status(404).json({ success: false, data: null, error: 'Documento no encontrado' });
    /* Cabecera propia y no almacen.servir(): esta manda además `filename*` para
       que los nombres con acentos lleguen bien al navegador. */
    const fname = String(d.nombre || 'documento.pdf');
    const safe = fname.replace(/"/g, '').replace(/[^\x20-\x7E]/g, '_');
    res.setHeader('Content-Type', d.mime || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(contenido);
  } catch (e) { console.error('[verDocumento]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};


// POST /api/cartas/:id/verificable — registra la carta como documento verificable
// (QR → /verificar/<codigo>) con Firma Electrónica Simple del usuario que emite.
// Snapshot en duro con la VIGENCIA (fecha carta + vigencia_carta_dias). Idempotente.
const verificable = async (req, res) => {
  try {
    const id = parseInt(req.params.id) || 0;
    const [[c]] = await pool.query('SELECT * FROM cartas_aprobacion WHERE id=? LIMIT 1', [id]);
    if (!c) return res.status(404).json({ success: false, data: null, error: 'Carta no encontrada' });
    if (c.status !== 'APROBADA' && c.status !== 'OTORGADA')
      return res.status(400).json({ success: false, data: null, error: 'Solo cartas aprobadas llevan QR y firma' });
    const dias = await vigenciaDias();
    const base = c.fecha ? new Date(c.fecha) : new Date(c.fecha_creacion || Date.now());
    const vig = new Date(base); vig.setDate(vig.getDate() + dias);
    const datos = {
      documento: 'Carta de Aprobación de Crédito',
      operacion: c.op_carta, fecha: String(c.fecha || '').slice(0, 10),
      vigencia_dias: dias, valida_hasta: vig.toISOString().slice(0, 10),
      cliente: c.cliente, rut_cliente: c.rut_cliente,
      dealer: c.nombre_dealer, vehiculo: [c.marca, c.modelo, c.anio].filter(Boolean).join(' '),
      saldo_precio: c.saldo, plazo: c.plazo, acreedor: c.acreedor, estado: c.status,
    };
    const { registrarVerificable } = require('../../../../shared/verificacion');
    const usuario = ((req.usuario.nombre || '') + ' ' + (req.usuario.apellido || '')).trim() || req.usuario.email || '';
    const codigo = await registrarVerificable({
      tipo: 'carta_aprobacion', ref_tabla: 'cartas_aprobacion', ref_id: id,
      num_op: parseInt(c.op_carta) || null, rut: c.rut_cliente, nombre: c.cliente,
      datos, emitido_por: usuario,
      firmante: { id: req.usuario.id_usuario, nombre: usuario, cargo: 'AutoFácil SPA',
                  ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || null },
    });
    res.json({ success: true, data: { codigo, firmante: usuario, valida_hasta: datos.valida_hasta, firmado_at: new Date() }, error: null });
  } catch (e) { console.error('[cartas verificable]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ══════════════════════════════════════════════════════════════════════════
   CORRECCIÓN DE CARTAS DE APROBACIÓN
   Una carta emitida ya salió al dealer, tiene QR y firma electrónica: por eso
   NO se edita. Corregir = emitir una carta NUEVA (sufijo -C1, -C2…) y dejar la
   anterior en REEMPLAZADA apuntando a su reemplazo.

   Reglas del negocio:
   · La carta nueva queda anexada al MISMO crédito, y para eso los cuatro campos
     que definen la operación —monto del crédito, saldo precio, tasa y cuotas—
     deben quedar idénticos. Si alguno cambia, la corrección se bloquea: eso ya
     no es corregir un dato, es otra operación (va por anulación + carta nueva).
   · El QR y la FES de la carta vieja quedan NO VIGENTES, con el motivo
     "Reemplazada por la carta N° X" visible en /verificar.
   · El movimiento de cartola que aún no salió sigue a la carta nueva; uno ya
     enviado es historia y no se toca (misma regla que corregir dealer).
   ══════════════════════════════════════════════════════════════════════════ */

// Campos que la corrección puede cambiar. Todo lo que no esté acá no se toca.
const CAMPOS_CORREGIBLES = [
  'id_financiera', 'tipo', 'fecha', 'acreedor',
  'ejecutivo', 'ejecutivo_mail', 'ejecutivo_tel',
  'cliente', 'rut_cliente',
  'tipo_vehiculo', 'marca', 'modelo', 'anio', 'patente', 'prenda',
  'precio_venta', 'pie',
  'parque', 'nombre_dealer', 'rut_dealer', 'vendedor',
  'part_neto', 'part_iva', 'part_bruto',
  'seg_rdh', 'seg_cesantia', 'seg_rep', 'gps_monto', 'gastos_monto',
];
// Los que definen la operación: si cambian, ya no es la misma y no puede colgar del mismo crédito.
const CAMPOS_BLOQUEADOS = [
  { col: 'monto_credito_clp', lbl: 'Monto del crédito' },
  { col: 'saldo',             lbl: 'Saldo precio' },
  { col: 'tasa_credito',      lbl: 'Tasa' },
  { col: 'plazo',             lbl: 'Cuotas' },
];

const mismoNumero = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const x = Number(a), y = Number(b);
  if (isNaN(x) || isNaN(y)) return String(a).trim() === String(b).trim();
  return Math.abs(x - y) < 0.005;     // tolera el redondeo de DECIMAL, no un cambio real
};

/* Motor único de numeración con sufijo. Dos sufijos, dos historias distintas:
     -C  corrección  → se reemplaza una carta viva por otra con los mismos montos
     -R  redigitación → la carta anterior murió (venció/desistió/anuló/rechazó) y la
                        operación se vuelve a digitar desde cero
   No hay UNIQUE en op_carta y no puede haberlo: el número se arma como
   año + ID financiera + iniciales, así que redigitar la misma operación con el
   mismo ejecutivo produce el MISMO número, y eso es un flujo legítimo. La
   unicidad se garantiza acá, tomando el primer sufijo libre. */
async function siguienteOpSufijo(opOriginal, letra) {
  const base = String(opOriginal || '').replace(/-[CR]\d+$/i, '');
  if (!base) return { op: opOriginal, n: 0 };
  const [rows] = await pool.query(
    'SELECT op_carta FROM cartas_aprobacion WHERE op_carta = ? OR op_carta LIKE ? OR op_carta LIKE ?',
    [base, base + '-C%', base + '-R%']);
  const usados = new Set(rows.map(r => String(r.op_carta).toUpperCase()));
  for (let n = 1; n <= 99; n++) {
    const cand = `${base}-${letra}${n}`;
    if (!usados.has(cand.toUpperCase())) return { op: cand, n };
  }
  throw new Error(`Demasiadas cartas con el número ${base}.`);
}
const siguienteOpCorreccion = op => siguienteOpSufijo(op, 'C');

/* Número para una carta NUEVA: si nadie usa ese número, se respeta tal cual.
   Si ya existe (la operación se está redigitando porque su carta murió), sale con
   sufijo -R1, -R2… en vez de nacer duplicada como pasaba hasta ahora. */
async function opCartaLibre(op) {
  const n = String(op || '').trim();
  if (!n) return n;
  const [[ex]] = await pool.query('SELECT id FROM cartas_aprobacion WHERE op_carta = ? LIMIT 1', [n]);
  if (!ex) return n;
  const { op: libre } = await siguienteOpSufijo(n, 'R');
  return libre;
}

/* POST /api/cartas/:id/corregir  { campos:{...}, motivo } */
const corregirCarta = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { campos = {}, motivo } = req.body || {};
    if (!id) return res.status(400).json({ success: false, data: null, error: 'ID inválido.' });
    if (!String(motivo || '').trim())
      return res.status(400).json({ success: false, data: null, error: 'El motivo de la corrección es obligatorio.' });

    const [[orig]] = await pool.query('SELECT * FROM cartas_aprobacion WHERE id=? LIMIT 1', [id]);
    if (!orig) return res.status(404).json({ success: false, data: null, error: 'Carta no encontrada.' });

    if (orig.status !== 'APROBADA' && orig.status !== 'OTORGADA')
      return res.status(400).json({ success: false, data: null,
        error: `Solo se corrigen cartas aprobadas u otorgadas. Esta está ${orig.status} — una pendiente o rechazada se corrige con el lápiz de edición.` });
    if (orig.reemplazada_por_id)
      return res.status(400).json({ success: false, data: null,
        error: `Esta carta ya fue reemplazada por la N° ${orig.reemplazada_por_op}. Corrige esa, que es la vigente.` });

    // 1) Los cuatro campos que definen la operación deben quedar idénticos.
    const trabados = CAMPOS_BLOQUEADOS.filter(f =>
      campos[f.col] !== undefined && !mismoNumero(campos[f.col], orig[f.col]));
    if (trabados.length)
      return res.status(422).json({ success: false, data: null,
        error: `No se puede corregir ${trabados.map(f => f.lbl).join(', ')}: ${trabados.length > 1 ? 'esos campos definen' : 'ese campo define'} la operación y la carta quedaría sin calzar con el crédito. Para cambiarlo hay que anular la operación y emitir una carta nueva.` });

    // 2) La carta no puede contradecirse: precio − pie tiene que seguir dando el saldo.
    const precio = campos.precio_venta !== undefined ? Number(campos.precio_venta) : Number(orig.precio_venta);
    const pie    = campos.pie          !== undefined ? Number(campos.pie)          : Number(orig.pie);
    if (!isNaN(precio) && !isNaN(pie) && orig.saldo != null && !mismoNumero(precio - pie, orig.saldo))
      return res.status(422).json({ success: false, data: null,
        error: `Precio venta menos pie da ${Math.round(precio - pie).toLocaleString('es-CL')} y el saldo precio de la operación es ${Math.round(Number(orig.saldo)).toLocaleString('es-CL')}. Ajusta precio y pie para que cuadren, o la carta quedaría contradiciéndose.` });

    // 3) Fila nueva = copia de la original con los campos corregidos encima.
    const nueva = { ...orig };
    delete nueva.id;
    const cambios = [];
    for (const col of CAMPOS_CORREGIBLES) {
      if (campos[col] === undefined) continue;
      const antes = orig[col], ahora = campos[col] === '' ? null : campos[col];
      const igual = (antes == null && ahora == null) ||
        (antes != null && ahora != null && (mismoNumero(antes, ahora) || String(antes).trim() === String(ahora).trim()));
      if (igual) continue;
      nueva[col] = ahora;
      cambios.push({ campo: col, antes: antes == null ? null : String(antes), ahora: ahora == null ? null : String(ahora) });
    }
    if (!cambios.length)
      return res.status(400).json({ success: false, data: null, error: 'No cambiaste ningún dato: la carta corregida sería idéntica a la actual.' });

    const quien = req.usuario ? ([req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') || req.usuario.email) : 'Sistema';
    const { op: opNueva, n } = await siguienteOpCorreccion(orig.op_carta);

    // Hereda la aprobación original (los montos no cambiaron) y el vínculo al crédito.
    nueva.op_carta               = opNueva;
    nueva.status                 = 'APROBADA';
    nueva.corrige_a_id           = orig.id;
    nueva.corrige_a_op           = orig.op_carta;
    nueva.correccion_n           = n;
    nueva.motivo_correccion      = String(motivo).trim().slice(0, 400);
    nueva.corregida_por_nombre   = quien;
    nueva.fecha_correccion_carta = new Date();
    nueva.fecha_creacion         = new Date();
    nueva.reemplazada_por_id     = null;
    nueva.reemplazada_por_op     = null;
    /* Los espejos del RUT (rut_cliente_cuerpo/dv, rut_dealer_cuerpo/dv) son columnas
       VIRTUAL GENERATED: la base las recalcula sola desde el RUT y rechaza el INSERT
       si se les manda un valor. Se sacan de la copia. */
    const [gen] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='cartas_aprobacion' AND EXTRA LIKE '%GENERATED%'");
    for (const g of gen) delete nueva[g.COLUMN_NAME];

    /* Las columnas JSON (excepciones, excepciones_comentarios, revision_auto) vuelven
       de la BD ya parseadas. Si se pasan como objeto/array, mysql2 EXPANDE el array en
       una lista separada por comas — y un array vacío se expande a nada, dejando un
       hueco en el VALUES y rompiendo el INSERT. Hay que serializarlas de vuelta. */
    const aValor = v => (v != null && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v))
      ? JSON.stringify(v) : v;
    const cols = Object.keys(nueva);
    const [ins] = await pool.query(
      `INSERT INTO cartas_aprobacion (${cols.map(c => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      cols.map(c => aValor(nueva[c])));
    const idNueva = ins.insertId;

    // 4) La original queda REEMPLAZADA y apuntando a su reemplazo.
    await pool.query(
      `UPDATE cartas_aprobacion SET status='REEMPLAZADA', reemplazada_por_id=?, reemplazada_por_op=?,
         motivo_correccion=?, corregida_por_nombre=?, fecha_correccion_carta=NOW() WHERE id=?`,
      [idNueva, opNueva, String(motivo).trim().slice(0, 400), quien, id]);

    // 5) QR + Firma Electrónica Simple de la vieja: NO VIGENTE con el motivo a la vista.
    let qrAnulados = 0;
    try {
      const [docs] = await pool.query(
        "SELECT codigo FROM documentos_verificables WHERE tipo='carta_aprobacion' AND ref_tabla='cartas_aprobacion' AND ref_id=? AND anulado=0",
        [String(id)]);
      const { anularVerificable } = require('../../../../shared/verificacion');
      for (const d of docs) { await anularVerificable(d.codigo, `No vigente — reemplazada por la carta N° ${opNueva}`); qrAnulados++; }
    } catch (e) { console.error('[cartas corregir qr]', e.message); }

    // 6) La comisión que aún no salió en cartola sigue a la carta nueva; la enviada es historia.
    let cartola = 0;
    try {
      const [mv] = await pool.query(
        `UPDATE cartolas_movimientos SET id_carta=?, num_carta=?, nombre_dealer=?, rut_dealer=?, ejecutivo=?,
            nombre_cliente=?, rut_cliente=?, vendedor=?, acreedor=?, comision=?,
            observaciones = CONCAT(COALESCE(observaciones,''), ' | Carta corregida ', ?, '→', ?, ' por ', ?, ': ', ?)
          WHERE id_carta=? AND mes_cartola IS NULL`,
        [idNueva, opNueva, nueva.nombre_dealer, nueva.rut_dealer, nueva.ejecutivo,
         nueva.cliente, nueva.rut_cliente, nueva.vendedor, nueva.acreedor, nueva.part_bruto,
         orig.op_carta, opNueva, quien, String(motivo).trim().slice(0, 200), id]);
      cartola = mv.affectedRows;
    } catch (e) { console.error('[cartas corregir cartola]', e.message); }

    auditar({ req, accion: 'CORREGIR', modulo: 'cartas', entidad: 'carta_aprobacion', entidad_id: idNueva,
      detalle: `Corrigió la carta ${orig.op_carta} → ${opNueva} (${cambios.map(c => c.campo).join(', ')}). Motivo: ${String(motivo).trim()}`,
      rut: nueva.rut_cliente });

    res.json({ success: true, error: null, data: {
      id: idNueva, opCarta: opNueva, correccionN: n,
      reemplaza: { id, opCarta: orig.op_carta },
      cambios, qrAnulados, cartolaActualizada: cartola,
      creditoEnlazado: orig.numero_credito_creado || null,
    } });
  } catch (e) {
    console.error('[cartas corregir]', e.message);
    res.status(500).json({ success: false, data: null, error: 'No se pudo corregir la carta: ' + e.message });
  }
};

/* GET /api/cartas/:id/cadena — historial de correcciones de una carta (ambos sentidos). */
const cadenaCorrecciones = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ success: false, data: null, error: 'ID inválido.' });
    const [[c]] = await pool.query('SELECT id, op_carta, corrige_a_id FROM cartas_aprobacion WHERE id=? LIMIT 1', [id]);
    if (!c) return res.status(404).json({ success: false, data: null, error: 'Carta no encontrada.' });
    let raizId = c.id, guard = 0;
    while (guard++ < 50) {                                  // sube hasta la carta original
      const [[p]] = await pool.query('SELECT id, corrige_a_id FROM cartas_aprobacion WHERE id=? LIMIT 1', [raizId]);
      if (!p || !p.corrige_a_id) break;
      raizId = p.corrige_a_id;
    }
    const cadena = [];
    let cur = raizId; guard = 0;
    while (cur && guard++ < 50) {                            // y baja siguiendo los reemplazos
      const [[r]] = await pool.query(
        `SELECT id, op_carta, status, correccion_n, motivo_correccion, corregida_por_nombre,
                fecha_correccion_carta, fecha_creacion, reemplazada_por_id FROM cartas_aprobacion WHERE id=? LIMIT 1`, [cur]);
      if (!r) break;
      cadena.push({ ...r, esActual: r.id === id, vigente: !r.reemplazada_por_id });
      cur = r.reemplazada_por_id;
    }
    res.json({ success: true, data: cadena, error: null });
  } catch (e) { console.error('[cartas cadena]', e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── PUT /api/cartas/:id/corregir-dealer — corrige el dealer de una carta ya
   APROBADA (una pendiente/rechazada se corrige por el flujo normal de edición).
   Casilla propia aprob_corregir_dealer (por defecto solo Administrador), motivo
   obligatorio y auditado. Arrastra el cambio a los movimientos de cartola de la
   carta que aún NO salieron en una cartola (los enviados son historia). ── */
const corregirDealer = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { nombre_dealer, rut_dealer, motivo } = req.body || {};
    if (!id || !String(nombre_dealer || '').trim() || !String(rut_dealer || '').trim())
      return res.status(400).json({ success: false, data: null, error: 'nombre_dealer y rut_dealer requeridos' });
    if (!String(motivo || '').trim())
      return res.status(400).json({ success: false, data: null, error: 'El motivo es obligatorio' });
    const [[ca]] = await pool.query('SELECT id, op_carta, status, nombre_dealer, rut_dealer, id_credito_creado FROM cartas_aprobacion WHERE id=?', [id]);
    if (!ca) return res.status(404).json({ success: false, data: null, error: 'Carta no encontrada' });
    if (ca.status !== 'APROBADA')
      return res.status(400).json({ success: false, data: null, error: 'Esta corrección es solo para cartas APROBADAS — una pendiente o rechazada se corrige con el lápiz de edición' });
    const quien = req.usuario ? ([req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') || req.usuario.email) : 'Sistema';
    const nom = String(nombre_dealer).trim(), rut = String(rut_dealer).trim().toUpperCase();
    await pool.query('UPDATE cartas_aprobacion SET nombre_dealer=?, rut_dealer=? WHERE id=?', [nom, rut, id]);
    const [mv] = await pool.query(
      `UPDATE cartolas_movimientos SET nombre_dealer=?, rut_dealer=?,
         observaciones = CONCAT(COALESCE(observaciones,''), ' | Dealer corregido ', ?, '→', ?, ' por ', ?, ': ', ?)
       WHERE id_carta=? AND mes_cartola IS NULL`,
      [nom, rut, ca.nombre_dealer || '—', nom, quien, String(motivo).trim().slice(0, 200), id]);
    /* El CRÉDITO también lleva el dealer (comisiones, cartola, reportería): si se
       corrige la carta y no el crédito quedan dos verdades para el mismo hecho.
       Solo en meses abiertos — uno cerrado ya está liquidado. */
    let credito = 0;
    if (ca.id_credito_creado) {
      const { isMesCerrado } = require('../../../../shared/utils/mes-cerrado');
      const [[cr]] = await pool.query("SELECT id, DATE_FORMAT(mes,'%Y-%m') mes FROM creditos WHERE id=?", [ca.id_credito_creado]);
      if (cr && !(await isMesCerrado(cr.mes))) {
        const [rc] = await pool.query('UPDATE creditos SET automotora=?, rut_dealer=?, updated_at=NOW() WHERE id=?', [nom, rut, cr.id]);
        credito = rc.affectedRows;
      }
    }
    auditar({ req, accion: 'CORREGIR_DEALER', modulo: 'cartas', entidad: 'carta_aprobacion', entidad_id: id,
      detalle: `Corrigió dealer de la carta ${ca.op_carta}: ${ca.nombre_dealer || '—'} (${ca.rut_dealer || '—'}) → ${nom} (${rut}). Motivo: ${String(motivo).trim()}`,
      meta: { antes: { nombre: ca.nombre_dealer, rut: ca.rut_dealer }, despues: { nombre: nom, rut }, movimientos: mv.affectedRows, credito } });
    res.json({ success: true, data: { id, movimientos_actualizados: mv.affectedRows, credito_actualizado: credito }, error: null });
  } catch (e) {
    console.error('[cartas corregirDealer]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

module.exports = { getAll, upsert, otorgar, desistir, getVigencia, setVigencia, rentabilidadTier, fichaCompleta, corregirCarta, cadenaCorrecciones, cargaMasivaCartas, parseUnidad, parseAutofin, subirDocumento, listarDocumentos, verDocumento, verificable, corregirDealer,
  parseCotizacion, parseCartaCompromiso, parseCartaAutofin };   // para scripts/backfill-extracted-cartas.js
