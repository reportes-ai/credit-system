'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   BITÁCORA DE TRANSACCIONES (TRX-XXXXXX)
   Vista unificada de todo movimiento con número de transacción del correlativo
   único global (correlativo_transacciones): pagos de cuota y reversas de caja,
   abonos a cuentas transitorias, castigos de saldo y cierres de provisiones.
   Búsqueda por N° transacción, rango de fechas, N° de operación y RUT cliente.
   Solo lectura — cada fuente sigue viviendo en su propia tabla (una sola fuente).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

/* ── Migración: funcionalidad en el menú de Tesorería ───────────────────────── */
require('../../../../shared/migrate').enFila('trx-bitacora', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Tesorería' OR ruta LIKE '/tesoreria%' LIMIT 1");
    if (!mod) return;
    let [[f]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='trx_bitacora' LIMIT 1");
    if (!f) {
      const [r] = await pool.query(
        `INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono)
         VALUES (?, 'Bitácora de Transacciones', 'trx_bitacora', '/tesoreria/bitacora', 'bi-journal-text')`,
        [mod.id_modulo]);
      f = { id_funcionalidad: r.insertId };
    }
    const [perfiles] = await pool.query(
      "SELECT id_perfil FROM perfiles WHERE nombre IN ('Administrador','Gerente General','Gerente de Finanzas','Gerente de Operaciones y Crédito','Tesorero','Auditor')");
    for (const p of perfiles) {
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (?,?,1)', [p.id_perfil, f.id_funcionalidad]);
    }
  } catch (e) { console.error('[trx-bitacora migration]', e.message); }
});

/* ── Helpers ────────────────────────────────────────────────────────────────── */
// Acepta 'TRX-000123', 'TR000123' o '123' → 123
function parseTrx(s) {
  const m = String(s || '').toUpperCase().replace(/[^0-9]/g, '');
  const n = parseInt(m, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
const normRut = s => String(s || '').replace(/\./g, '').trim().toUpperCase();

/* GET /api/trx-bitacora?trx=&desde=&hasta=&num_op=&rut= */
const buscar = async (req, res) => {
  try {
    const trx    = parseTrx(req.query.trx);
    const desde  = /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '') ? req.query.desde : null;
    const hasta  = /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '') ? req.query.hasta : null;
    const numOp  = (req.query.num_op || '').trim() || null;
    const rut    = normRut(req.query.rut) || null;
    if (req.query.trx && !trx) return fail(res, 'N° de transacción inválido', 400);

    // Filtros comunes por fuente: [campoFecha, campoOp, campoRut]
    const cond = (fFecha, fOp, fRut) => {
      const c = []; const p = [];
      if (trx   != null) { c.push('numero_transaccion = ?'); p.push(trx); }
      if (desde)         { c.push(`DATE(${fFecha}) >= ?`);   p.push(desde); }
      if (hasta)         { c.push(`DATE(${fFecha}) <= ?`);   p.push(hasta); }
      if (numOp && fOp)  { c.push(`${fOp} = ?`);             p.push(numOp); }
      if (rut && fRut)   { c.push(`REPLACE(UPPER(${fRut}),'.','') = ?`); p.push(rut); }
      return { where: c.length ? c.join(' AND ') : '1=1', params: p };
    };

    const consultas = [];

    /* 1. PAGOS de cuota (agrupados por transacción) + REVERSAS */
    {
      const f = cond('pc.created_at', 'c.num_op', 'cl.rut');
      consultas.push(pool.query(
        `SELECT pc.numero_transaccion,
                IF(pc.estado_pago='REVERSADO','REVERSA','PAGO CUOTA') AS tipo,
                MIN(IF(pc.estado_pago='REVERSADO', pc.fecha_reverso, pc.created_at)) AS fecha,
                c.num_op, COALESCE(cl.rut,'') AS rut, COALESCE(cl.nombre_completo,'') AS cliente,
                SUM(pc.total_pagado) AS monto,
                CONCAT(COUNT(*), ' cuota', IF(COUNT(*)>1,'s',''), ' (', GROUP_CONCAT(pc.numero_cuota ORDER BY pc.numero_cuota), ')',
                       IF(pc.estado_pago='REVERSADO', CONCAT(' · ', COALESCE(MAX(pc.comentario_reverso),'')), '')) AS detalle,
                COALESCE(MAX(IF(pc.estado_pago='REVERSADO', pc.reversado_por, pc.registrado_por)),'') AS usuario
           FROM pagos_credito pc
           LEFT JOIN creditos c  ON c.id = pc.id_credito
           LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
          WHERE pc.numero_transaccion IS NOT NULL AND pc.estado_pago IN ('PAGADO','REVERSADO') AND ${f.where.replace(/numero_transaccion/g, 'pc.numero_transaccion').replace(/DATE\(pc\.created_at\)/g, "DATE(IF(pc.estado_pago='REVERSADO', pc.fecha_reverso, pc.created_at))")}
          GROUP BY pc.numero_transaccion, pc.estado_pago, c.num_op, cl.rut, cl.nombre_completo
          LIMIT 300`, f.params).catch(() => [[]]));
    }

    /* 2. ABONOS a cuentas transitorias */
    {
      const f = cond('ct.created_at', 'c.num_op', 'ct.rut_cliente');
      consultas.push(pool.query(
        `SELECT ct.numero_transaccion, 'TRANSITORIA' AS tipo, ct.created_at AS fecha,
                c.num_op, COALESCE(ct.rut_cliente, cl.rut, '') AS rut,
                COALESCE(ct.nombre_cliente, cl.nombre_completo, '') AS cliente,
                ct.monto_original AS monto,
                CONCAT('Abono transitoria · ', COALESCE(ct.glosa,''), ' · estado ', ct.estado) AS detalle,
                '' AS usuario
           FROM cuentas_transitorias ct
           LEFT JOIN creditos c  ON c.id = ct.id_credito
           LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
          WHERE ct.numero_transaccion IS NOT NULL AND ${f.where.replace(/numero_transaccion/g, 'ct.numero_transaccion')}
          LIMIT 300`, f.params).catch(() => [[]]));
    }

    /* 3. CASTIGOS de saldo */
    {
      const f = cond('cc.solicitado_at', 'cc.num_op', 'cl.rut');
      consultas.push(pool.query(
        `SELECT cc.numero_transaccion, 'CASTIGO' AS tipo, cc.solicitado_at AS fecha,
                cc.num_op, COALESCE(cl.rut,'') AS rut, COALESCE(cl.nombre_completo, cl.nombre, '') AS cliente,
                cc.saldo_castigado AS monto,
                CONCAT('Castigo ', cc.motivo, ' · ', cc.estado, IF(cc.aplicado_at IS NOT NULL, CONCAT(' · baja ', DATE_FORMAT(cc.aplicado_at,'%d-%m-%Y')), '')) AS detalle,
                COALESCE(cc.solicitado_por_nombre,'') AS usuario
           FROM castigos_contables cc
           LEFT JOIN creditos cr ON cr.id = cc.id_credito
           LEFT JOIN clientes cl ON cl.id_cliente = cr.id_cliente
          WHERE cc.numero_transaccion IS NOT NULL AND ${f.where.replace(/numero_transaccion/g, 'cc.numero_transaccion')}
          LIMIT 300`, f.params).catch(() => [[]]));
    }

    /* 4. CIERRES de provisiones/castigos (sin op ni rut: solo si no se filtró por ellos) */
    if (!numOp && !rut) {
      const f = cond('sm.guardado_at', null, null);
      consultas.push(pool.query(
        `SELECT sm.numero_transaccion, 'CIERRE PROVISIONES' AS tipo, MAX(sm.guardado_at) AS fecha,
                NULL AS num_op, '' AS rut, '' AS cliente,
                MAX(CASE WHEN sm.cuenta='PROVISIONES' THEN sm.saldo END) AS monto,
                CONCAT('Cierre contable ', sm.mes, ' · Provisiones $', ROUND(COALESCE(MAX(CASE WHEN sm.cuenta='PROVISIONES' THEN sm.saldo END),0)),
                       ' · Castigos $', ROUND(COALESCE(MAX(CASE WHEN sm.cuenta='CASTIGOS' THEN sm.saldo END),0))) AS detalle,
                COALESCE(MAX(sm.guardado_por_nombre),'') AS usuario
           FROM contab_saldos_mensuales sm
          WHERE sm.numero_transaccion IS NOT NULL AND ${f.where.replace(/numero_transaccion/g, 'sm.numero_transaccion')}
          GROUP BY sm.numero_transaccion, sm.mes
          LIMIT 100`, f.params).catch(() => [[]]));
    }

    const resultados = await Promise.all(consultas);
    const filas = resultados.flatMap(([rows]) => rows || []);
    filas.sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));

    ok(res, { movimientos: filas.slice(0, 500), total: filas.length });
  } catch (e) { fail(res, e.message); }
};

module.exports = { buscar };
