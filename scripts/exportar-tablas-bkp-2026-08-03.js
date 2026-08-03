'use strict';
/* Exporta a disco TODAS las tablas de respaldo (prefijo bkp_ o tmp_) que quedan
   en producción, para poder eliminarlas del esquema con red de seguridad.
   Auditoría 03-08-2026, hallazgo C-2.

   Por cada tabla escribe:
     · <tabla>.json  → filas completas (fidelidad de tipos y NULL)
     · <tabla>.sql   → CREATE TABLE original (para poder reconstruirla)
   Más un INVENTARIO.md con el detalle de todo lo exportado.

   Destino: fuera del repositorio (contiene datos personales).            */
const pool = require('../shared/config/database');
const fs   = require('fs');
const path = require('path');

const DESTINO = process.argv[2] || 'C:\\Users\\patri\\Documents\\respaldos-bd\\bkp-tablas-2026-08-03';

(async () => {
  if (!fs.existsSync(DESTINO)) fs.mkdirSync(DESTINO, { recursive: true });

  const [tablas] = await pool.query(`
    SELECT table_name n FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND (table_name LIKE 'bkp%' OR table_name LIKE 'tmp%' OR table_name LIKE '%_old'
            OR table_name LIKE '%_backup%' OR table_name LIKE '%_bak'
            OR table_name = 'ia_liquidaciones')   -- auditoria A-9: respaldos con otra convencion
     ORDER BY table_name`);

  const inv = [];
  let totalFilas = 0;

  for (const t of tablas) {
    const tabla = t.n;
    const [[{ n: filas }]] = await pool.query(`SELECT COUNT(*) n FROM \`${tabla}\``);
    const [[ct]] = await pool.query(`SHOW CREATE TABLE \`${tabla}\``);
    fs.writeFileSync(path.join(DESTINO, `${tabla}.sql`), (ct['Create Table'] || '') + ';\n', 'utf8');

    // Lectura por tandas: ninguna tabla es enorme, pero así no se carga todo de una
    const datos = [];
    const PASO = 5000;
    for (let off = 0; off < filas; off += PASO) {
      const [chunk] = await pool.query(`SELECT * FROM \`${tabla}\` LIMIT ? OFFSET ?`, [PASO, off]);
      datos.push(...chunk);
    }
    fs.writeFileSync(path.join(DESTINO, `${tabla}.json`), JSON.stringify(datos, null, 1), 'utf8');

    const kb = Math.round(fs.statSync(path.join(DESTINO, `${tabla}.json`)).size / 1024);
    inv.push({ tabla, filas, kb });
    totalFilas += filas;
    console.log(`✓ ${tabla.padEnd(42)} ${String(filas).padStart(6)} filas · ${kb} KB`);
  }

  const md = [
    '# Respaldo de tablas bkp_ — producción AutoFácil',
    '',
    `Exportado: 03-08-2026 · ${tablas.length} tablas · ${totalFilas.toLocaleString('es-CL')} filas`,
    '',
    '**CONTIENE DATOS PERSONALES** (RUT, nombres, direcciones, rentas). Guardar en lugar seguro.',
    '',
    'Cada tabla tiene dos archivos: `.json` con las filas y `.sql` con su CREATE TABLE.',
    'Para reconstruir una: ejecutar el `.sql` y reinsertar el `.json`.',
    '',
    '| Tabla | Filas | JSON |',
    '|---|---:|---:|',
    ...inv.map(x => `| ${x.tabla} | ${x.filas.toLocaleString('es-CL')} | ${x.kb} KB |`),
  ].join('\n');
  fs.writeFileSync(path.join(DESTINO, 'INVENTARIO.md'), md, 'utf8');

  console.log(`\n${tablas.length} tablas · ${totalFilas.toLocaleString('es-CL')} filas → ${DESTINO}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
