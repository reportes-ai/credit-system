'use strict';
/* Reportes agregados de Reportería: Cartera de Créditos y Cobranza y Mora.
   Solo lecturas agregadas (SUM/COUNT server-side) — el frontend pinta gráficos. */
const pool = require('../../../../shared/config/database');

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, msg, code = 500) => res.status(code).json({ success: false, data: null, error: msg });

/* ── BDD Cluster Comercial (informe para Casa Matriz Ecuador) ─────────
   Presupuesto semanal en tabla ppsto_cluster (editable en BD, no en código)
   + real de OTORGADOS agrupado por semana del mes (bloques fijos 1-7 /
   8-14 / 15-21 / 22-31, NO semanas ISO). */
require('../../../../shared/migrate').enFila('reportes-cluster', async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ppsto_cluster (
      anio     SMALLINT NOT NULL,
      mes      TINYINT  NOT NULL,
      semana   TINYINT  NOT NULL,
      unidades DECIMAL(8,2)  NOT NULL DEFAULT 0,
      monto    DECIMAL(15,0) NOT NULL DEFAULT 0,
      PRIMARY KEY (anio, mes, semana)
    ) COMMENT 'Presupuesto comercial semanal — BDD Cluster Comercial (Ecuador)'`);
  // Seed del presupuesto 2025-2026, montos EXACTOS del plan comercial
  // (INSERT IGNORE: si Finanzas lo edita en BD, no se pisa)
  const S = {
    2025: { 1:[[17.1,116280000],[22.5,153000000],[18.9,128520000],[31.5,214200000]],
            2:[[18.43,125324000],[24.25,164900000],[20.37,138516000],[33.95,230860000]],
            3:[[19.76,134368000],[26,176800000],[21.84,148512000],[36.4,247520000]],
            4:[[21.09,143412000],[27.75,188700000],[23.31,158508000],[38.85,264180000]],
            5:[[22.42,152456000],[29.5,200600000],[24.78,168504000],[41.3,280840000]],
            6:[[23.75,161500000],[31.25,212500000],[26.25,178500000],[43.75,297500000]],
            7:[[25.08,170544000],[33,224400000],[27.72,188496000],[46.2,314160000]],
            8:[[32.11,233738000],[42.25,307550000],[35.49,258342000],[59.15,430570000]],
            9:[[33.44,242782000],[44,319450000],[36.96,268338000],[61.6,447230000]],
            10:[[34.77,251826000],[45.75,331350000],[38.43,278334000],[64.05,463890000]],
            11:[[36.1,260870000],[47.5,343250000],[39.9,288330000],[66.5,480550000]],
            12:[[37.43,269914000],[49.25,355150000],[41.37,298326000],[68.95,497210000]] },
    2026: { 1:[[17.29,117572000],[22.75,154700000],[19.11,129948000],[31.85,216580000]],
            2:[[17.29,117572000],[22.75,154700000],[19.11,129948000],[31.85,216580000]],
            3:[[20.71,138244000],[27.25,181900000],[22.89,152796000],[38.15,254660000]],
            4:[[25.27,167960000],[33.25,221000000],[27.93,185640000],[46.55,309400000]],
            5:[[30.59,204136000],[40.25,268600000],[33.81,225624000],[56.35,376040000]],
            6:[[32.11,217056000],[42.25,285600000],[35.49,239904000],[59.15,399840000]],
            7:[[33.63,229976000],[44.25,302600000],[37.17,254184000],[61.95,423640000]],
            8:[[34.39,235144000],[45.25,309400000],[38.01,259896000],[63.35,433160000]],
            9:[[34.39,235144000],[45.25,309400000],[38.01,259896000],[63.35,433160000]],
            10:[[34.39,235144000],[45.25,309400000],[38.01,259896000],[63.35,433160000]],
            11:[[34.39,235144000],[45.25,309400000],[38.01,259896000],[63.35,433160000]],
            12:[[34.39,235144000],[45.25,309400000],[38.01,259896000],[63.35,433160000]] }
  };
  const vals = [];
  for (const anio of Object.keys(S))
    for (const mes of Object.keys(S[anio]))
      S[anio][mes].forEach(([n, m], i) => vals.push([+anio, +mes, i + 1, n, m]));
  await pool.query('INSERT IGNORE INTO ppsto_cluster (anio, mes, semana, unidades, monto) VALUES ?', [vals]);

  // Card en Reportería: funcionalidad + permiso para el Administrador
  const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/reporteria/' LIMIT 1");
  if (mod) {
    const f = { codigo: 'reporteria_cluster', nombre: 'BDD Cluster Comercial', href: '/reporteria/cluster-comercial', icono: 'bi-globe-americas' };
    const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [f.codigo]);
    let idF = ex && ex.id_funcionalidad;
    if (!idF) {
      const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
        [mod.id_modulo, f.nombre, f.codigo, f.href, f.icono]);
      idF = r.insertId;
    }
    await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idF]);
  }
});

/* GET /cluster-comercial — filas PPSTO vs REAL por AÑO|MES|SEMANA.
   Universo REAL = el mismo del Dashboard de ventas: dedup por operación,
   cartera desde 2025-01, sin CARTERA_AFA, OTORGADOS por fecha_otorgado. */
exports.clusterComercial = async (req, res) => {
  try {
    const [ppsto] = await pool.query('SELECT anio, mes, semana, unidades, monto FROM ppsto_cluster');
    const [real] = await pool.query(`
      SELECT YEAR(fecha_otorgado)  AS anio,
             MONTH(fecha_otorgado) AS mes,
             LEAST(4, FLOOR((DAY(fecha_otorgado)-1)/7) + 1) AS semana,
             COUNT(*) AS n,
             COALESCE(SUM(monto_financiado),0) AS monto
      FROM (
        SELECT *, ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(NULLIF(num_op,''), NULLIF(numero_credito,''), CONCAT('__id', id))
                 ORDER BY id DESC) AS _rn
        FROM creditos
        WHERE mes IS NOT NULL AND mes >= '2025-01-01'
          AND COALESCE(origen,'') <> 'CARTERA_AFA'
      ) ob
      WHERE ob._rn = 1 AND UPPER(estado_eval) = 'OTORGADO' AND fecha_otorgado IS NOT NULL
      GROUP BY 1, 2, 3`);

    // Merge server-side (un solo motor): unión de claves, orden cronológico
    const filas = {};
    const key = r => `${r.anio}|${r.mes}|${r.semana}`;
    ppsto.forEach(r => { filas[key(r)] = { anio: r.anio, mes: r.mes, semana: r.semana,
      ppsto_n: parseFloat(r.unidades), ppsto_m: parseFloat(r.monto), real_n: null, real_m: null }; });
    real.forEach(r => {
      const k = key(r);
      if (!filas[k]) filas[k] = { anio: r.anio, mes: r.mes, semana: r.semana, ppsto_n: null, ppsto_m: null };
      filas[k].real_n = r.n;
      filas[k].real_m = Math.round(parseFloat(r.monto));
    });
    const lista = Object.values(filas).sort((a, b) =>
      a.anio - b.anio || a.mes - b.mes || a.semana - b.semana);
    ok(res, { filas: lista });
  } catch (e) { fail(res, e.message); }
};

/* ── Cartera de Créditos ─────────────────────────────────────────────
   ?desde=YYYY-MM&hasta=YYYY-MM — MESES COMPLETOS por el campo `mes` de
   creditos (la fecha-mes de la base única, que tienen TODAS las etapas).
   Con filtro, TODO el informe se acota al rango, incluida la torta por etapa. */
exports.cartera = async (req, res) => {
  try {
    const { desde, hasta } = req.query;   // 'YYYY-MM'
    const fw = [];
    const fp = [];
    if (/^\d{4}-\d{2}$/.test(desde || '')) { fw.push('mes >= ?'); fp.push(desde + '-01'); }
    if (/^\d{4}-\d{2}$/.test(hasta || '')) { fw.push('mes <= ?'); fp.push(hasta + '-01'); }
    const fMes  = fw.length ? fw.join(' AND ') : '1=1';
    const fOtor = "estado_credito = 'OTORGADO' AND " + fMes;

    const [porEstado] = await pool.query(`
      SELECT COALESCE(estado_credito,'SIN ESTADO') AS estado, COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto
      FROM creditos WHERE ${fMes} GROUP BY estado_credito ORDER BY n DESC`, fp);

    const [porFinanciera] = await pool.query(`
      SELECT COALESCE(financiera,'—') AS financiera, COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto
      FROM creditos WHERE ${fOtor} GROUP BY financiera ORDER BY monto DESC`, fp);

    const [porEjecutivo] = await pool.query(`
      SELECT COALESCE(NULLIF(TRIM(ejecutivo),''),'Sin ejecutivo') AS ejecutivo,
             COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto
      FROM creditos WHERE ${fOtor}
      GROUP BY 1 ORDER BY monto DESC LIMIT 12`, fp);

    // Con filtro usa ese rango; sin filtro, últimos 12 meses
    const [porMes] = await pool.query(`
      SELECT DATE_FORMAT(mes,'%Y-%m') AS mes, COUNT(*) n, COALESCE(SUM(monto_financiado),0) monto
      FROM creditos
      WHERE ${fOtor} AND mes IS NOT NULL
        ${fw.length ? '' : "AND mes >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)"}
      GROUP BY 1 ORDER BY 1`, fp);

    const [carteraPropia] = await pool.query(`
      SELECT COALESCE(estado_cartera,'') AS estado_cartera, COUNT(*) n
      FROM creditos WHERE estado_cartera IS NOT NULL GROUP BY estado_cartera`);

    // KPI: todo respeta el filtro de meses (sin filtro = histórico)
    const [[kpi]] = await pool.query(`
      SELECT (SELECT COUNT(*) FROM creditos WHERE ${fMes}) total,
             COUNT(*) otorgados,
             COALESCE(SUM(monto_financiado),0) monto_otorgado
      FROM creditos WHERE ${fOtor}`, fp.concat(fp));

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
