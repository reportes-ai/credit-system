require('dotenv').config();
const pool = require('./shared/config/database');
const { recalcularMeses } = require('./services/creditos/src/utils/recalcular-mes');
const FIN = ['AUTOFIN','UNIDAD DE CREDITO'];
(async () => {
  const t0=process.hrtime.bigint();
  const [ms] = await pool.query(`SELECT DISTINCT DATE_FORMAT(mes,'%Y-%m') m FROM creditos WHERE mes IS NOT NULL AND UPPER(financiera) IN (?) ORDER BY m`,[FIN]);
  const meses = ms.map(r=>r.m).filter(Boolean);
  console.log(`Meses brokerage: ${meses.length} → ${meses.join(', ')}`);
  const sum = async (where) => (await pool.query(`SELECT ROUND(SUM(monto_comision_fin)) mcf, ROUND(SUM(ingreso_neto_total)) ing FROM creditos WHERE ${where}`))[0][0];
  const brokWhere = `UPPER(financiera) IN ('AUTOFIN','UNIDAD DE CREDITO')`;
  const antes = await sum(brokWhere);
  const res = await recalcularMeses(meses, { soloFinancieras: FIN });
  const desp = await sum(brokWhere);
  // AUTOFACIL intacto?
  const [[af]] = await pool.query(`SELECT SUM(ABS(COALESCE(c.monto_comision_fin,0)-COALESCE(b.monto_comision_fin,0))>1) dif
    FROM creditos c JOIN bkp_recalc_20260629 b ON b.id=c.id WHERE UPPER(c.financiera)='AUTOFACIL'`);
  const secs=Number((process.hrtime.bigint()-t0)/1000000000n);
  console.log(`✓ recalc en ${secs}s — ops actualizadas: ${res.actualizados}`);
  console.log(`BROKERAGE Σ ingreso colocación: ${(+antes.mcf).toLocaleString('es-CL')} → ${(+desp.mcf).toLocaleString('es-CL')}  (Δ ${((desp.mcf/antes.mcf-1)*100).toFixed(1)}%)`);
  console.log(`BROKERAGE Σ ingreso neto:       ${(+antes.ing).toLocaleString('es-CL')} → ${(+desp.ing).toLocaleString('es-CL')}  (Δ ${((desp.ing/antes.ing-1)*100).toFixed(1)}%)`);
  console.log(`AUTOFACIL tocadas (debe ser 0): ${+af.dif}  ${+af.dif===0?'✓ intacta':'⚠ CORRUPCIÓN'}`);
  await pool.end();
})().catch(e=>{console.error(e.message);process.exit(1)});
