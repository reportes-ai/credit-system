'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   DASHBOARD DE TESORERÍA (/tesoreria/dashboard/) — v216.3
   La mesa del tesorero en una pantalla: qué hay que PAGAR (cola por origen y
   lo ya instruido esperando transferencia), qué se PAGÓ (curva diaria), qué
   ENTRÓ por caja, y los saldos que piden aseo (transitorias, brokerage,
   banco sin conciliar). Todo desde tablas existentes — cero digitación nueva.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

const ok = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

/* Funcionalidad + card (la landing de Tesorería arma sus cards desde BD) */
require('../../../../shared/migrate').enFila('tes-dashboard', async () => {
  try {
    // El módulo se toma de una funcionalidad HERMANA ya existente (las cards de
    // la landing salen de ahí): más robusto que adivinar la ruta en `modulos`.
    let idMod = null;
    const [[hermana]] = await pool.query(
      "SELECT id_modulo FROM funcionalidades WHERE href LIKE '/tesoreria/%' AND id_modulo IS NOT NULL LIMIT 1");
    if (hermana) idMod = hermana.id_modulo;
    if (!idMod) {
      const [[mod]] = await pool.query(
        "SELECT id_modulo FROM modulos WHERE ruta LIKE '/tesoreria%' OR nombre LIKE '%Tesorer%' LIMIT 1");
      idMod = mod && mod.id_modulo;
    }
    if (!idMod) { console.error('[tes-dashboard seed] no encontré el módulo Tesorería'); return; }
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='tes_dashboard'");
    if (!ex) {
      const [ins] = await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,'Dashboard Tesorería','tes_dashboard','/tesoreria/dashboard/','bi-speedometer2')",
        [idMod]);
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
        SELECT id_perfil, ?, 1 FROM perfiles WHERE nombre='Administrador'`, [ins.insertId]);
      console.log('[tes-dashboard] funcionalidad tes_dashboard sembrada en módulo', idMod);
    }
  } catch (e) { console.error('[tes-dashboard seed]', e.message); }
});

exports.dashboardTes = async (req, res) => {
  try {
    /* 1 — Cola de pago: ODP vivas por origen (correlativo único, ni pagadas ni anuladas) */
    const [porPagar] = await pool.query(`
      SELECT origen, COUNT(*) n, COALESCE(SUM(monto),0) monto,
             DATEDIFF(NOW(), MIN(created_at)) dias_mas_antigua
        FROM op_correlativos WHERE anulada=0 AND COALESCE(pagada,0)=0 GROUP BY origen`);

    /* Instruidas: la operación ya tiene "ENVIADO A PAGO" y aún no está pagada —
       es lo que espera SOLO la transferencia del tesorero. */
    const instruidas = {};
    for (const [track, etapaPago] of [['SALDO', 'SALDO PRECIO PAGADO'], ['COMISION', 'COMISION PAGADA']]) {
      const [[r]] = await pool.query(`
        SELECT COUNT(*) n FROM postventa_etapas e
        WHERE e.track=? AND e.etapa='ENVIADO A PAGO'
          AND NOT EXISTS (SELECT 1 FROM postventa_etapas p
            WHERE p.id_seguimiento=e.id_seguimiento AND p.track=e.track AND p.etapa=?)`,
        [track, etapaPago]);
      instruidas[track] = Number(r.n);
    }

    /* 2 — Pagos realizados: por día (14 días) y total del mes */
    const [pagosDia] = await pool.query(`
      SELECT DATE(fecha_pagada) dia, COUNT(*) n, COALESCE(SUM(monto),0) monto
        FROM op_correlativos WHERE pagada=1 AND fecha_pagada >= NOW() - INTERVAL 14 DAY
       GROUP BY DATE(fecha_pagada) ORDER BY dia`);
    const [[pagMes]] = await pool.query(`
      SELECT COUNT(*) n, COALESCE(SUM(monto),0) monto FROM op_correlativos
       WHERE pagada=1 AND DATE_FORMAT(fecha_pagada,'%Y-%m') = DATE_FORMAT(NOW(),'%Y-%m')`);

    /* 3 — Caja: recaudación por día (14 días), hoy y el mes; reversas del día */
    const [cajaDia] = await pool.query(`
      SELECT DATE(created_at) dia, COUNT(*) n, COALESCE(SUM(total_pagado),0) monto
        FROM pagos_credito WHERE estado_pago='PAGADO' AND created_at >= NOW() - INTERVAL 14 DAY
       GROUP BY DATE(created_at) ORDER BY dia`);
    const [[cajaHoy]] = await pool.query(`
      SELECT COUNT(*) n, COALESCE(SUM(total_pagado),0) monto FROM pagos_credito
       WHERE estado_pago='PAGADO' AND DATE(created_at)=CURDATE()`);
    const [[cajaMes]] = await pool.query(`
      SELECT COUNT(*) n, COALESCE(SUM(total_pagado),0) monto FROM pagos_credito
       WHERE estado_pago='PAGADO' AND DATE_FORMAT(created_at,'%Y-%m')=DATE_FORMAT(NOW(),'%Y-%m')`);
    const [[revHoy]] = await pool.query(`
      SELECT COUNT(*) n FROM pagos_credito WHERE estado_pago='REVERSADO' AND DATE(fecha_reverso)=CURDATE()`);

    /* 4 — Cuentas transitorias: saldo disponible (original − utilizado) por crédito */
    const [[trans]] = await pool.query(`
      SELECT COUNT(*) n, COALESCE(SUM(monto_original - monto_utilizado),0) saldo
        FROM cuentas_transitorias WHERE estado='ACTIVO' AND (monto_original - monto_utilizado) > 0`);
    const [transTop] = await pool.query(`
      SELECT t.id_credito, t.nombre_cliente, COALESCE(CAST(c.num_op AS CHAR),'') num_op,
             SUM(t.monto_original - t.monto_utilizado) saldo
        FROM cuentas_transitorias t LEFT JOIN creditos c ON c.id = t.id_credito
       WHERE t.estado='ACTIVO' GROUP BY t.id_credito, t.nombre_cliente, c.num_op
      HAVING saldo > 0 ORDER BY saldo DESC LIMIT 8`);

    /* 5 — Brokerage: facturas por estado + pagos programados sin ejecutar */
    const [brkFact] = await pool.query(`
      SELECT estado, COUNT(*) n, COALESCE(SUM(monto),0) monto FROM facturas_brokerage GROUP BY estado`);
    const [[brkProg]] = await pool.query(`
      SELECT COUNT(*) n, COALESCE(SUM(monto),0) monto FROM pagos_brokerage WHERE estado='PROGRAMADO'`);

    /* 6 — Conciliación por conexión bancaria */
    let bancos = [];
    try {
      const [b] = await pool.query(`
        SELECT k.banco, COALESCE(k.alias,'') alias,
               COALESCE(SUM(COALESCE(m.conciliado,0)=0),0) pendientes,
               COALESCE(SUM(COALESCE(m.conciliado,0)=1),0) conciliados,
               MAX(m.fecha) ultimo_mov
          FROM banco_conexiones k LEFT JOIN banco_movimientos m ON m.id_conexion=k.id
         GROUP BY k.id, k.banco, k.alias`);
      bancos = b;
    } catch (_) {}

    ok(res, {
      generado: new Date().toISOString(),
      por_pagar: porPagar.map(o => ({ origen: o.origen, n: Number(o.n), monto: Number(o.monto), dias_mas_antigua: Number(o.dias_mas_antigua || 0) })),
      instruidas,
      pagos: { por_dia: pagosDia, mes: { n: Number(pagMes.n), monto: Number(pagMes.monto) } },
      caja: { por_dia: cajaDia, hoy: { n: Number(cajaHoy.n), monto: Number(cajaHoy.monto) },
              mes: { n: Number(cajaMes.n), monto: Number(cajaMes.monto) }, reversas_hoy: Number(revHoy.n) },
      transitorias: { n: Number(trans.n), saldo: Number(trans.saldo), top: transTop },
      brokerage: { facturas: brkFact, programados: { n: Number(brkProg.n), monto: Number(brkProg.monto) } },
      bancos,
    });
  } catch (e) { console.error('[tes dashboard]', e.message); fail(res, e.message); }
};
