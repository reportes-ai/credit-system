/* Rellena el vendedor real (de la carta) en los créditos de carga masiva 6189618
   y 6189286, que tenían el placeholder "VENDEDOR (AFA) …". Las PRIMAS no se
   pueden recuperar: la carta no las guardaba (corregido en v168.2 — desde ahora
   persisten y fluyen solas); estos dos se completan a mano en el cuadro del
   dashboard. Respaldo inline. */
require('dotenv').config();
const pool = require('../shared/config/database');
(async () => {
  const [rows] = await pool.query(`
    SELECT c.id, c.num_op, c.vendedor AS antes, ca.vendedor AS de_carta
      FROM creditos c JOIN cartas_aprobacion ca ON ca.id_credito_creado = c.id
     WHERE c.id_financiera IN ('6189618','6189286') AND ca.status='APROBADA'`);
  console.log('RESPALDO:', JSON.stringify(rows));
  for (const r of rows) {
    if (!r.de_carta) continue;
    await pool.query(
      `UPDATE creditos SET vendedor=? WHERE id=? AND (COALESCE(vendedor,'')='' OR UPPER(vendedor) LIKE 'VENDEDOR (AFA)%' OR UPPER(vendedor) LIKE 'VENDEDOR%PARQUE%')`,
      [String(r.de_carta).trim().toUpperCase(), r.id]);
    console.log(` ${r.num_op}: "${r.antes}" → "${r.de_carta}"`);
  }
  process.exit(0);
})();
