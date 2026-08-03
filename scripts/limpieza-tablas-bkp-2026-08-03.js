'use strict';
/* Auditoría 03-08-2026 (hallazgo C-2): 35 tablas de respaldo con datos personales
   viviendo en producción, fuera de todo control de acceso de la aplicación.

   Esta primera pasada es la CONSERVADORA:
     · Exporta a JSON (respaldo frío local) `bkp_rutmig_usuarios` — la más sensible,
       contiene los usuarios del sistema con sus hashes.
     · Elimina esa tabla y las que están en CERO filas (no hay nada que perder).
     · NO toca las demás: se listan al final para decidirlas una a una.

   Uso:  node scripts/limpieza-tablas-bkp-2026-08-03.js            (simulación)
         node scripts/limpieza-tablas-bkp-2026-08-03.js --ejecutar (aplica)     */
const pool = require('../shared/config/database');
const fs   = require('fs');
const path = require('path');

const EJECUTAR = process.argv.includes('--ejecutar');
const DESTINO  = path.join(__dirname, 'respaldo-bkp-2026-08-03');

(async () => {
  const [tablas] = await pool.query(`
    SELECT table_name n FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND (table_name LIKE 'bkp%' OR table_name LIKE '%_old' OR table_name LIKE 'tmp%')
     ORDER BY table_name`);

  // Conteo REAL (information_schema.table_rows es una estimación en TiDB)
  const conteo = {};
  for (const t of tablas) {
    const [[c]] = await pool.query(`SELECT COUNT(*) n FROM \`${t.n}\``);
    conteo[t.n] = Number(c.n);
  }

  const vacias    = tablas.map(t => t.n).filter(n => conteo[n] === 0);
  const sensibles = ['bkp_rutmig_usuarios'].filter(n => conteo[n] > 0);
  const resto     = tablas.map(t => t.n).filter(n => conteo[n] > 0 && !sensibles.includes(n));

  console.log(`\n${tablas.length} tablas de respaldo en producción\n`);
  console.log(`A ELIMINAR ahora (${vacias.length + sensibles.length}):`);
  sensibles.forEach(n => console.log(`   ${n}  (${conteo[n]} filas — se exporta antes)`));
  vacias.forEach(n => console.log(`   ${n}  (vacía)`));
  console.log(`\nQUEDAN para decidir (${resto.length}):`);
  resto.forEach(n => console.log(`   ${n}  (${conteo[n]} filas)`));

  if (!EJECUTAR) { console.log('\n[SIMULACIÓN] Nada se borró. Corre con --ejecutar para aplicar.\n'); process.exit(0); }

  // 1) Respaldo frío de las sensibles
  if (sensibles.length) {
    if (!fs.existsSync(DESTINO)) fs.mkdirSync(DESTINO, { recursive: true });
    for (const n of sensibles) {
      const [filas] = await pool.query(`SELECT * FROM \`${n}\``);
      const archivo = path.join(DESTINO, `${n}.json`);
      fs.writeFileSync(archivo, JSON.stringify(filas, null, 2), 'utf8');
      console.log(`\n✓ Exportada ${n} → ${archivo} (${filas.length} filas)`);
    }
  }

  // 2) Eliminación
  for (const n of [...sensibles, ...vacias]) {
    await pool.query(`DROP TABLE \`${n}\``);
    console.log(`✓ Eliminada ${n}`);
  }

  const [quedan] = await pool.query(`
    SELECT COUNT(*) n FROM information_schema.tables
     WHERE table_schema = DATABASE() AND (table_name LIKE 'bkp%' OR table_name LIKE 'tmp%')`);
  console.log(`\nQuedan ${quedan[0].n} tablas de respaldo en producción (las de la lista de arriba).`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
