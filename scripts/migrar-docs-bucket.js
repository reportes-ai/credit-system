'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   MIGRAR DOCUMENTOS DE LA BASE AL BUCKET

   Mueve los archivos que ya estaban guardados dentro de la base (LONGBLOB) al
   bucket de Google Cloud Storage, dejando en la fila solo la referencia.

   CÓMO SE USA
     node scripts/migrar-docs-bucket.js                 → informe, NO mueve nada
     node scripts/migrar-docs-bucket.js fundantes       → mueve una tabla
     node scripts/migrar-docs-bucket.js todo            → mueve todas

   POR QUÉ EL ORDEN ES ESTE, Y NO AL REVÉS
   Para cada archivo: 1) se sube al bucket, 2) se verifica que quedó arriba con
   el mismo tamaño, 3) recién entonces la fila apunta al bucket y suelta el blob.
   Si el proceso se corta en cualquier punto, el documento sigue siendo legible:
   o desde la base (aún no se migró) o desde el bucket (ya se migró). Nunca hay
   un instante en que no esté en ninguna parte.

   Es RE-EJECUTABLE: solo toma filas con blob y sin `doc_ruta`. Correrlo dos
   veces no duplica nada.

   VUELTA ATRÁS: mientras no se corra `--soltar-blob`, el archivo queda en los
   DOS lados y basta con borrar `doc_ruta` para volver a leer de la base. El
   espacio recién se libera cuando se sueltan los blobs, que es un paso aparte
   y deliberado.

   OJO CON `--soltar-blob`: suelta el blob en el mismo momento de subirlo, y
   solo alcanza a las filas con `doc_ruta IS NULL`. Para liberar el espacio de
   lo YA migrado —que es el caso normal— va `scripts/soltar-blobs-migrados.js`,
   que verifica tamaño y SHA-256 contra el bucket antes de borrar nada.
   ───────────────────────────────────────────────────────────────────────────── */

const pool = require('../shared/config/database');
const almacen = require('../shared/almacen-docs');

/* El mapa de tablas vive aparte porque lo comparte con soltar-blobs-migrados.js
   (una sola lista; dos copias se desincronizan). */
const { TABLAS } = require('./migrar-docs-bucket-tablas');

const MB = n => (Number(n || 0) / 1048576).toFixed(1) + ' MB';

/* Las columnas cambian de nombre entre tablas y algunas ni siquiera existen
   (informes_dealernet no guarda mime). Se consulta el esquema real en vez de
   confiar en el mapa: una columna que no existe reventaría el SELECT entero. */
async function columnas(tabla) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [tabla]);
  return new Set(rows.map(r => r.c));
}

async function informe() {
  console.log(`\nBucket: ${almacen.BUCKET || '(sin definir)'} — ${almacen.activo() ? 'ACCESIBLE' : 'NO accesible: ' + almacen.estado().motivo}\n`);
  let totalPend = 0, totalMig = 0;
  for (const [alias, t] of Object.entries(TABLAS)) {
    const cols = await columnas(t.tabla);
    if (!cols.size) { console.log(`  ${alias.padEnd(12)} (la tabla no existe todavía)`); continue; }
    const tieneRuta = cols.has('doc_ruta');
    const [[r]] = await pool.query(
      `SELECT SUM(CASE WHEN \`${t.blob}\` IS NOT NULL THEN 1 ELSE 0 END) en_base,
              COALESCE(SUM(LENGTH(\`${t.blob}\`)),0) bytes
             ${tieneRuta ? ', SUM(CASE WHEN doc_ruta IS NOT NULL THEN 1 ELSE 0 END) en_bucket' : ', 0 en_bucket'}
         FROM \`${t.tabla}\``);
    totalPend += Number(r.bytes); totalMig += Number(r.en_bucket || 0);
    console.log(`  ${alias.padEnd(12)} ${String(r.en_base || 0).padStart(5)} en la base (${MB(r.bytes).padStart(9)})  ${String(r.en_bucket || 0).padStart(5)} en el bucket${tieneRuta ? '' : '   ← falta cablear (sin doc_ruta)'}`);
  }
  console.log(`\n  Por mover: ${MB(totalPend)} · ya en el bucket: ${totalMig} archivos`);
  console.log(`\n  Para mover:  node scripts/migrar-docs-bucket.js <alias|todo>\n`);
}

async function migrarTabla(alias, { soltarBlob }) {
  const t = TABLAS[alias];
  const cols = await columnas(t.tabla);
  if (!cols.has('doc_ruta')) { console.log(`  ${alias}: todavía no está cableado al almacén (no tiene doc_ruta). Se salta.`); return; }

  const pk = t.pk || 'id';
  const campos = [`\`${pk}\` AS pk`, `\`${t.blob}\` AS blob_data`, `\`${t.clave}\` AS clave`];
  if (t.nombre && cols.has(t.nombre)) campos.push(`\`${t.nombre}\` AS nombre`);
  if (t.mime && cols.has(t.mime)) campos.push(`\`${t.mime}\` AS mime`);

  let movidos = 0, bytes = 0, fallas = 0;
  /* De a uno y releyendo cada vez: un lote grande de blobs en memoria es
     justamente lo que hizo caer la conexión al armar la base de staging. */
  for (;;) {
    const [filas] = await pool.query(
      `SELECT ${campos.join(', ')} FROM \`${t.tabla}\`
        WHERE \`${t.blob}\` IS NOT NULL AND doc_ruta IS NULL
        ORDER BY \`${pk}\` LIMIT 5`);
    if (!filas.length) break;

    for (const f of filas) {
      const buffer = Buffer.isBuffer(f.blob_data) ? f.blob_data : Buffer.from(f.blob_data);
      const d = await almacen.colocar({
        ambito: t.ambito, clave: f.clave, buffer,
        mime: f.mime || null, nombre: f.nombre || `${alias}-${f.pk}`
      });
      /* colocar() cae a la base si el bucket falla — acá eso no sirve de nada,
         así que se cuenta como falla y se sigue con el siguiente. */
      if (d.storage !== 'gcs') { fallas++; console.error(`    ✗ ${t.tabla}#${f.pk}: no se pudo subir`); continue; }

      /* Verificación antes de soltar: que el objeto exista y pese lo mismo.
         Una subida "exitosa" que dejó 0 bytes destruiría el documento al
         borrar el blob, y el error solo aparecería meses después. */
      const arriba = await almacen.obtener({ ruta: d.ruta, blob: null });
      if (!arriba || arriba.length !== buffer.length) {
        fallas++; console.error(`    ✗ ${t.tabla}#${f.pk}: el archivo subido no coincide (${arriba ? arriba.length : 0} vs ${buffer.length} bytes)`);
        await almacen.borrar(d.ruta);
        continue;
      }

      await pool.query(
        `UPDATE \`${t.tabla}\` SET doc_storage='gcs', doc_ruta=?, doc_bytes=?${soltarBlob ? `, \`${t.blob}\`=NULL` : ''} WHERE \`${pk}\`=?`,
        [d.ruta, d.bytes, f.pk]);
      movidos++; bytes += d.bytes;
      if (movidos % 10 === 0) process.stdout.write(`    ${movidos} movidos (${MB(bytes)})\r`);
    }
  }
  console.log(`  ${alias.padEnd(12)} ${movidos} movidos (${MB(bytes)})${fallas ? ` · ${fallas} con problemas` : ''}${soltarBlob ? ' · blobs liberados' : ' · el blob se conservó (usar --soltar-blob para liberar el espacio)'}`);
}

(async () => {
  const args = process.argv.slice(2);
  const soltarBlob = args.includes('--soltar-blob');
  const objetivo = args.find(a => !a.startsWith('--'));

  if (!objetivo) { await informe(); process.exit(0); }

  if (!almacen.activo()) {
    console.error(`\n✗ No hay bucket accesible (${almacen.estado().motivo}).`);
    console.error('  Definí GCS_BUCKET y GCS_CREDENCIALES antes de migrar.\n');
    process.exit(1);
  }

  const lista = objetivo === 'todo' ? Object.keys(TABLAS) : [objetivo];
  for (const alias of lista) {
    if (!TABLAS[alias]) { console.error(`  Alias desconocido: ${alias}. Opciones: ${Object.keys(TABLAS).join(', ')}, todo`); continue; }
    await migrarTabla(alias, { soltarBlob });
  }
  console.log('');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
