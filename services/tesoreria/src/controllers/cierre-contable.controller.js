'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   CIERRE CONTABLE (Tesorería) — informe mensual que se envía a Contabilidad y
   de ahí a la casa matriz en Ecuador. Secciones (mismas piezas del zip mensual):
   1. NEGOCIACIONES  — venta de cartera (casi siempre 0; manual cuando ocurre)
   2. CARTERA VIGENTE — cartera propia AFA + AutoFácil vieja SIN lo pagado,
      valorizada desde el calendario real (cuotas_credito): capital pendiente,
      vencido / por vencer, interés pendiente, estatus al cierre y USD
   3. PRODUCCIÓN     — colocaciones del mes + comisiones concesionario y parque
   4. SALDOS PRECIOS — saldos precio aún no pagados al concesionario al cierre
      (marca manual por op: tabla cierre_saldos_pagados — la BD aún no registra
      el pago del saldo precio)
   5. RECOMPRA       — cartera vendida recomprada por mora (casi siempre 0)
   6. TABLA DE DESARROLLO — export del calendario de la cartera vigente
   Manual del mes (t/c, negociaciones, recompra, notas) en cierre_contable_meses.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });
const MES_RE = /^\d{4}-\d{2}$/;
const finDeMes = mes => {
  const [a, m] = mes.split('-').map(Number);
  return `${a}-${String(m).padStart(2, '0')}-${new Date(a, m, 0).getDate()}`;
};

/* ── Migración ──────────────────────────────────────────────────────────── */
require('../../../../shared/migrate').enFila('cierre-contable', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cierre_contable_meses (
        mes CHAR(7) PRIMARY KEY,                 -- '2026-06'
        tc_usd DECIMAL(10,4) NULL,               -- tipo de cambio del cierre
        negociaciones JSON NULL,                 -- [{fecha,institucion,ops,financiado,capital,spread,acreditado}]
        recompras JSON NULL,                     -- [{fecha,ops,saldo_recomprado,dev_spread,total}]
        notas VARCHAR(600) NULL,
        updated_by VARCHAR(150) NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cierre_saldos_pagados (
        num_op VARCHAR(20) PRIMARY KEY,          -- saldo precio YA pagado al dealer
        fecha_pago DATE NULL,
        marcado_por VARCHAR(150) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Tesorería' OR ruta LIKE '/tesoreria%' LIMIT 1");
    if (mod) {
      const f = { codigo: 'cierre_contable', nombre: 'Cierre Contable', href: '/tesoreria/cierre-contable', icono: 'bi-journal-check' };
      const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [f.codigo]);
      let idF = ex && ex.id_funcionalidad;
      if (!idF) {
        const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
          [mod.id_modulo, f.nombre, f.codigo, f.href, f.icono]);
        idF = r.insertId;
      }
      await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idF]);
    }
    console.log('[cierre-contable] módulo listo');
  } catch (e) { console.error('[cierre-contable migration]', e.message); }
});

/* ── Cartera vigente al cierre (AFA + AutoFácil vieja, sin lo pagado) ────── */
async function carteraVigente(cierre) {
  // Universo: cartera migrada propia (CARTERA_AFA + CARTERA_XLSX) con calendario
  // real. Pendiente = cuotas no pagadas O pagadas DESPUÉS del cierre (foto al día).
  const [rows] = await pool.query(`
    SELECT c.num_op, c.origen, c.cartera_original,
           COALESCE(cl.nombre_completo,'') nombre, COALESCE(cl.rut,'') rut,
           c.tascli_real tasa, c.plazo,
           SUM(CASE WHEN q.estado_cuota<>'PAGADA' OR q.fecha_pago > ? THEN q.amortizacion ELSE 0 END) AS capital,
           SUM(CASE WHEN (q.estado_cuota<>'PAGADA' OR q.fecha_pago > ?) AND q.fecha_vencimiento <= ? THEN q.amortizacion ELSE 0 END) AS capital_vencido,
           SUM(CASE WHEN q.estado_cuota<>'PAGADA' OR q.fecha_pago > ? THEN q.interes ELSE 0 END) AS interes_pend,
           MIN(CASE WHEN (q.estado_cuota<>'PAGADA' OR q.fecha_pago > ?) AND q.fecha_vencimiento <= ? THEN q.fecha_vencimiento ELSE NULL END) AS venc_antiguo
    FROM creditos c
    JOIN cuotas_credito q ON q.id_credito = c.id
    LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
    WHERE c.origen IN ('CARTERA_AFA','CARTERA_XLSX')
    GROUP BY c.num_op, c.origen, c.cartera_original, cl.nombre_completo, cl.rut, c.tascli_real, c.plazo
    HAVING capital > 0
    ORDER BY capital DESC`,
    [cierre, cierre, cierre, cierre, cierre, cierre]);
  const cierreMs = new Date(cierre + 'T00:00:00Z').getTime();
  const ops = rows.map(r => {
    const dias = r.venc_antiguo ? Math.max(0, Math.floor((cierreMs - new Date(r.venc_antiguo).getTime()) / 86400000)) : 0;
    return {
      num_op: r.num_op, rut: r.rut, nombre: r.nombre,
      cartera: r.cartera_original || 'AUTOFACIL',
      tasa: +r.tasa || null, plazo: r.plazo,
      capital: +r.capital, capital_vencido: +r.capital_vencido,
      capital_x_vencer: +r.capital - +r.capital_vencido,
      interes_pend: +r.interes_pend, dias_vencidos: dias,
      estatus: dias > 90 ? 'vencido' : 'vigente',
    };
  });
  const sum = k => ops.reduce((a, o) => a + o[k], 0);
  return {
    ops,
    totales: {
      n: ops.length,
      capital: sum('capital'), capital_vencido: sum('capital_vencido'),
      capital_x_vencer: sum('capital_x_vencer'), interes_pend: sum('interes_pend'),
      vencidos: ops.filter(o => o.estatus === 'vencido').length,
      vigentes: ops.filter(o => o.estatus === 'vigente').length,
    },
  };
}

/* ── Producción del mes ─────────────────────────────────────────────────── */
async function produccion(mes) {
  const [rows] = await pool.query(`
    SELECT c.num_op, c.automotora, c.rut_dealer, COALESCE(cl.nombre_completo,'') cliente,
           c.monto_financiado, c.comdea_real com_dealer_iva, c.com_parque, c.parque,
           DATE_FORMAT(c.fecha_otorgado,'%Y-%m-%d') fecha_otorgado
    FROM creditos c
    LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
    WHERE c.estado='OTORGADO' AND DATE_FORMAT(c.mes,'%Y-%m') = ? AND c.origen IS NULL
    ORDER BY c.num_op`, [mes]);
  const ops = rows.map(r => ({
    ...r,
    monto_financiado: +r.monto_financiado || 0,
    com_dealer_iva: +r.com_dealer_iva || 0,
    com_dealer_neta: Math.round((+r.com_dealer_iva || 0) / 1.19),
    com_parque: +r.com_parque || 0,
  }));
  const sum = k => ops.reduce((a, o) => a + o[k], 0);
  return {
    ops,
    totales: {
      n: ops.length, financiado: sum('monto_financiado'),
      com_dealer_iva: sum('com_dealer_iva'), com_dealer_neta: sum('com_dealer_neta'),
      com_parque: sum('com_parque'),
    },
  };
}

/* ── Saldos precio pendientes de pago al cierre ─────────────────────────── */
async function saldosPendientes(mes, cierre) {
  const [rows] = await pool.query(`
    SELECT c.num_op, DATE_FORMAT(c.mes,'%Y-%m') mes_op, c.automotora, c.rut_dealer,
           COALESCE(cl.nombre_completo,'') cliente, COALESCE(cl.rut,'') rut_cliente,
           c.saldo_precio, c.estado_fundantes
    FROM creditos c
    LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
    LEFT JOIN cierre_saldos_pagados p ON p.num_op = c.num_op
    WHERE c.estado='OTORGADO' AND c.origen IS NULL AND c.saldo_precio > 0
      AND c.mes <= ? AND p.num_op IS NULL
    ORDER BY c.mes, c.num_op`, [cierre]);
  const ops = rows.map(r => ({ ...r, saldo_precio: +r.saldo_precio || 0 }));
  return { ops, totales: { n: ops.length, saldo: ops.reduce((a, o) => a + o.saldo_precio, 0) } };
}

/* ── GET /api/cierre-contable?mes=YYYY-MM ───────────────────────────────── */
exports.informe = async (req, res) => {
  try {
    const mes = String(req.query.mes || '');
    if (!MES_RE.test(mes)) return fail(res, 'mes YYYY-MM requerido', 400);
    const cierre = finDeMes(mes);
    const [cartera, prod, saldos, [[manual]]] = await Promise.all([
      carteraVigente(cierre), produccion(mes), saldosPendientes(mes, cierre),
      pool.query('SELECT * FROM cierre_contable_meses WHERE mes=?', [mes]),
    ]);
    const j = v => (typeof v === 'string' ? JSON.parse(v || '[]') : (v || []));
    ok(res, {
      mes, cierre, cartera, produccion: prod, saldos,
      manual: manual ? { tc_usd: +manual.tc_usd || null, negociaciones: j(manual.negociaciones),
        recompras: j(manual.recompras), notas: manual.notas || '' } : { tc_usd: null, negociaciones: [], recompras: [], notas: '' },
    });
  } catch (e) { fail(res, e.message); }
};

/* ── PUT /api/cierre-contable/:mes — guarda manual (t/c, negociaciones…) ── */
exports.guardar = async (req, res) => {
  try {
    const mes = String(req.params.mes || '');
    if (!MES_RE.test(mes)) return fail(res, 'mes YYYY-MM requerido', 400);
    const b = req.body || {};
    await pool.query(`
      INSERT INTO cierre_contable_meses (mes, tc_usd, negociaciones, recompras, notas, updated_by)
      VALUES (?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE tc_usd=VALUES(tc_usd), negociaciones=VALUES(negociaciones),
        recompras=VALUES(recompras), notas=VALUES(notas), updated_by=VALUES(updated_by)`,
      [mes, Number(b.tc_usd) || null, JSON.stringify(b.negociaciones || []),
       JSON.stringify(b.recompras || []), String(b.notas || '').slice(0, 600), req.user?.nombre || null]);
    auditar({ req, accion: 'EDITAR', modulo: 'tesoreria', entidad: 'cierre_contable', entidad_id: mes,
      detalle: `Cierre contable ${mes}: datos manuales actualizados` });
    ok(res, { guardado: true });
  } catch (e) { fail(res, e.message); }
};

/* ── PUT /api/cierre-contable/saldo-pagado/:num_op — marca pagado/pendiente ─ */
exports.marcarSaldo = async (req, res) => {
  try {
    const num_op = String(req.params.num_op || '').trim();
    if (!num_op) return fail(res, 'num_op requerido', 400);
    const pagado = !!req.body?.pagado;
    if (pagado) {
      const fecha = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.fecha_pago || '')) ? req.body.fecha_pago : null;
      await pool.query(`INSERT INTO cierre_saldos_pagados (num_op, fecha_pago, marcado_por) VALUES (?,?,?)
        ON DUPLICATE KEY UPDATE fecha_pago=VALUES(fecha_pago), marcado_por=VALUES(marcado_por)`,
        [num_op, fecha, req.user?.nombre || null]);
    } else await pool.query('DELETE FROM cierre_saldos_pagados WHERE num_op=?', [num_op]);
    auditar({ req, accion: 'EDITAR', modulo: 'tesoreria', entidad: 'cierre_saldos_pagados', entidad_id: num_op,
      detalle: `Saldo precio OP ${num_op}: ${pagado ? 'PAGADO' : 'pendiente'}` });
    ok(res, { actualizado: true });
  } catch (e) { fail(res, e.message); }
};

/* ── GET /api/cierre-contable/tabla-desarrollo?mes= — calendario cartera ── */
exports.tablaDesarrollo = async (req, res) => {
  try {
    const mes = String(req.query.mes || '');
    if (!MES_RE.test(mes)) return fail(res, 'mes YYYY-MM requerido', 400);
    const [rows] = await pool.query(`
      SELECT q.num_op AS ID_Credito, COALESCE(cl.rut,'') Rut_Cliente,
             COALESCE(cl.nombre_completo,'') Nombre_Cliente,
             q.numero_cuota Numero_Cuota, DATE_FORMAT(q.fecha_vencimiento,'%Y-%m-%d') Fecha_Vencimiento,
             q.interes Interes_Cuota, q.amortizacion Amortizacion_Cuota, q.valor_cuota Valor_Cuota,
             q.saldo_insoluto Saldo_Insoluto, q.estado_cuota Estado_Cuota, q.tasa Tasa_Interes,
             DATE_FORMAT(q.fecha_pago,'%Y-%m-%d') Fecha_Pago
      FROM cuotas_credito q
      JOIN creditos c ON c.id = q.id_credito
      LEFT JOIN clientes cl ON cl.id_cliente = c.id_cliente
      WHERE c.origen IN ('CARTERA_AFA','CARTERA_XLSX')
      ORDER BY q.num_op, q.numero_cuota`);
    ok(res, { rows });
  } catch (e) { fail(res, e.message); }
};
