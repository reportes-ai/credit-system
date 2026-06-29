require('dotenv').config();
const pool = require('./shared/config/database');
const { recalcularMeses } = require('./services/creditos/src/utils/recalcular-mes');
(async () => {
  // 1) Respaldo columnas financieras (reversible)
  await pool.query('DROP TABLE IF EXISTS bkp_recalc_20260629');
  await pool.query(`CREATE TABLE bkp_recalc_20260629 (
    id INT PRIMARY KEY, monto_comision_fin DECIMAL(16,2), ingreso_neto_total DECIMAL(16,2),
    comdea_real DECIMAL(16,2), com_parque DECIMAL(16,2), comej DECIMAL(16,2),
    com_rdh DECIMAL(16,2), com_cesantia DECIMAL(16,2), com_reparaciones DECIMAL(16,2))`);
  await pool.query(`INSERT INTO bkp_recalc_20260629 SELECT id, monto_comision_fin, ingreso_neto_total,
    comdea_real, com_parque, comej, com_rdh, com_cesantia, com_reparaciones FROM creditos`);
  const [[bk]] = await pool.query('SELECT COUNT(*) n FROM bkp_recalc_20260629');
  console.log(`✓ Respaldo bkp_recalc_20260629 (${bk.n} filas)`);

  // 2) Totales ANTES
  const tot = async () => (await pool.query(`SELECT
     ROUND(SUM(monto_comision_fin)) mcf, ROUND(SUM(ingreso_neto_total)) ing FROM creditos`))[0][0];
  const antes = await tot();
  console.log(`Antes  → Σ ingreso colocación ${(+antes.mcf).toLocaleString('es-CL')} | Σ ingreso neto ${(+antes.ing).toLocaleString('es-CL')}`);

  // 3) Meses presentes (abiertos los procesa; cerrados los salta internamente)
  const [ms] = await pool.query(`SELECT DISTINCT DATE_FORMAT(mes,'%Y-%m') m FROM creditos WHERE mes IS NOT NULL ORDER BY m`);
  const meses = ms.map(r=>r.m).filter(Boolean);
  console.log(`Recalculando ${meses.length} meses: ${meses.join(', ')}`);
  const res = await recalcularMeses(meses);
  console.log(`✓ recalcularMeses → ${res.actualizados} ops actualizadas`);
  res.log.slice(0,12).forEach(l=>console.log('   '+l));

  // 4) Totales DESPUÉS + delta
  const desp = await tot();
  console.log(`Después→ Σ ingreso colocación ${(+desp.mcf).toLocaleString('es-CL')} | Σ ingreso neto ${(+desp.ing).toLocaleString('es-CL')}`);
  console.log(`Δ ingreso colocación: ${(desp.mcf-antes.mcf).toLocaleString('es-CL')} (${((desp.mcf/antes.mcf-1)*100).toFixed(1)}%)`);
  console.log(`Δ ingreso neto:       ${(desp.ing-antes.ing).toLocaleString('es-CL')} (${((desp.ing/antes.ing-1)*100).toFixed(1)}%)`);
  console.log('Rollback: UPDATE creditos c JOIN bkp_recalc_20260629 b ON b.id=c.id SET c.monto_comision_fin=b.monto_comision_fin, c.ingreso_neto_total=b.ingreso_neto_total, c.comdea_real=b.comdea_real, c.com_parque=b.com_parque, c.comej=b.comej, c.com_rdh=b.com_rdh, c.com_cesantia=b.com_cesantia, c.com_reparaciones=b.com_reparaciones;');
  await pool.end();
})().catch(e=>{console.error(e.message); console.error(e.stack); process.exit(1)});
