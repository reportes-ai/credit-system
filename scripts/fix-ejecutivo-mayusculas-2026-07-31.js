/* ─────────────────────────────────────────────────────────────────────────────
   NORMALIZACIÓN — creditos.ejecutivo a MAYÚSCULAS

   El crédito que nace de una carta copiaba el ejecutivo tal como se digitó
   ("Fernando Contreras"). Los agrupados (dashboard, comisiones, vendedores,
   rankings) agrupan por texto exacto, así que ese crédito contaba en un
   "ejecutivo" aparte y el conteo del mes salía corto (Contreras aparecía con 9
   teniendo 10). Desde v168.1 el INSERT normaliza; esto arregla lo ya guardado.

   Reversible: filas previas en scripts/respaldo-ejecutivo-mayusculas-2026-07-31.json
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const pool = require('../shared/config/database');
(async () => {
  const [filas] = await pool.query(`
    SELECT id, num_op, ejecutivo FROM creditos
     WHERE ejecutivo IS NOT NULL AND ejecutivo <> '' AND ejecutivo <> UPPER(ejecutivo) COLLATE utf8mb4_bin`);
  console.log('Con minúsculas:', filas.length);
  filas.forEach(f => console.log(' ', f.num_op, '→', JSON.stringify(f.ejecutivo)));
  if (!filas.length) process.exit(0);
  fs.writeFileSync(path.join(__dirname, 'respaldo-ejecutivo-mayusculas-2026-07-31.json'), JSON.stringify(filas, null, 2));
  const [r] = await pool.query(`
    UPDATE creditos SET ejecutivo = UPPER(ejecutivo)
     WHERE ejecutivo IS NOT NULL AND ejecutivo <> '' AND ejecutivo <> UPPER(ejecutivo) COLLATE utf8mb4_bin`);
  console.log('Normalizados:', r.affectedRows);
  process.exit(0);
})();
