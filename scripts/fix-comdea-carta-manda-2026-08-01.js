/* ─────────────────────────────────────────────────────────────────────────────
   CONCILIACIÓN — comdea_real = participación PACTADA de la carta vigente

   13 otorgadas (jun-jul 2026) quedaron con el comdea del motor distinto de la
   carta porque AutoFin las cursó vía sync de Trinidad, sin pasar por el botón
   otorgar (el único punto que conciliaba). La cartola siempre pagó lo de la
   carta (COALESCE); esto alinea el crédito para que dashboard/rentabilidad
   digan LO MISMO que se paga. Desde v169.2 el motor de recálculo aplica esta
   precedencia solo (forzado > carta vigente > cálculo).

   El ingreso_neto_total se ajusta por la diferencia (comDealer RESTA en el
   neto). Se salta la 89199: su comdea está FORZADO a mano — decisión humana,
   se consulta aparte. Respaldo: respaldo-comdea-carta-2026-08-01.json
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const pool = require('../shared/config/database');
(async () => {
  const [rows] = await pool.query(`
    SELECT c.id, c.num_op, c.comdea_real, c.ingreso_neto_total, c.campos_forzados,
           ca.part_bruto, ca.op_carta
      FROM creditos c
      JOIN cartas_aprobacion ca ON ca.id_financiera = c.id_financiera AND ca.status='APROBADA'
     WHERE c.estado_credito='OTORGADO' AND c.fecha_otorgado >= '2026-06-01'
       AND COALESCE(ca.part_bruto,0) > 0
       AND ABS(COALESCE(c.comdea_real,0) - ca.part_bruto) > 1`);
  const aplicar = rows.filter(r => !String(r.campos_forzados || '').includes('comdea_real'));
  console.log('Descuadres:', rows.length, '| a conciliar:', aplicar.length, '| forzados que se respetan:', rows.length - aplicar.length);
  fs.writeFileSync(path.join(__dirname, 'respaldo-comdea-carta-2026-08-01.json'), JSON.stringify(rows, null, 2));
  for (const r of aplicar) {
    const dif = (Number(r.comdea_real) || 0) - Number(r.part_bruto);   // + si el motor cobraba de más
    await pool.query(
      `UPDATE creditos SET comdea_real = ?, ingreso_neto_total = COALESCE(ingreso_neto_total,0) + ?,
              campos_forzados = JSON_ARRAY_APPEND(COALESCE(campos_forzados, JSON_ARRAY()), '$', 'comdea_real')
        WHERE id = ?`, [Number(r.part_bruto), dif, r.id]);
    console.log(` ${r.num_op} (${r.op_carta}): ${Number(r.comdea_real).toLocaleString('es-CL')} → ${Number(r.part_bruto).toLocaleString('es-CL')} | neto ${dif>0?'+':''}${dif.toLocaleString('es-CL')}`);
  }
  process.exit(0);
})();
