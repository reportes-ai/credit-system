/* ─────────────────────────────────────────────────────────────────────────────
   SANEO — primas de seguros truncadas por el parser del Informe Canal

   normInt() parseaba "307.000" (texto, punto de miles chileno) como 307 y
   "1.109.286" como 1: 22 operaciones quedaron con primas de $1 a $500, y sus
   comisiones de seguro calculadas sobre esa basura. El parser ya está corregido
   (v170.5); el valor ORIGINAL no es recuperable desde la BD (el truncado es
   ambiguo), así que acá se ANULAN las primas absurdas para que:
     · la operación caiga a "Otorgados con datos faltantes" (visible, no oculto),
     · y el próximo Informe Canal que se cargue las rellene EXACTAS
       (aplicarCanal es fill-only: solo escribe donde hay NULL).
   Después recalcula los meses ABIERTOS afectados. Respaldo con los valores rotos.
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const pool = require('../shared/config/database');
const { recalcularPorOps } = require('../services/creditos/src/utils/recalcular-mes');
(async () => {
  const [rows] = await pool.query(`
    SELECT id, num_op, mes, seguro_rdh, seguro_cesantia, seguro_rep_menor, seguros
      FROM creditos
     WHERE ((seguro_rdh > 0 AND seguro_rdh < 10000) OR (seguro_cesantia > 0 AND seguro_cesantia < 10000)
         OR (seguro_rep_menor > 0 AND seguro_rep_menor < 10000))`);
  console.log('A sanear:', rows.length);
  fs.writeFileSync(path.join(__dirname, 'respaldo-primas-truncadas-2026-08-02.json'), JSON.stringify(rows, null, 2));
  for (const r of rows) {
    const sets = [];
    for (const c of ['seguro_rdh', 'seguro_cesantia', 'seguro_rep_menor'])
      if (Number(r[c]) > 0 && Number(r[c]) < 10000) sets.push(`${c} = NULL`);
    sets.push('seguros = NULL');   // el total se rearma cuando lleguen las primas buenas
    await pool.query(`UPDATE creditos SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, [r.id]);
    console.log(`  ${r.num_op}: ${sets.length - 1} prima(s) anulada(s)`);
  }
  const r2 = await recalcularPorOps(rows.map(r => r.id));   // salta solo los meses cerrados
  console.log('Recalculadas (meses abiertos):', r2.actualizados);
  process.exit(0);
})();
