/* Normaliza la única fila con "CATHERINE VARGAS" (una N) → "CATHERINNE VARGAS".
   OP 519293 (marzo 2026): los agrupados por texto exacto la veían como otra persona.
   Confirmado por Pato 31-07-2026. Valor previo respaldado acá mismo. */
require('dotenv').config();
const pool = require('../shared/config/database');
(async () => {
  const [[antes]] = await pool.query(
    "SELECT id, num_op, ejecutivo FROM creditos WHERE ejecutivo COLLATE utf8mb4_bin = 'CATHERINE VARGAS'");
  console.log('ANTES:', JSON.stringify(antes));
  if (!antes) { console.log('Nada que corregir.'); process.exit(0); }
  await pool.query("UPDATE creditos SET ejecutivo='CATHERINNE VARGAS' WHERE id=?", [antes.id]);
  const [[d]] = await pool.query('SELECT ejecutivo FROM creditos WHERE id=?', [antes.id]);
  console.log('DESPUÉS:', d.ejecutivo);
  process.exit(0);
})();
