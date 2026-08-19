'use strict';
/**
 * Órdenes de Pago (módulo general de cuentas por pagar a proveedores).
 * Distinto del flujo Post Venta (saldo precio / comisión): aquí las órdenes
 * se llenan a mano. Incluye base de proveedores, historial y estadísticas.
 *
 * Tablas: proveedores, ordenes_pago.
 * Numeración: correlativo único ODPaannnn → ODP260001 (libro central shared/ordenes-pago.js).
 */
const pool = require('../../../../shared/config/database');
const RUT = require('../../../../api-gateway/public/js/rut-core');  // enforcement: RUT canónico
const { auditar } = require('../../../../shared/audit');
const { emitirCorrelativo, anularCorrelativo } = require('../../../../shared/ordenes-pago');
const segregacion = require('../../../../shared/segregacion-pagos');   // quien emite no paga

/* ── Migración: tablas + módulo/funcionalidades/permisos (idempotente) ──────── */
require('../../../../shared/migrate').enFila('ordenes-pago', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS proveedores (
        id             INT AUTO_INCREMENT PRIMARY KEY,
        rut            VARCHAR(20)  NULL,
        nombre         VARCHAR(200) NOT NULL,
        giro           VARCHAR(200) NULL,
        email          VARCHAR(150) NULL,
        telefono       VARCHAR(40)  NULL,
        direccion      VARCHAR(300) NULL,
        contacto       VARCHAR(150) NULL,
        banco          VARCHAR(80)  NULL,
        tipo_cuenta    VARCHAR(40)  NULL,
        numero_cuenta  VARCHAR(60)  NULL,
        activo         TINYINT(1)   NOT NULL DEFAULT 1,
        created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_rut (rut), INDEX idx_nombre (nombre), INDEX idx_activo (activo)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[proveedores migration]', e.message); }

  // Código de actividad económica (SII) + comentario libre buscable — incremental.
  try {
    await pool.query(`ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS codigo_actividad VARCHAR(20) NULL`);
    await pool.query(`ALTER TABLE proveedores ADD COLUMN IF NOT EXISTS comentario VARCHAR(300) NULL`);
  } catch (e) { console.error('[proveedores alter cols]', e.message); }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS ordenes_pago (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        numero           VARCHAR(30)  NULL,
        id_proveedor     INT          NULL,
        proveedor_nombre VARCHAR(200) NULL,
        proveedor_rut    VARCHAR(20)  NULL,
        concepto         VARCHAR(300) NOT NULL,
        categoria        VARCHAR(80)  NULL,
        tipo_documento   VARCHAR(20)  NULL,
        numero_documento VARCHAR(40)  NULL,
        fecha_documento  DATE         NULL,
        monto            DECIMAL(14,2) NOT NULL DEFAULT 0,
        fecha_emision    DATE         NULL,
        fecha_pago       DATE         NULL,
        metodo_pago      VARCHAR(40)  NULL,
        estado           VARCHAR(20)  NOT NULL DEFAULT 'EMITIDA',
        observaciones    TEXT         NULL,
        id_usuario       INT          NULL,
        usuario_nombre   VARCHAR(200) NULL,
        created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_estado (estado), INDEX idx_prov (id_proveedor),
        INDEX idx_fecha (fecha_emision), INDEX idx_numero (numero)
      )`);
  } catch (e) { if (e.errno !== 1050) console.error('[ordenes_pago migration]', e.message); }

  // Auditoría de anulación (quién anuló y cuándo) — incremental.
  try {
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS anulada_por INT NULL`);
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS anulada_nombre VARCHAR(200) NULL`);
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS fecha_anulada DATETIME NULL`);
  } catch (e) { console.error('[ordenes_pago alter cols]', e.message); }

  // Tratamiento tributario: neto + impuesto (IVA/retención) = a pagar (monto). Incremental.
  try {
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS tratamiento VARCHAR(20) NULL`);
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS monto_neto DECIMAL(14,2) NULL`);
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS impuesto_pct DECIMAL(7,4) NULL`);
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS impuesto_monto DECIMAL(14,2) NULL`);
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS monto_bruto DECIMAL(14,2) NULL`);
    await pool.query(`ALTER TABLE ordenes_pago ADD COLUMN IF NOT EXISTS destino VARCHAR(200) NULL`);
  } catch (e) { console.error('[ordenes_pago alter impuestos]', e.message); }

  // Registro del módulo/card en el Home (idempotente).
  try {
    await pool.query(
      `INSERT IGNORE INTO modulos (id_modulo, nombre, descripcion, icono, ruta, orden, estado)
       VALUES (400001, 'Órdenes de Pago', 'Emisión manual de órdenes de pago a proveedores, historial, base de proveedores y estadísticas de compra', 'bi-cash-stack', '/ordenes-pago/', 107, 'activo')`);
    const funcs = [
      ['Emitir Orden de Pago',          'ordenes_pago_emitir',       '/ordenes-pago/emision/',      'bi-pencil-square'],
      ['Historial de Órdenes de Pago',  'ordenes_pago_historial',    '/ordenes-pago/historial/',    'bi-clock-history'],
      ['Base de Proveedores',           'ordenes_pago_proveedores',  '/ordenes-pago/proveedores/',  'bi-shop'],
      ['Estadísticas de Compra',        'ordenes_pago_estadisticas', '/ordenes-pago/estadisticas/', 'bi-bar-chart'],
    ];
    const idFunc = {};
    for (const [nombre, codigo, href, icono] of funcs) {
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [codigo]);
      if (ex) { idFunc[codigo] = ex.id_funcionalidad; continue; }
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (400001,?,?,?,?)`,
        [nombre, codigo, href, icono]);
      idFunc[codigo] = r.insertId;
    }
    // Permiso por defecto: solo Administrador (id 1). El resto se habilita en la matriz de Perfiles.
    for (const codigo of Object.keys(idFunc)) {
      const idf = idFunc[codigo];
      const [[pp]] = await pool.query('SELECT 1 ok FROM permisos_perfil WHERE id_perfil=1 AND id_funcionalidad=? LIMIT 1', [idf]);
      if (!pp) await pool.query('INSERT INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idf]);
    }
    console.log('[ordenes-pago] módulo registrado');
  } catch (e) { console.error('[ordenes-pago migration]', e.message); }

  // Backfill: congelar "en duro" las órdenes YA pagadas sin snapshot (retroactivo, 1 vez por orden).
  // Asegura primero que la columna exista (idempotente) para evitar carrera con shared/ordenes-pago.js.
  try {
    await pool.query(`ALTER TABLE op_correlativos ADD COLUMN IF NOT EXISTS snapshot_json LONGTEXT NULL`);
    await pool.query(`ALTER TABLE op_correlativos ADD COLUMN IF NOT EXISTS snapshot_at DATETIME NULL`);
    const [pend] = await pool.query(`SELECT id FROM op_correlativos WHERE pagada=1 AND snapshot_json IS NULL LIMIT 1000`);
    for (const r of pend) await congelarDocumento(r.id);
    if (pend.length) console.log('[ordenes-pago] órdenes pagadas congeladas en duro (backfill):', pend.length);
  } catch (e) { console.error('[ordenes-pago snapshot backfill]', e.message); }

  // Reparación idempotente: re-congelar snapshots de versión anterior (fechas mal formateadas,
  // desglose IVA de comisión, etc.). Se rehace si falta _v=DOC_VERSION o la fecha no es ISO.
  try {
    const [snaps] = await pool.query(`SELECT id, snapshot_json FROM op_correlativos WHERE snapshot_json IS NOT NULL LIMIT 2000`);
    let fixed = 0;
    for (const r of snaps) {
      let okSnap = false;
      try { const s = JSON.parse(r.snapshot_json); okSnap = s._v === DOC_VERSION && /^\d{4}-\d{2}-\d{2}$/.test(String(s.fecha_emision || '')); } catch (_) {}
      if (okSnap) continue;
      const [[oc]] = await pool.query('SELECT * FROM op_correlativos WHERE id=?', [r.id]);
      const snap = oc && await construirDocumento(oc);
      if (snap) { await pool.query('UPDATE op_correlativos SET snapshot_json=? WHERE id=?', [JSON.stringify(snap), r.id]); fixed++; }
    }
    if (fixed) console.log('[ordenes-pago] snapshots re-congelados (v' + DOC_VERSION + '):', fixed);
  } catch (e) { console.error('[ordenes-pago snapshot repair]', e.message); }
});

/* ── Helpers ────────────────────────────────────────────────────────────────── */
const norm = s => String(s ?? '').trim();
const normRut = r => RUT.normalizar(r) || String(r || '').replace(/[.\-\s]/g, '').toUpperCase();
const num = v => { const n = Number(String(v ?? '').replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, '')); return isNaN(n) ? null : n; };
const ESTADOS = ['EMITIDA', 'PAGADA', 'ANULADA'];
const fdate = v => { const s = norm(v); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const nombreUsuario = req => norm(`${(req.usuario || {}).nombre || ''} ${(req.usuario || {}).apellido || ''}`) || (req.usuario || {}).email || '—';

// % de impuesto desde el mantenedor Impuestos (con defaults si no existe la fila).
async function pctImpuesto(codigo, def) {
  try { const [[r]] = await pool.query('SELECT porcentaje FROM impuestos WHERE codigo=?', [codigo]); return r ? Number(r.porcentaje) : def; }
  catch (e) { return def; }
}

// Clase tributaria según el tipo de documento.
function claseDeTipo(tipo) {
  const t = String(tipo || '').trim();
  if (t === 'Factura') return 'IVA';                 // afecto a IVA
  if (t === 'Boleta de Honorarios') return 'RET';    // retención
  return 'EXENTO';                                   // Factura Exenta, Boleta Exenta, Nota de Cobro, Otros
}

// Dado tipo de documento + qué monto se ingresó (BRUTO|NETO) + su valor,
// calcula los tres montos + el A pagar. Relación: bruto = neto + impuesto.
//  IVA:       impuesto = neto·% ; a pagar = bruto (total con IVA).
//  Retención: impuesto = bruto·% ; a pagar = neto (líquido).
//  Exento:    impuesto = 0 ; bruto = neto = a pagar.
async function calcularDoc(tipo, base, valor) {
  const clase = claseDeTipo(tipo);
  const v = Math.round(Number(valor) || 0);
  const fromBruto = String(base || '').toUpperCase() === 'BRUTO';
  if (clase === 'EXENTO') return { clase, pct: 0, neto: v, bruto: v, imp: 0, aPagar: v };
  if (clase === 'IVA') {
    const pct = await pctImpuesto('IVA', 19);
    let neto, bruto, imp;
    if (fromBruto) { bruto = v; neto = Math.round(bruto / (1 + pct / 100)); imp = bruto - neto; }
    else { neto = v; imp = Math.round(neto * pct / 100); bruto = neto + imp; }
    return { clase, pct, neto, bruto, imp, aPagar: bruto };
  }
  const pct = await pctImpuesto('RETENCION_HONORARIOS', 15.25);
  let neto, bruto, imp;
  if (fromBruto) { bruto = v; imp = Math.round(bruto * pct / 100); neto = bruto - imp; }
  else { neto = v; bruto = Math.round(neto / (1 - pct / 100)); imp = bruto - neto; }
  return { clase, pct, neto, bruto, imp, aPagar: neto };
}

/* ════════════════ PROVEEDORES ════════════════ */

/* GET /api/ordenes-pago/proveedores?q=&incluir_inactivos=1 */
const listarProveedores = async (req, res) => {
  try {
    const q = norm(req.query.q);
    const incluirInactivos = req.query.incluir_inactivos === '1';
    const where = [];
    const args = [];
    if (!incluirInactivos) where.push('activo = 1');
    // UPPER en ambos lados: la BD es case-sensitive (utf8mb4_bin) y "gestio" no encontraba a GESTION
    if (q) { const qq = `%${q.toUpperCase()}%`; where.push('(UPPER(nombre) LIKE ? OR UPPER(rut) LIKE ? OR UPPER(giro) LIKE ? OR UPPER(codigo_actividad) LIKE ? OR UPPER(comentario) LIKE ?)'); args.push(qq, qq, qq, qq, qq); }
    const [rows] = await pool.query(
      `SELECT * FROM proveedores ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY nombre LIMIT 500`, args);
    res.json({ success: true, data: rows, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* POST /api/ordenes-pago/proveedores */
const crearProveedor = async (req, res) => {
  try {
    const b = req.body || {};
    const nombre = norm(b.nombre);
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'El nombre del proveedor es obligatorio' });
    const rut = b.rut ? normRut(b.rut) : null;
    if (rut) {
      const [[dup]] = await pool.query('SELECT id FROM proveedores WHERE rut=? LIMIT 1', [rut]);
      if (dup) return res.status(409).json({ success: false, data: null, error: 'Ya existe un proveedor con ese RUT' });
    }
    const [r] = await pool.query(
      `INSERT INTO proveedores (rut, nombre, giro, codigo_actividad, comentario, email, telefono, direccion, contacto, banco, tipo_cuenta, numero_cuenta)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [rut, nombre, norm(b.giro) || null, norm(b.codigo_actividad) || null, norm(b.comentario) || null,
       norm(b.email) || null, norm(b.telefono) || null, norm(b.direccion) || null,
       norm(b.contacto) || null, norm(b.banco) || null, norm(b.tipo_cuenta) || null, norm(b.numero_cuenta) || null]);
    auditar({ req, accion: 'CREAR', modulo: 'ordenes-pago', entidad: 'proveedor', entidad_id: r.insertId, detalle: `Creó proveedor ${nombre}` });
    res.json({ success: true, data: { id: r.insertId }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* PUT /api/ordenes-pago/proveedores/:id */
const actualizarProveedor = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const b = req.body || {};
    const nombre = norm(b.nombre);
    if (!nombre) return res.status(400).json({ success: false, data: null, error: 'El nombre del proveedor es obligatorio' });
    const rut = b.rut ? normRut(b.rut) : null;
    if (rut) {
      const [[dup]] = await pool.query('SELECT id FROM proveedores WHERE rut=? AND id<>? LIMIT 1', [rut, id]);
      if (dup) return res.status(409).json({ success: false, data: null, error: 'Ya existe otro proveedor con ese RUT' });
    }
    const [r] = await pool.query(
      `UPDATE proveedores SET rut=?, nombre=?, giro=?, codigo_actividad=?, comentario=?, email=?, telefono=?, direccion=?, contacto=?, banco=?, tipo_cuenta=?, numero_cuenta=? WHERE id=?`,
      [rut, nombre, norm(b.giro) || null, norm(b.codigo_actividad) || null, norm(b.comentario) || null,
       norm(b.email) || null, norm(b.telefono) || null, norm(b.direccion) || null,
       norm(b.contacto) || null, norm(b.banco) || null, norm(b.tipo_cuenta) || null, norm(b.numero_cuenta) || null, id]);
    if (!r.affectedRows) return res.status(404).json({ success: false, data: null, error: 'Proveedor no encontrado' });
    auditar({ req, accion: 'EDITAR', modulo: 'ordenes-pago', entidad: 'proveedor', entidad_id: id, detalle: `Editó proveedor ${nombre}` });
    res.json({ success: true, data: { id }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* DELETE /api/ordenes-pago/proveedores/:id — baja lógica (activo=0) */
const eliminarProveedor = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [[p]] = await pool.query('SELECT nombre, activo FROM proveedores WHERE id=?', [id]);
    if (!p) return res.status(404).json({ success: false, data: null, error: 'Proveedor no encontrado' });
    const nuevo = p.activo ? 0 : 1;   // toggle: desactivar / reactivar
    await pool.query('UPDATE proveedores SET activo=? WHERE id=?', [nuevo, id]);
    auditar({ req, accion: nuevo ? 'REACTIVAR' : 'DESACTIVAR', modulo: 'ordenes-pago', entidad: 'proveedor', entidad_id: id, detalle: `${nuevo ? 'Reactivó' : 'Desactivó'} proveedor ${p.nombre}` });
    res.json({ success: true, data: { id, activo: nuevo }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ════════════════ ÓRDENES DE PAGO ════════════════ */

/* GET /api/ordenes-pago/ordenes?estado=&origen=&q=&desde=&hasta=
   Ledger UNIFICADO: TODAS las órdenes de pago (libro central op_correlativos):
   GENERAL (módulo proveedores), SALDO y COMISION (Post Venta). */
const listarOrdenes = async (req, res) => {
  try {
    const where = ['1=1'];
    const args = [];
    const origen = norm(req.query.origen).toUpperCase();
    if (['SALDO', 'COMISION', 'GENERAL'].includes(origen)) { where.push('oc.origen = ?'); args.push(origen); }
    const desde = fdate(req.query.desde), hasta = fdate(req.query.hasta);
    if (desde) { where.push('DATE(oc.created_at) >= ?'); args.push(desde); }
    if (hasta) { where.push('DATE(oc.created_at) <= ?'); args.push(hasta); }
    const q = norm(req.query.q);
    if (q) {
      where.push('(oc.numero LIKE ? OR oc.concepto LIKE ? OR op.proveedor_nombre LIKE ? OR spv.nombre_dealer LIKE ? OR cpv.nombre_dealer LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
    const [rows] = await pool.query(`
      SELECT oc.id, oc.numero, oc.origen, oc.origen_id, oc.concepto, oc.monto, oc.created_at AS fecha_emision,
             oc.usuario_nombre, oc.id_usuario, oc.anulada, oc.anulada_nombre, oc.fecha_anulada, oc.pagada, oc.fecha_pagada,
             op.proveedor_nombre AS g_prov, op.tipo_documento AS g_tipodoc, op.numero_documento AS g_numdoc,
             op.estado AS g_estado, op.fecha_pago AS g_fechapago,
             pfc.numero_factura AS c_factura,
             spv.nombre_dealer AS s_dealer, cpv.nombre_dealer AS c_dealer,
             (SELECT 1 FROM postventa_etapas pe WHERE pe.id_seguimiento=spo.id_seguimiento AND pe.track='SALDO' AND pe.etapa='SALDO PRECIO PAGADO' LIMIT 1) AS saldo_pagado,
             (SELECT 1 FROM postventa_etapas pe WHERE pe.id_seguimiento=poc.id_seguimiento AND pe.track='COMISION' AND pe.etapa='COMISION PAGADA' LIMIT 1) AS comision_pagada
      FROM op_correlativos oc
      LEFT JOIN ordenes_pago op  ON oc.origen='GENERAL'  AND op.id  = oc.origen_id
      LEFT JOIN postventa_ordenes spo          ON oc.origen='SALDO'    AND spo.id = oc.origen_id
      LEFT JOIN postventa_seguimiento spv      ON spv.id = spo.id_seguimiento
      LEFT JOIN postventa_ordenes_comision poc ON oc.origen='COMISION' AND poc.id = oc.origen_id
      LEFT JOIN postventa_seguimiento cpv      ON cpv.id = poc.id_seguimiento
      LEFT JOIN postventa_facturas_comision pfc ON oc.origen='COMISION' AND pfc.id_seguimiento = poc.id_seguimiento
      WHERE ${where.join(' AND ')}
      ORDER BY oc.created_at DESC, oc.id DESC LIMIT 1000`, args);

    const ORIGEN_LBL = { SALDO: 'Saldo Precio', COMISION: 'Comisión', GENERAL: 'Otros' };
    const estFiltro = norm(req.query.estado).toUpperCase();
    // Segregación de funciones: las que emitió el propio usuario no las puede pagar él.
    // Se marca acá para que el botón lo diga en pantalla y no falle recién al apretarlo.
    const yo = (req.usuario || {});
    const dobleP = await segregacion.exigeDoblePersona();
    const nombreYo = String([yo.nombre, yo.apellido].filter(Boolean).join(' ')).trim().toLowerCase();
    let data = rows.map(r => {
      const esGen = r.origen === 'GENERAL';
      const proveedor = esGen ? r.g_prov : (r.origen === 'SALDO' ? r.s_dealer : r.c_dealer);
      let estado;
      if (r.anulada) estado = 'ANULADA';
      else if (esGen) estado = r.g_estado || 'EMITIDA';
      else estado = (r.origen === 'SALDO' ? r.saldo_pagado : r.comision_pagada) ? 'PAGADA' : 'EMITIDA';
      const documento = esGen ? [r.g_tipodoc, r.g_numdoc].filter(Boolean).join(' ')
                              : (r.origen === 'COMISION' && r.c_factura ? 'Factura ' + r.c_factura : '');
      const emitidaPorMi = dobleP && (
        (r.id_usuario != null && yo.id_usuario != null && Number(r.id_usuario) === Number(yo.id_usuario)) ||
        (r.id_usuario == null && nombreYo && String(r.usuario_nombre || '').trim().toLowerCase() === nombreYo));
      return {
        id: r.id, op_id: r.origen_id, origen: r.origen, origen_label: ORIGEN_LBL[r.origen] || r.origen,
        emitida_por_mi: !!emitidaPorMi,
        numero: r.numero, concepto: r.concepto || '—', monto: r.monto, fecha_emision: r.fecha_emision,
        usuario_nombre: r.usuario_nombre, proveedor_nombre: proveedor || '—', documento: documento || '—',
        estado, fecha_pago: r.fecha_pagada || (esGen ? r.g_fechapago : null),
        anulada_nombre: r.anulada_nombre, fecha_anulada: r.fecha_anulada,
        editable: esGen,   // editar (y anular por la vía general): solo las de proveedores
        /* Las de Post Venta SÍ se anulan acá, pero por su propia vía: hay que
           deshacer las etapas del seguimiento, cosa que las generales no tienen.
           Antes esto no existía en ninguna parte y una orden emitida por error
           quedaba viva para siempre, bloqueando la reemisión. */
        anulable_pv: (!esGen && estado === 'EMITIDA' && !r.anulada),
        pagable: (estado === 'EMITIDA' && !r.anulada),   // se puede pagar desde el historial
      };
    });
    if (ESTADOS.includes(estFiltro)) data = data.filter(o => o.estado === estFiltro);

    const resumen = { emitidas: 0, pagadas: 0, monto_emitido: 0, monto_pagado: 0 };
    data.forEach(o => {
      if (o.estado === 'EMITIDA') { resumen.emitidas++; resumen.monto_emitido += Number(o.monto || 0); }
      if (o.estado === 'PAGADA')  { resumen.pagadas++;  resumen.monto_pagado  += Number(o.monto || 0); }
    });
    res.json({ success: true, data, resumen, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* GET /api/ordenes-pago/ordenes/:id  (:id = ordenes_pago.id) — orden general */
const getOrden = async (req, res) => {
  try {
    const [[o]] = await pool.query('SELECT * FROM ordenes_pago WHERE id=?', [parseInt(req.params.id)]);
    if (!o) return res.status(404).json({ success: false, data: null, error: 'Orden no encontrada' });
    res.json({ success: true, data: o, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

const ORIGEN_LBL = { SALDO: 'Saldo Precio', COMISION: 'Comisión', GENERAL: 'Otros' };
// Versión del esquema del documento congelado. Subir cuando cambie la lógica de armado
// (fechas, desglose IVA, datos bancarios, etc.) para forzar el re-congelado idempotente.
// v6 (31-07-2026): datos de transferencia estructurados también en las órdenes generales.
const DOC_VERSION = 7;   // v7: tipo de cuenta por defecto "Cuenta Corriente" cuando la ficha no lo indica
// YYYY-MM-DD. mysql2 devuelve DATETIME/DATE como objeto Date: formatear en hora de Chile
// (NO usar String(Date).slice, que da "Tue Jun 23"). Si ya viene string ISO, recortar.
const soloFecha = v => {
  if (!v) return null;
  if (v instanceof Date) return v.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
  return String(v).slice(0, 10);
};

/* Construye el documento "Solicitud de Pago" EN VIVO desde las tablas fuente
   (GENERAL en ordenes_pago; SALDO/COMISION desde el seguimiento + dealer + factura).
   Devuelve el objeto de datos del documento, o null si la orden de origen no existe. */
async function construirDocumento(oc) {
  // GENERAL: la orden vive completa en ordenes_pago (mismo shape que getOrden).
  if (oc.origen === 'GENERAL') {
    const [[op]] = await pool.query('SELECT * FROM ordenes_pago WHERE id = ?', [oc.origen_id]);
    if (!op) return null;
    const estado = oc.anulada ? 'ANULADA' : (oc.pagada ? 'PAGADA' : (op.estado || 'EMITIDA'));
    /* Datos de transferencia ESTRUCTURADOS (banco, tipo, N° cuenta, titular y RUT).
       Se leen EN VIVO de la ficha del proveedor —una sola fuente— y no del string
       `destino`, que es una foto del momento de la emisión: si la orden se emitió
       antes de cargarle la cuenta al proveedor, ese string quedaba vacío para siempre.
       `destino` se conserva como respaldo para las órdenes con proveedor de nombre libre. */
    let deposito = null;
    if (op.id_proveedor) {
      const [[p]] = await pool.query(
        'SELECT nombre, rut, banco, tipo_cuenta, numero_cuenta FROM proveedores WHERE id=?', [op.id_proveedor]);
      if (p && p.numero_cuenta) deposito = {
        banco: p.banco || null, tipo_cuenta: p.tipo_cuenta || 'Cuenta Corriente', num_cuenta: p.numero_cuenta,
        titular: p.nombre || op.proveedor_nombre || null, rut: p.rut || op.proveedor_rut || null,
      };
    }
    return Object.assign({}, op, {
      origen: 'GENERAL', origen_label: ORIGEN_LBL.GENERAL, numero: oc.numero || op.numero, estado,
      deposito,
      sin_datos_banco: !deposito && !op.destino,
      fecha_pago: soloFecha(oc.fecha_pagada) || op.fecha_pago, metodo_pago: oc.metodo_pago || op.metodo_pago,
      anulada_nombre: oc.anulada_nombre || op.anulada_nombre, fecha_anulada: oc.fecha_anulada || op.fecha_anulada,
      _v: DOC_VERSION,
    });
  }
  // SALDO / COMISION (Post Venta): se arma el documento desde el seguimiento + dealer (+ factura en comisión).
  const esCom = oc.origen === 'COMISION';
  const sql = esCom
    ? `SELECT s.id AS id_seg, s.num_op, s.financiera,
              COALESCE(NULLIF(d.nombre_indexa,''), d.nombre_razon, c.nombre_local, s.nombre_dealer) AS dealer_nombre,
              COALESCE(c.rut_dealer, d.rut) AS dealer_rut, d.num_cuenta, d.banco,
              d.cuenta_tipo, d.tipo_cuenta, d.nombre_cuenta, d.rut_pago,
              fc.numero_factura, fc.es_boleta, fc.fecha_factura,
              fc.monto_bruto AS fc_base, fc.impuesto_pct AS fc_pct, fc.impuesto_monto AS fc_imp, fc.monto_liquido AS fc_liquido,
              (SELECT 1 FROM postventa_etapas pe WHERE pe.id_seguimiento=s.id AND pe.track='COMISION' AND pe.etapa='COMISION PAGADA' LIMIT 1) AS pagado
         FROM postventa_ordenes_comision poc
         JOIN postventa_seguimiento s ON s.id = poc.id_seguimiento
         LEFT JOIN creditos c ON c.id = s.id_credito
         LEFT JOIN dealers  d ON d.id_dealer = c.id_dealer
         LEFT JOIN postventa_facturas_comision fc ON fc.id_seguimiento = s.id
        WHERE poc.id = ?`
    : `SELECT s.id AS id_seg, s.num_op, s.financiera, s.saldo_precio,
              COALESCE(NULLIF(d.nombre_indexa,''), d.nombre_razon, c.nombre_local, s.nombre_dealer) AS dealer_nombre,
              COALESCE(c.rut_dealer, d.rut) AS dealer_rut, d.num_cuenta, d.banco,
              d.cuenta_tipo, d.tipo_cuenta, d.nombre_cuenta, d.rut_pago,
              (SELECT 1 FROM postventa_etapas pe WHERE pe.id_seguimiento=s.id AND pe.track='SALDO' AND pe.etapa='SALDO PRECIO PAGADO' LIMIT 1) AS pagado
         FROM postventa_ordenes spo
         JOIN postventa_seguimiento s ON s.id = spo.id_seguimiento
         LEFT JOIN creditos c ON c.id = s.id_credito
         LEFT JOIN dealers  d ON d.id_dealer = c.id_dealer
        WHERE spo.id = ?`;
  const [rws] = await pool.query(sql, [oc.origen_id]);
  const row = rws[0] || {};
  let monto = Number(oc.monto) || 0;   // = A pagar (líquido del correlativo)
  const estado = oc.anulada ? 'ANULADA' : ((oc.pagada || row.pagado) ? 'PAGADA' : 'EMITIDA');

  // Datos de depósito: ficha del dealer (una sola fuente). Si el crédito no tiene
  // id_dealer (JOIN vacío), fallback por RUT o razón social del seguimiento.
  let dep = { banco: row.banco, num_cuenta: row.num_cuenta, cuenta_tipo: row.cuenta_tipo,
              tipo_cuenta: row.tipo_cuenta, titular: row.nombre_cuenta, rut_pago: row.rut_pago };
  if (!dep.num_cuenta && (row.dealer_rut || row.dealer_nombre)) {
    const [[d2]] = await pool.query(
      `SELECT banco, num_cuenta, cuenta_tipo, tipo_cuenta, nombre_cuenta, rut_pago, rut, nombre_razon
         FROM dealers WHERE (rut = ? AND ? != '') OR nombre_razon = ? OR nombre_indexa = ? LIMIT 1`,
      [row.dealer_rut || '', row.dealer_rut || '', row.dealer_nombre || '', row.dealer_nombre || '']);
    if (d2) {
      dep = { banco: d2.banco, num_cuenta: d2.num_cuenta, cuenta_tipo: d2.cuenta_tipo,
              tipo_cuenta: d2.tipo_cuenta, titular: d2.nombre_cuenta, rut_pago: d2.rut_pago || d2.rut };
      if (!row.dealer_rut && d2.rut) row.dealer_rut = d2.rut;   // completa el RUT del proveedor
    }
  }
  const deposito = dep.num_cuenta ? {
    banco: dep.banco || null,
    tipo_cuenta: dep.tipo_cuenta || dep.cuenta_tipo || 'Cuenta Corriente',
    num_cuenta: dep.num_cuenta,
    titular: dep.titular || row.dealer_nombre || null,
    rut: dep.rut_pago || row.dealer_rut || null,
  } : null;
  const destino = deposito
    ? [deposito.banco, deposito.tipo_cuenta, 'N° ' + deposito.num_cuenta].filter(Boolean).join(' · ')
    : ([row.num_cuenta, row.banco].filter(Boolean).join(' · ') || null);

  // Desglose tributario. Saldo Precio: exento. Comisión: usa el desglose CONGELADO de la
  // factura/boleta (postventa_facturas_comision: base/neto, impuesto, líquido).
  //   Factura (IVA):   neto=base, IVA=imp, bruto=neto+IVA=líquido, A pagar=bruto.
  //   Boleta (Retenc): bruto=base honorarios, retención=imp, neto=líquido, A pagar=neto.
  let tratamiento = 'EXENTO', neto = monto, imp = 0, bruto = monto, pct = 0;
  if (esCom) {
    const fcBase = Number(row.fc_base) || 0, fcImp = Number(row.fc_imp) || 0, fcLiq = Number(row.fc_liquido) || 0, fcPct = Number(row.fc_pct) || 0;
    if (fcImp > 0) {
      if (row.es_boleta) { tratamiento = 'RET'; bruto = fcBase || monto; imp = fcImp; neto = fcLiq || monto; pct = fcPct || 15.25; }
      else { tratamiento = 'IVA'; neto = fcBase || monto; imp = fcImp; bruto = fcLiq || (neto + imp); pct = fcPct || 19; }
    }
  }

  // Saldo Precio de AUTOFIN: el documento desglosa Saldo + Transferencia + Limitación de
  // dominio; A pagar = la suma de los tres (exento). Los fijos viven en parametros_credito.
  let desglose = null;
  if (!esCom && String(row.financiera || '').toUpperCase() === 'AUTOFIN') {
    const base = Number(row.saldo_precio) || 0;
    const [pr] = await pool.query(
      "SELECT clave, valor FROM parametros_credito WHERE clave IN ('autofin_inscripcion','autofin_limitacion')");
    let insc = 0, lim = 0;
    pr.forEach(p => { if (p.clave === 'autofin_inscripcion') insc = parseFloat(p.valor) || 0; if (p.clave === 'autofin_limitacion') lim = parseFloat(p.valor) || 0; });
    desglose = [
      { label: 'Saldo Precio', monto: base },
      { label: 'Transferencia', monto: insc },
      { label: 'Limitación de Dominio', monto: lim },
    ];
    monto = base + insc + lim; neto = monto; bruto = monto;
  }

  return {
    id: oc.id, origen: oc.origen, origen_label: ORIGEN_LBL[oc.origen] || oc.origen,
    numero: oc.numero, concepto: (oc.concepto || (esCom ? 'Comisión' : 'Saldo Precio')) + (row.financiera ? ' (' + row.financiera + ')' : ''),
    categoria: esCom ? 'PAGO DE COMISIÓN' : 'SALDO DE PRECIO',
    proveedor_nombre: row.dealer_nombre || '—', proveedor_rut: row.dealer_rut || '',
    tipo_documento: esCom ? (row.es_boleta ? 'Boleta de Honorarios' : 'Factura') : null,
    numero_documento: esCom ? (row.numero_factura || null) : null,
    fecha_documento: esCom ? soloFecha(row.fecha_factura) : null,
    tratamiento, monto_bruto: bruto, monto_neto: neto, impuesto_pct: pct, impuesto_monto: imp, monto, desglose,
    destino, deposito, sin_datos_banco: !deposito && !destino,
    fecha_emision: soloFecha(oc.created_at), fecha_pago: soloFecha(oc.fecha_pagada),
    metodo_pago: oc.metodo_pago, estado, usuario_nombre: oc.usuario_nombre,
    anulada_nombre: oc.anulada_nombre, fecha_anulada: oc.fecha_anulada, num_op: row.num_op, _v: DOC_VERSION,
  };
}

/* GET /api/ordenes-pago/ordenes/:id/documento  (:id = op_correlativos.id)
   Documento "Solicitud de Pago" UNIFICADO (GENERAL/SALDO/COMISION).
   Si la orden está congelada (snapshot_json), devuelve el documento EN DURO sin
   recalcular: una orden pagada nunca cambia aunque cambien las tablas fuente. */
const getDocumento = async (req, res) => {
  try {
    const ocId = parseInt(req.params.id);
    const [[oc]] = await pool.query('SELECT * FROM op_correlativos WHERE id=?', [ocId]);
    if (!oc) return res.status(404).json({ success: false, data: null, error: 'Orden no encontrada' });
    let data = null, congelada = false;
    if (oc.snapshot_json) { try { data = JSON.parse(oc.snapshot_json); congelada = true; } catch (_) { data = null; } }
    if (!data) data = await construirDocumento(oc);
    if (!data) return res.status(404).json({ success: false, data: null, error: 'Orden no encontrada' });
    if (congelada) data.congelada = true;
    /* Facturas ADJUNTAS a la orden (respaldo del almacén): EN VIVO siempre —
       aunque el documento esté congelado, un adjunto subido después debe verse. */
    try {
      let facturas = [];
      if (oc.origen === 'GENERAL') {
        [facturas] = await pool.query("SELECT id, nombre FROM postventa_factura_docs WHERE origen='ODP' AND ref_id=? ORDER BY id", [oc.origen_id]);
      } else if (oc.origen === 'COMISION') {
        const [[po]] = await pool.query('SELECT id_seguimiento FROM postventa_ordenes_comision WHERE id=?', [oc.origen_id]);
        if (po) [facturas] = await pool.query("SELECT id, nombre FROM postventa_factura_docs WHERE origen='COMISION' AND ref_id=? ORDER BY id", [po.id_seguimiento]);
      } else if (oc.origen === 'PARQUE') {
        [facturas] = await pool.query("SELECT id, nombre FROM postventa_factura_docs WHERE origen='PARQUE' AND ref_id=? ORDER BY id", [oc.origen_id]);
      }
      data.facturas = facturas;
    } catch (_) { data.facturas = []; }
    // Datos del timbre "PAGADO" (caja, fecha y hora del pago), formateados en hora de Chile.
    if (oc.pagada) {
      try {
        const [[p]] = await pool.query(
          `SELECT DATE_FORMAT(o.fecha_pagada,'%d/%m/%Y') AS fecha, DATE_FORMAT(o.fecha_pagada,'%H:%i:%s') AS hora, cj.nombre AS caja
           FROM op_correlativos o LEFT JOIN cajas cj ON cj.id_caja = o.id_caja WHERE o.id = ?`, [oc.id]);
        if (p) data.pago = { caja: p.caja || (oc.id_caja ? 'Caja #' + oc.id_caja : null), fecha: p.fecha, hora: p.hora };
      } catch (_) {}
    }
    res.json({ success: true, data, error: null });
  } catch (e) {
    console.error('[ordenes-pago getDocumento]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

// Congela el documento "en duro": guarda el snapshot inmutable en el libro central.
// Idempotente (no re-congela si ya tiene snapshot). Se llama al pagar.
async function congelarDocumento(ocId) {
  try {
    const [[oc]] = await pool.query('SELECT * FROM op_correlativos WHERE id=?', [ocId]);
    if (!oc || oc.snapshot_json) return;
    const snap = await construirDocumento(oc);
    if (snap) await pool.query('UPDATE op_correlativos SET snapshot_json=?, snapshot_at=NOW() WHERE id=?', [JSON.stringify(snap), ocId]);
  } catch (e) { console.error('[ordenes-pago congelarDocumento]', e.message); }
}

/* POST /api/ordenes-pago/ordenes — emisión manual */
const crearOrden = async (req, res) => {
  try {
    const b = req.body || {};
    const concepto = norm(b.concepto);
    if (!concepto) return res.status(400).json({ success: false, data: null, error: 'El concepto es obligatorio' });
    // Tipo de documento define el impuesto; el usuario ingresa Bruto o Neto y el sistema calcula el resto.
    const tipoDoc = norm(b.tipo_documento) || 'Factura';
    const base = String(b.monto_base || '').toUpperCase() === 'BRUTO' ? 'BRUTO' : 'NETO';
    const valor = num(base === 'BRUTO' ? b.monto_bruto : b.monto_neto);
    if (valor == null || valor <= 0) return res.status(400).json({ success: false, data: null, error: 'El monto debe ser mayor a 0' });

    // Proveedor: por id (de la base) o nombre libre.
    let idProv = parseInt(b.id_proveedor) || null;
    let provNombre = norm(b.proveedor_nombre);
    let provRut = b.proveedor_rut ? normRut(b.proveedor_rut) : null;
    let destino = null;
    if (idProv) {
      const [[p]] = await pool.query('SELECT nombre, rut, banco, tipo_cuenta, numero_cuenta FROM proveedores WHERE id=?', [idProv]);
      if (!p) return res.status(400).json({ success: false, data: null, error: 'Proveedor no encontrado' });
      provNombre = p.nombre; provRut = p.rut;
      destino = [p.tipo_cuenta || (p.numero_cuenta ? 'Cuenta Corriente' : null), p.numero_cuenta].filter(Boolean).join(' ') + (p.banco ? ' · ' + p.banco : '');
      destino = norm(destino) || null;
    }
    if (!provNombre) return res.status(400).json({ success: false, data: null, error: 'Debe indicar el proveedor' });

    // El sistema calcula bruto/neto/impuesto y A pagar a partir del tipo de documento.
    const m = await calcularDoc(tipoDoc, base, valor);

    const fechaEmision = fdate(b.fecha_emision) || require('../../../../shared/fecha-chile').hoyISO(); // día de Chile, no UTC
    const [r] = await pool.query(
      `INSERT INTO ordenes_pago
        (id_proveedor, proveedor_nombre, proveedor_rut, concepto, categoria, tipo_documento, numero_documento, fecha_documento,
         tratamiento, monto_bruto, monto_neto, impuesto_pct, impuesto_monto, monto, destino, fecha_emision, metodo_pago, estado, observaciones, id_usuario, usuario_nombre)
       VALUES (?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?,?,?, 'EMITIDA', ?,?,?)`,
      [idProv, provNombre, provRut, concepto, norm(b.categoria) || null, tipoDoc,
       norm(b.numero_documento) || null, fdate(b.fecha_documento),
       m.clase, m.bruto, m.neto, m.pct, m.imp, m.aPagar, destino, fechaEmision, norm(b.metodo_pago) || null,
       norm(b.observaciones) || null, (req.usuario || {}).id_usuario || null, nombreUsuario(req)]);

    // Correlativo global único ODP- (libro central op_correlativos)
    const { numero } = await emitirCorrelativo({
      origen: 'GENERAL', origen_id: r.insertId, concepto: `${concepto} — ${provNombre}`,
      monto: m.aPagar, id_usuario: (req.usuario || {}).id_usuario || null, usuario_nombre: nombreUsuario(req) });
    await pool.query('UPDATE ordenes_pago SET numero=? WHERE id=?', [numero, r.insertId]);

    auditar({ req, accion: 'CREAR', modulo: 'ordenes-pago', entidad: 'orden_pago', entidad_id: r.insertId, detalle: `Emitió ${numero} a ${provNombre} por $${m.aPagar.toLocaleString('es-CL')}` });

    /* Adjunto (factura/boleta) en el MISMO request de la emisión: así el correo
       automático de abajo ya sale con el documento. */
    if (b.adjunto && b.adjunto.base64) {
      try {
        const pv = require('../../../postventa/src/controllers/postventa.controller');
        const out = await pv.guardarFacturaDoc({ origen: 'ODP', ref_id: r.insertId,
          nombre: b.adjunto.nombre || 'documento', mime: b.adjunto.mime || null,
          buffer: Buffer.from(String(b.adjunto.base64), 'base64'), usuario: nombreUsuario(req) });
        auditar({ req, accion: 'CREAR', modulo: 'postventa', entidad: 'factura_doc', entidad_id: out.id,
          detalle: `Subió factura "${b.adjunto.nombre}" (ODP #${r.insertId}, ${Math.round(out.bytes / 1024)} KB)` });
      } catch (e) { console.error('[ordenes-pago adjunto]', e.message); }
    }

    /* Correo AUTOMÁTICO a Contabilidad al emitir (igual que las ODP de Post
       Venta — antes solo salía si alguien lo mandaba a mano desde el Historial,
       y las órdenes "no le llegaban a nadie"). Plantilla paramétrica
       odp_proveedor_contabilidad; adjunta la factura si se subió. Nunca frena
       la emisión. */
    (async () => {
      try {
        let to = 'contabilidad@autofacilchile.cl';
        try {
          const [[row]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='correo_contabilidad'");
          if (row) { const v = JSON.parse(row.valor); if (v && String(v).trim()) to = String(v).trim(); }
        } catch (_) {}
        const adjuntos = await require('../../../postventa/src/controllers/postventa.controller')
          .adjuntosFactura('ODP', [r.insertId]).catch(() => []);
        const env = await require('../../../../shared/plantillas-correo').enviar({
          codigo: 'odp_proveedor_contabilidad', to: [to],
          adjuntos: adjuntos.length ? adjuntos : undefined,
          datos: {
            ODP: numero, PROVEEDOR: provNombre, RUT: provRut || '—', CONCEPTO: concepto,
            DOC: `${tipoDoc}${norm(b.numero_documento) ? ' N° ' + norm(b.numero_documento) : ''}`,
            TOTAL: '$' + Math.round(m.aPagar).toLocaleString('es-CL'),
            METODO: norm(b.metodo_pago) || '—', QUIEN: nombreUsuario(req),
          },
        });
        if (!env.enviado) console.warn('[ordenes-pago correo emisión]', numero, env.motivo);
      } catch (e) { console.error('[ordenes-pago correo emisión]', e.message); }
    })();

    res.json({ success: true, data: { id: r.insertId, numero }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* PUT /api/ordenes-pago/ordenes/:id/estado — marcar PAGADA / ANULADA / volver a EMITIDA */
const cambiarEstadoOrden = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const estado = norm((req.body || {}).estado).toUpperCase();
    if (!ESTADOS.includes(estado)) return res.status(400).json({ success: false, data: null, error: 'Estado inválido' });
    // Solo el Administrador puede ANULAR órdenes de pago.
    if (estado === 'ANULADA' && (req.usuario || {}).perfil_nombre !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Solo el Administrador puede anular órdenes de pago' });
    /* EL PAGO NO SE REGISTRA POR ACÁ. Esta ruta escribe solo en `ordenes_pago`,
       así que marcar PAGADA desde aquí dejaba el pago fuera del libro central
       (`op_correlativos`): sin egreso de caja, sin snapshot en duro, y el
       historial —que se arma desde el correlativo— seguiría mostrando la orden
       como impaga. De paso se saltaba lo que sí valida `/pagar`: la segregación
       de funciones (quien emite no paga) y la ventana horaria de la caja.
       Ninguna pantalla lo usaba así, pero la puerta estaba abierta. */
    if (estado === 'PAGADA')
      return res.status(400).json({ success: false, data: null,
        error: 'El pago se registra desde la caja (Órdenes de Pago → Pagar), no cambiando el estado: así queda el egreso en el libro central y se respeta la segregación de funciones.' });

    const [[o]] = await pool.query('SELECT numero, estado FROM ordenes_pago WHERE id=?', [id]);
    if (!o) return res.status(404).json({ success: false, data: null, error: 'Orden no encontrada' });
    // Orden ya pagada = EN DURO: no se puede modificar ni anular.
    if (o.estado === 'PAGADA')
      return res.status(409).json({ success: false, data: null, error: 'La orden ya está pagada y queda en duro: no puede modificarse ni anularse' });

    if (estado === 'ANULADA') {
      // El correlativo NO se libera: queda reservado y marcado como anulado, con quién y cuándo.
      const quien = nombreUsuario(req), idU = (req.usuario || {}).id_usuario || null;
      await pool.query(
        `UPDATE ordenes_pago SET estado='ANULADA', anulada_por=?, anulada_nombre=?, fecha_anulada=NOW() WHERE id=?`,
        [idU, quien, id]);
      await anularCorrelativo({ numero: o.numero, origen: 'GENERAL', origen_id: id, id_usuario: idU, usuario_nombre: quien });
    } else {
      // Volver a EMITIDA: se limpia la fecha de pago porque la orden deja de estarlo.
      await pool.query(
        `UPDATE ordenes_pago SET estado=?, fecha_pago=NULL WHERE id=?`, [estado, id]);
    }
    auditar({ req, accion: estado === 'ANULADA' ? 'ANULAR' : 'EDITAR', modulo: 'ordenes-pago', entidad: 'orden_pago', entidad_id: id, detalle: `${o.numero || id}: ${o.estado} → ${estado}` });
    /* El asiento del pago NO se genera acá: por esta ruta ya no se paga. Lo hace
       `registrarPagoOrden` (la ruta /pagar), que es donde el pago existe de
       verdad — con su egreso de caja y su snapshot en duro. Mantener acá una
       segunda copia de esa contabilización sería un segundo motor del mismo
       hecho, y el día que cambien las cuentas cambiaría solo uno de los dos. */
    res.json({ success: true, data: { id, estado }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ════════════════ ESTADÍSTICAS ════════════════ */

/* GET /api/ordenes-pago/estadisticas?anio= — compras mensuales por proveedor (excluye ANULADA) */
const estadisticas = async (req, res) => {
  try {
    // Años disponibles.
    const [aniosRows] = await pool.query(
      `SELECT DISTINCT YEAR(fecha_emision) anio FROM ordenes_pago WHERE estado<>'ANULADA' AND fecha_emision IS NOT NULL ORDER BY anio DESC`);
    const anios = aniosRows.map(r => r.anio);
    const anio = parseInt(req.query.anio) || anios[0] || new Date().getFullYear();

    const [rows] = await pool.query(
      `SELECT COALESCE(proveedor_nombre,'(sin proveedor)') proveedor, MONTH(fecha_emision) mes,
              SUM(monto) total, COUNT(*) n
         FROM ordenes_pago
        WHERE estado<>'ANULADA' AND YEAR(fecha_emision)=?
        GROUP BY proveedor, mes
        ORDER BY proveedor`, [anio]);

    res.json({ success: true, data: { anio, anios, filas: rows }, error: null });
  } catch (e) {
    res.status(500).json({ success: false, data: null, error: e.message });
  }
};

/* ════════════════ ENVÍO A CONTABILIDAD ════════════════ */

// POST /api/ordenes-pago/ordenes/:id/enviar-correo — envía la orden a Contabilidad.
// Destinatario server-controlled (config correo_contabilidad, compartida con Post Venta);
// CC al usuario que envía. El cuerpo (html) lo arma el frontend con el documento y la firma del emisor.
const enviarCorreoOrden = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { asunto, html } = req.body || {};
    if (!html || typeof html !== 'string' || !html.trim())
      return res.status(400).json({ success: false, data: null, error: 'Falta el contenido del correo' });
    if (html.length > 500000)
      return res.status(400).json({ success: false, data: null, error: 'El contenido del correo es demasiado grande' });
    const [[o]] = await pool.query('SELECT numero FROM ordenes_pago WHERE id=?', [id]);
    if (!o) return res.status(404).json({ success: false, data: null, error: 'Orden no encontrada' });

    let to = 'contabilidad@autofacilchile.cl';
    try {
      const [[row]] = await pool.query("SELECT valor FROM postventa_config WHERE clave='correo_contabilidad'");
      if (row) { const v = JSON.parse(row.valor); if (v && String(v).trim()) to = String(v).trim(); }
    } catch (_) {}
    const cc = (req.usuario && req.usuario.email) || undefined;
    const { enviarCorreo } = require('../../../../shared/mailer');
    // Documento de respaldo (factura/boleta subida a la orden): viaja adjunto
    let attachments;
    try {
      attachments = await require('../../../postventa/src/controllers/postventa.controller').adjuntosFactura('ODP', [id]);
      if (!attachments.length) attachments = undefined;
    } catch (_) {}
    const r = await enviarCorreo({ to, cc, subject: asunto || `Orden de Pago ${o.numero || ''} — AutoFácil`, html, attachments });
    if (!r.ok) return res.status(422).json({ success: false, data: null, error: r.error || 'No se pudo enviar el correo' });
    auditar({ req, accion: 'ENVIAR', modulo: 'ordenes-pago', entidad: 'orden_pago', entidad_id: id, detalle: `Envió por correo la Orden de Pago ${o.numero || id} a ${to}, CC ${cc || '—'}` });
    res.json({ success: true, data: { to, cc }, error: null });
  } catch (e) {
    console.error('[ordenes-pago enviarCorreoOrden]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ════════════════ PAGO (egreso desde caja) ════════════════ */

// Caja activa del usuario (asignación vigente a una caja abierta), o null.
async function cajaActiva(idUsuario) {
  try {
    const [[c]] = await pool.query(
      `SELECT cu.id_caja, cj.nombre FROM caja_usuarios cu JOIN cajas cj ON cu.id_caja = cj.id_caja
        WHERE cu.id_usuario = ? AND cu.activo = 1 AND cj.activo = 1 LIMIT 1`, [idUsuario]);
    return c || null;
  } catch (e) { return null; }
}

// Horario de pagos paramétrico (mantenedor Cajas → caja_horario_pago). Hora de Chile (tz del pool).
// Fail-open: si no hay config aún, no bloquea. DAYOFWEEK(): 1=domingo … 7=sábado.
async function horarioPagoPermitido() {
  try {
    const [[h]] = await pool.query(`
      SELECT h.activo, h.hora_inicio, h.hora_fin, h.dia_lun,h.dia_mar,h.dia_mie,h.dia_jue,h.dia_vie,h.dia_sab,h.dia_dom,
             (CURTIME() >= h.hora_inicio AND CURTIME() < h.hora_fin) AS hora_ok, DAYOFWEEK(NOW()) AS dow
      FROM caja_horario_pago h WHERE h.id = 1`);
    if (!h || !h.activo) return { permitido: true };
    const col = { 1: 'dia_dom', 2: 'dia_lun', 3: 'dia_mar', 4: 'dia_mie', 5: 'dia_jue', 6: 'dia_vie', 7: 'dia_sab' }[h.dow];
    if (h.hora_ok && h[col]) return { permitido: true };
    const map = [['dia_lun', 'Lun'], ['dia_mar', 'Mar'], ['dia_mie', 'Mié'], ['dia_jue', 'Jue'], ['dia_vie', 'Vie'], ['dia_sab', 'Sáb'], ['dia_dom', 'Dom']];
    const dias = map.filter(([k]) => h[k]).map(([, n]) => n);
    const diasTxt = dias.length === 7 ? 'todos los días' : (dias.join(', ') || 'ningún día');
    const ini = String(h.hora_inicio).slice(0, 5), fin = String(h.hora_fin).slice(0, 5);
    return { permitido: false, motivo: `Fuera del horario de pagos: se permiten ${diasTxt} de ${ini} a ${fin} hrs.` };
  } catch (e) { return { permitido: true }; }
}

// Estado del horario para la UI: abierta/cerrada + segundos al próximo cambio (cierre o apertura).
// Todo en hora de Chile (tz del pool). DAYOFWEEK(): 1=domingo … 7=sábado.
async function estadoHorarioPago() {
  try {
    const [[h]] = await pool.query(`
      SELECT h.activo, h.hora_inicio, h.hora_fin,
             h.dia_lun,h.dia_mar,h.dia_mie,h.dia_jue,h.dia_vie,h.dia_sab,h.dia_dom,
             DAYOFWEEK(NOW()) AS dow, TIME_TO_SEC(CURTIME()) AS cs,
             TIME_TO_SEC(h.hora_inicio) AS ini_s, TIME_TO_SEC(h.hora_fin) AS fin_s
      FROM caja_horario_pago h WHERE h.id = 1`);
    if (!h) return { restringido: false, abierta: true };
    const hi = String(h.hora_inicio).slice(0, 5), hf = String(h.hora_fin).slice(0, 5);
    if (!h.activo) return { restringido: false, abierta: true, hora_inicio: hi, hora_fin: hf };
    const dias = [h.dia_lun, h.dia_mar, h.dia_mie, h.dia_jue, h.dia_vie, h.dia_sab, h.dia_dom].map(Number); // 0=Lun … 6=Dom
    const today = (Number(h.dow) + 5) % 7;   // DAYOFWEEK→ índice Lun0
    const cs = Number(h.cs), iniS = Number(h.ini_s), finS = Number(h.fin_s);
    if (dias[today] === 1 && cs >= iniS && cs < finS)
      return { restringido: true, abierta: true, hora_inicio: hi, hora_fin: hf, proximo: 'CIERRE', segundos: finS - cs };
    for (let d = 0; d <= 7; d++) {
      const idx = (today + d) % 7;
      if (dias[idx] !== 1) continue;
      if (d === 0) { if (cs < iniS) return { restringido: true, abierta: false, hora_inicio: hi, hora_fin: hf, proximo: 'APERTURA', segundos: iniS - cs }; continue; }
      return { restringido: true, abierta: false, hora_inicio: hi, hora_fin: hf, proximo: 'APERTURA', segundos: d * 86400 - cs + iniS };
    }
    return { restringido: true, abierta: false, hora_inicio: hi, hora_fin: hf };  // ningún día habilitado
  } catch (e) { return { restringido: false, abierta: true }; }
}

// POST /api/ordenes-pago/ordenes/:id/pagar  (:id = op_correlativos.id) — registra el pago/egreso.
// Solo usuarios con Caja Activa. Marca el pago en el libro central y cierra la etapa en su módulo.
const pagarOrden = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const idU = (req.usuario || {}).id_usuario || null;
    const caja = await cajaActiva(idU);
    if (!caja) return res.status(403).json({ success: false, data: null, error: 'Necesitas una Caja Activa para registrar pagos' });
    // Horario de pagos (mantenedor Cajas): fuera de la ventana habilitada no se permite pagar.
    const hp = await horarioPagoPermitido();
    if (!hp.permitido) return res.status(403).json({ success: false, data: null, error: hp.motivo });

    const [[oc]] = await pool.query('SELECT * FROM op_correlativos WHERE id=?', [id]);
    if (!oc) return res.status(404).json({ success: false, data: null, error: 'Orden no encontrada' });
    if (oc.anulada) return res.status(409).json({ success: false, data: null, error: 'La orden está anulada' });
    if (oc.pagada)  return res.status(409).json({ success: false, data: null, error: 'La orden ya está pagada' });

    const quien = nombreUsuario(req);
    // Segregación de funciones: quien emitió la orden no puede registrar su pago.
    const seg = await segregacion.validarPagador({
      idEmisor: oc.id_usuario, nombreEmisor: oc.usuario_nombre, idPagador: idU, nombrePagador: quien });
    if (!seg.ok) return res.status(403).json({ success: false, data: null, error: seg.motivo });

    const metodo = norm((req.body || {}).metodo_pago) || null;
    const fechaPago = fdate((req.body || {}).fecha_pago) || require('../../../../shared/fecha-chile').hoyISO(); // día de Chile, no UTC

    // 1) Registro central (egreso de caja).
    await pool.query(
      `UPDATE op_correlativos SET pagada=1, fecha_pagada=NOW(), pagada_por=?, pagada_nombre=?, id_caja=?, metodo_pago=? WHERE id=?`,
      [idU, quien, caja.id_caja, metodo, id]);

    // 2) Cierre en el módulo de origen.
    if (oc.origen === 'GENERAL') {
      await pool.query(`UPDATE ordenes_pago SET estado='PAGADA', fecha_pago=?, metodo_pago=COALESCE(?, metodo_pago) WHERE id=?`,
        [fechaPago, metodo, oc.origen_id]);
      // Hook Plan Liquidez: si la ODP corresponde a una liquidación, postea el abono y baja/sube la deuda.
      // Aislado en try/catch: nunca debe romper el pago.
      try {
        const liq = require('../../../dealers-liquidez/src/controllers/hojas.controller');
        if (liq.onOdpPagada) await liq.onOdpPagada(oc.origen_id);
      } catch (e) { console.error('[ordenes-pago hook liquidez]', e.message); }
    } else if (oc.origen === 'SALDO') {
      const [[s]] = await pool.query('SELECT id_seguimiento FROM postventa_ordenes WHERE id=?', [oc.origen_id]);
      if (s) {
        await pool.query(`INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES (?, 'SALDO', 'SALDO PRECIO PAGADO', ?)`, [s.id_seguimiento, quien]);
        // Contrapartida contable del egreso (Máxima 4): sin esto la cuenta de
        // paso 2102045 solo crecía. Idempotente por ref; aislado, nunca rompe el pago.
        try {
          const pv = require('../../../postventa/src/controllers/postventa.controller');
          if (pv.contabilizarSaldoPrecio) await pv.contabilizarSaldoPrecio(s.id_seguimiento, 'SALDO PRECIO PAGADO');
        } catch (e) { console.error('[ordenes-pago contab saldo]', e.message); }
        // Aviso al dealer (plantilla correo_pago_saldo del mantenedor Post Venta;
        // nace inactiva). Aislado: un correo caído jamás debe romper el pago.
        try {
          const pv = require('../../../postventa/src/controllers/postventa.controller');
          if (pv.notificarPagoSaldoDealer) pv.notificarPagoSaldoDealer(s.id_seguimiento).catch(e => console.error('[ordenes-pago aviso saldo]', e.message));
        } catch (e) { console.error('[ordenes-pago hook saldo]', e.message); }
      }
    } else if (oc.origen === 'COMISION') {
      const [[s]] = await pool.query('SELECT id_seguimiento FROM postventa_ordenes_comision WHERE id=?', [oc.origen_id]);
      if (s) {
        // La ODP de la titular cubre toda la cartola: COMISION PAGADA en el grupo
        // de la factura, y aviso automático al dealer desde comisiones@.
        try {
          const pv = require('../../../postventa/src/controllers/postventa.controller');
          const grupo = await pv.idsGrupoFactura(s.id_seguimiento);
          const vals = grupo.map(g => [g, 'COMISION', 'COMISION PAGADA', quien]);
          await pool.query(`INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES ?`, [vals]);
          // Mismo hueco que en saldo precio: pagar desde acá no rebajaba el pasivo de la comisión.
          if (pv.contabilizarComision) await pv.contabilizarComision(s.id_seguimiento, 'PAGO');
          await pv.notificarPagoComisionDealer(s.id_seguimiento);
        } catch (ePV) {
          console.error('[ordenes-pago hook comision]', ePV.message);
          await pool.query(`INSERT IGNORE INTO postventa_etapas (id_seguimiento, track, etapa, usuario) VALUES (?, 'COMISION', 'COMISION PAGADA', ?)`, [s.id_seguimiento, quien]);
        }
      }
    }

    // 3) Congelar el documento "en duro": snapshot inmutable. La orden pagada ya no se recalcula.
    await congelarDocumento(id);

    auditar({ req, accion: 'PAGAR', modulo: 'ordenes-pago', entidad: 'orden_pago', entidad_id: id,
      detalle: `Pagó ${oc.numero || id} ($${Number(oc.monto || 0).toLocaleString('es-CL')}) desde caja ${caja.nombre}${metodo ? ' · ' + metodo : ''}` });
    res.json({ success: true, data: { id, caja: caja.nombre }, error: null });
  } catch (e) {
    console.error('[ordenes-pago pagarOrden]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* ── PUT /api/ordenes-pago/ordenes/:id/anular-postventa ───────────────────────
   Anula una Orden de Pago de POST VENTA (Saldo Precio o Comisión). `:id` es el
   id del correlativo (op_correlativos).

   POR QUÉ EXISTE
   Hasta hoy no había forma de anular una de estas órdenes en ninguna parte:
   "Emisión Orden de Pago" solo lista las PENDIENTES de emitir, el botón Anular
   del Historial aplicaba solo a las de proveedores, y el casillero de la etapa
   lo rechaza el servidor. Una orden emitida por error quedaba viva para siempre
   y bloqueaba la reemisión.

   POR QUÉ NO SE FUSIONA CON cambiarEstadoOrden
   Esa anula órdenes de PROVEEDORES: cambia el estado en `ordenes_pago` y no
   tiene etapas que deshacer. Esta tiene que devolver la operación a su etapa
   anterior para que pueda volver a emitirse. Son dos cosas que se parecen pero
   no son la misma (Máxima 1). Lo que SÍ comparten —anular el correlativo— es el
   mismo motor: `anularCorrelativo()`.

   QUÉ HACE, EN ORDEN
     1. El número NO se libera: queda reservado y marcado como anulado, con
        quién y cuándo. Un correlativo que se reutiliza es un número de orden
        que aparece dos veces en la contabilidad.
     2. Suelta `num_orden` de la orden de Post Venta, para que la próxima
        emisión saque un número NUEVO en vez de devolver el anulado.
     3. Borra las etapas que la orden había marcado, así la operación vuelve a
        aparecer en "Emisión Orden de Pago".

   NO reversa contabilidad porque emitir no genera asiento: el saldo precio se
   contabiliza en FONDOS RECIBIDOS y en SALDO PRECIO PAGADO, no al emitir.
   Por eso mismo una orden YA PAGADA no se puede anular — ahí sí hay plata que
   salió y un asiento que existe. */
const anularOrdenPostventa = async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const motivo = norm((req.body || {}).motivo);
    if ((req.usuario || {}).perfil_nombre !== 'Administrador')
      return res.status(403).json({ success: false, data: null, error: 'Solo el Administrador puede anular órdenes de pago' });
    if (motivo.length < 10)
      return res.status(400).json({ success: false, data: null, error: 'El motivo es obligatorio y debe explicar por qué se anula (mínimo 10 caracteres)' });

    const [[oc]] = await pool.query('SELECT id, numero, origen, origen_id, monto, anulada, pagada FROM op_correlativos WHERE id=?', [id]);
    if (!oc) return res.status(404).json({ success: false, data: null, error: 'Orden no encontrada' });
    if (oc.origen === 'GENERAL')
      return res.status(400).json({ success: false, data: null, error: 'Esta es una orden de proveedores: se anula con el botón Anular del Historial' });
    if (!['SALDO', 'COMISION'].includes(oc.origen))
      return res.status(400).json({ success: false, data: null, error: 'Origen de orden no reconocido' });
    if (oc.anulada) return res.status(409).json({ success: false, data: null, error: `La orden ${oc.numero} ya está anulada` });
    if (oc.pagada)  return res.status(409).json({ success: false, data: null, error: `La orden ${oc.numero} ya está pagada y queda en duro: no puede anularse` });

    const esSaldo = oc.origen === 'SALDO';
    const tabla = esSaldo ? 'postventa_ordenes' : 'postventa_ordenes_comision';
    const track = esSaldo ? 'SALDO' : 'COMISION';
    const etapaPagada = esSaldo ? 'SALDO PRECIO PAGADO' : 'COMISION PAGADA';

    const [[po]] = await pool.query(`SELECT id, id_seguimiento, num_op FROM \`${tabla}\` WHERE id=?`, [oc.origen_id]);
    if (!po) return res.status(404).json({ success: false, data: null, error: 'No se encontró la orden de Post Venta asociada' });

    /* El correlativo puede estar sin pagar y la etapa marcada igual (el pago se
       registra por las dos vías). Se revisa la etapa además del correlativo. */
    const [[yaPagada]] = await pool.query(
      'SELECT 1 x FROM postventa_etapas WHERE id_seguimiento=? AND track=? AND etapa=? LIMIT 1',
      [po.id_seguimiento, track, etapaPagada]);
    if (yaPagada) return res.status(409).json({ success: false, data: null, error: `La operación ya está marcada como "${etapaPagada}": la orden no puede anularse` });

    const quien = nombreUsuario(req), idU = (req.usuario || {}).id_usuario || null;

    // 1. El número queda reservado y marcado anulado — nunca se reutiliza.
    await anularCorrelativo({ numero: oc.numero, origen: oc.origen, origen_id: oc.origen_id, id_usuario: idU, usuario_nombre: quien });

    // 2. Sin num_orden, la próxima emisión saca un número nuevo en vez de devolver este.
    await pool.query(`UPDATE \`${tabla}\` SET num_orden=NULL WHERE id=?`, [po.id]);

    // 3. Deshacer las etapas que la orden había marcado, para que vuelva a
    //    aparecer en "Emisión Orden de Pago". Se informa CUÁLES se deshicieron:
    //    "ENVIADO A PAGO" significa que ya se había instruido el pago, y quien
    //    anula tiene que saber que eso también se está revirtiendo.
    const [etapasVivas] = await pool.query(
      `SELECT etapa FROM postventa_etapas WHERE id_seguimiento=? AND track=? AND etapa IN ('ORDEN DE PAGO EMITIDA','ENVIADO A PAGO')`,
      [po.id_seguimiento, track]);
    const deshechas = etapasVivas.map(e => e.etapa);
    if (deshechas.length) {
      await pool.query(
        `DELETE FROM postventa_etapas WHERE id_seguimiento=? AND track=? AND etapa IN ('ORDEN DE PAGO EMITIDA','ENVIADO A PAGO')`,
        [po.id_seguimiento, track]);
    }

    auditar({ req, accion: 'ANULAR', modulo: 'ordenes-pago', entidad: 'orden_pago_postventa', entidad_id: id,
      detalle: `Anuló ${oc.numero} (OP ${po.num_op}, $${Number(oc.monto || 0).toLocaleString('es-CL')})`
             + `${deshechas.length ? ' — se deshicieron las etapas: ' + deshechas.join(', ') : ''}. Motivo: ${motivo}` });

    res.json({ success: true, data: { id, numero: oc.numero, num_op: po.num_op, etapas_deshechas: deshechas }, error: null });
  } catch (e) {
    console.error('[ordenes-pago anularOrdenPostventa]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

// GET /api/ordenes-pago/mi-caja — caja activa del usuario + estado del horario (abierta/cerrada + countdown).
const miCajaOP = async (req, res) => {
  const caja = await cajaActiva((req.usuario || {}).id_usuario);
  const horario = await estadoHorarioPago();
  res.json({ success: true, data: { caja, horario }, error: null });
};

module.exports = {
  listarProveedores, crearProveedor, actualizarProveedor, eliminarProveedor,
  listarOrdenes, getOrden, getDocumento, crearOrden, cambiarEstadoOrden, estadisticas, enviarCorreoOrden,
  pagarOrden, miCajaOP, anularOrdenPostventa,
};
