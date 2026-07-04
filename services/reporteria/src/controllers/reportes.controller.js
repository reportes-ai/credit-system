'use strict';
/* Reportes agregados de Reportería: Cartera de Créditos y Cobranza y Mora.
   Solo lecturas agregadas (SUM/COUNT server-side) — el frontend pinta gráficos. */
const pool = require('../../../../shared/config/database');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

/* ── Cartera de Créditos ─────────────────────────────────────────────
   ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD acota los agregados de OTORGADOS
   por fecha_otorgado (los totales por etapa son de toda la base). */
exports.cartera = async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const fw = [];
    const fp = [];
    if (desde) { fw.push('fecha_otorgado >= ?'); fp.push(desde); }
    if (hasta) { fw.push('fecha_otorgado <= ?'); fp.push(hasta); }
    const fOtor = "estado_credito = 'OTORGADO'" + (fw.length ? ' AND ' + fw.join(' AND ') : '');

    const [porEstado] = await pool.query(`
      SELECT COALESCE(estado_credito,'SIN ESTADO') AS estado, COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto
      FROM creditos GROUP BY estado_credito ORDER BY n DESC`);

    const [porFinanciera] = await pool.query(`
      SELECT COALESCE(financiera,'—') AS financiera, COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto
      FROM creditos WHERE ${fOtor} GROUP BY financiera ORDER BY monto DESC`, fp);

    const [porEjecutivo] = await pool.query(`
      SELECT COALESCE(NULLIF(TRIM(ejecutivo),''),'Sin ejecutivo') AS ejecutivo,
             COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto
      FROM creditos WHERE ${fOtor}
      GROUP BY 1 ORDER BY monto DESC LIMIT 12`, fp);

    const [porMes] = await pool.query(`
      SELECT DATE_FORMAT(fecha_otorgado,'%Y-%m') AS mes, COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto
      FROM creditos
      WHERE estado_credito = 'OTORGADO' AND fecha_otorgado IS NOT NULL
        AND fecha_otorgado >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
      GROUP BY 1 ORDER BY 1`);

    const [carteraPropia] = await pool.query(`
      SELECT COALESCE(estado_cartera,'') AS estado_cartera, COUNT(*) n
      FROM creditos WHERE estado_cartera IS NOT NULL GROUP BY estado_cartera`);

    const [[kpi]] = await pool.query(`
      SELECT COUNT(*) total,
             SUM(estado_credito='OTORGADO') otorgados,
             COALESCE(SUM(CASE WHEN estado_credito='OTORGADO' THEN monto_financiado END),0) monto_otorgado
      FROM creditos`);

    ok(res, { kpi, porEstado, porFinanciera, porEjecutivo, porMes, carteraPropia });
  } catch (e) { fail(res, e.message); }
};

/* ── Cobranza y Mora ─────────────────────────────────────────────────
   Universo: cuotas_credito (calendario real). Vencida impaga =
   fecha_vencimiento < hoy, sin fecha_pago y estado no PAGADA/ANULADA. */
exports.cobranzaMora = async (req, res) => {
  try {
    const IMPAGA = "c.fecha_pago IS NULL AND COALESCE(c.estado_cuota,'') NOT IN ('PAGADA','ANULADA')";

    const [tramos] = await pool.query(`
      SELECT CASE
               WHEN DATEDIFF(CURDATE(), c.fecha_vencimiento) BETWEEN 1 AND 15 THEN '1-15'
               WHEN DATEDIFF(CURDATE(), c.fecha_vencimiento) BETWEEN 16 AND 30 THEN '16-30'
               WHEN DATEDIFF(CURDATE(), c.fecha_vencimiento) BETWEEN 31 AND 60 THEN '31-60'
               WHEN DATEDIFF(CURDATE(), c.fecha_vencimiento) BETWEEN 61 AND 90 THEN '61-90'
               ELSE '91+' END AS tramo,
             COUNT(*) n_cuotas, COUNT(DISTINCT c.id_credito) n_creditos,
             COALESCE(SUM(c.valor_cuota),0) monto
      FROM cuotas_credito c
      WHERE c.fecha_vencimiento < CURDATE() AND ${IMPAGA}
      GROUP BY 1
      ORDER BY FIELD(tramo,'1-15','16-30','31-60','61-90','91+')`);

    const [[kpi]] = await pool.query(`
      SELECT COALESCE(SUM(CASE WHEN c.fecha_vencimiento < CURDATE() THEN c.valor_cuota END),0) monto_vencido,
             COUNT(DISTINCT CASE WHEN c.fecha_vencimiento < CURDATE() THEN c.id_credito END) creditos_mora,
             SUM(c.fecha_vencimiento < CURDATE()) cuotas_vencidas,
             COALESCE(SUM(c.valor_cuota),0) saldo_impago_total
      FROM cuotas_credito c
      WHERE ${IMPAGA}`);

    // Recuperación: cuotas pagadas DESPUÉS de su vencimiento, por mes de pago (últimos 6 meses)
    const [recuperacion] = await pool.query(`
      SELECT DATE_FORMAT(c.fecha_pago,'%Y-%m') AS mes, COUNT(*) n, COALESCE(SUM(c.valor_cuota),0) monto
      FROM cuotas_credito c
      WHERE c.fecha_pago IS NOT NULL AND c.fecha_pago > c.fecha_vencimiento
        AND c.fecha_pago >= DATE_SUB(CURDATE(), INTERVAL 6 MONTH)
      GROUP BY 1 ORDER BY 1`);

    const [[rec30]] = await pool.query(`
      SELECT COUNT(*) n, COALESCE(SUM(c.valor_cuota),0) monto
      FROM cuotas_credito c
      WHERE c.fecha_pago IS NOT NULL AND c.fecha_pago > c.fecha_vencimiento
        AND c.fecha_pago >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)`);

    const [deudores] = await pool.query(`
      SELECT c.id_credito, cr.num_op, cr.numero_credito,
             COALESCE(cl.nombre_completo, CONCAT_WS(' ', cl.nombres, cl.apellido_paterno), '—') AS cliente,
             COUNT(*) cuotas_vencidas,
             COALESCE(SUM(c.valor_cuota),0) monto_vencido,
             MAX(DATEDIFF(CURDATE(), c.fecha_vencimiento)) dias_mora
      FROM cuotas_credito c
      JOIN creditos cr ON cr.id = c.id_credito
      LEFT JOIN clientes cl ON cl.id_cliente = cr.id_cliente
      WHERE c.fecha_vencimiento < CURDATE() AND ${IMPAGA}
      GROUP BY c.id_credito, cr.num_op, cr.numero_credito, cliente
      ORDER BY monto_vencido DESC
      LIMIT 15`);

    ok(res, { kpi: { ...kpi, rec30_n: rec30.n, rec30_monto: rec30.monto }, tramos, recuperacion, deudores });
  } catch (e) { fail(res, e.message); }
};
