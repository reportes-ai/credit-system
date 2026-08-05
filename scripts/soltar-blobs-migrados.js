'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   SOLTAR LOS BLOBS DE LOS DOCUMENTOS YA MIGRADOS

   Este es el ÚNICO paso irreversible de la migración al bucket, y por eso vive
   aparte de `migrar-docs-bucket.js`.

   POR QUÉ NO LO HACE EL SCRIPT DE MIGRACIÓN
   Su bandera `--soltar-blob` suelta el blob EN EL MISMO momento de subirlo, y
   solo mira filas con `doc_ruta IS NULL`. Las filas ya migradas —que son todas—
   quedan fuera de ese SELECT para siempre. Correrlo de nuevo no libera un solo
   byte; hace falta este barrido distinto.

   QUÉ VERIFICA ANTES DE BORRAR (fila por fila, sin excepción)
     1. baja el objeto del bucket
     2. compara el TAMAÑO con el blob de la base
     3. compara el SHA-256 de los dos
   Solo si los tres coinciden se pone el blob en NULL. Que `doc_ruta` esté
   escrito NO es prueba de nada: prueba que alguien dijo que subió, no que el
   archivo esté arriba y esté entero.

   CÓMO SE USA
     node scripts/soltar-blobs-migrados.js              → informe, no borra nada
     node scripts/soltar-blobs-migrados.js <alias>      → una tabla
     node scripts/soltar-blobs-migrados.js todo --si    → todas (el --si es a propósito)
   ───────────────────────────────────────────────────────────────────────────── */

const crypto = require('crypto');
const pool = require('../shared/config/database');
const almacen = require('../shared/almacen-docs');
const { TABLAS } = require('./migrar-docs-bucket-tablas');

const MB = n => (Number(n || 0) / 1048576).toFixed(1) + ' MB';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

async function columnas(tabla) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [tabla]);
  return new Set(rows.map(r => r.c));
}

async function informe() {
  console.log(`\nBucket: ${almacen.BUCKET || '(sin definir)'} — ${almacen.activo() ? 'ACCESIBLE' : 'NO accesible: ' + almacen.estado().motivo}\n`);
  let total = 0, filas = 0;
  for (const [alias, t] of Object.entries(TABLAS)) {
    const cols = await columnas(t.tabla);
    if (!cols.has('doc_ruta')) continue;
    const [[r]] = await pool.query(
      `SELECT COUNT(*) n, COALESCE(SUM(LENGTH(\`${t.blob}\`)),0) bytes
         FROM \`${t.tabla}\` WHERE doc_ruta IS NOT NULL AND \`${t.blob}\` IS NOT NULL`);
    if (!r.n) continue;
    total += Number(r.bytes); filas += Number(r.n);
    console.log(`  ${alias.padEnd(12)} ${String(r.n).padStart(5)} con el archivo duplicado (${MB(r.bytes).padStart(9)})`);
  }
  console.log(`\n  ${filas} filas · ${MB(total)} a liberar`);
  console.log(`\n  Para liberar:  node scripts/soltar-blobs-migrados.js todo --si\n`);
}

async function soltarTabla(alias) {
  const t = TABLAS[alias];
  const cols = await columnas(t.tabla);
  if (!cols.has('doc_ruta')) return;
  const pk = t.pk || 'id';

  let sueltos = 0, bytes = 0, fallas = 0;
  for (;;) {
    /* De a poco y releyendo: el SELECT trae los blobs enteros a memoria. */
    const [filas] = await pool.query(
      `SELECT \`${pk}\` AS pk, \`${t.blob}\` AS blob_data, doc_ruta
         FROM \`${t.tabla}\` WHERE doc_ruta IS NOT NULL AND \`${t.blob}\` IS NOT NULL
        ORDER BY \`${pk}\` LIMIT 5`);
    if (!filas.length) break;
    let avance = false;

    for (const f of filas) {
      const local = Buffer.isBuffer(f.blob_data) ? f.blob_data : Buffer.from(f.blob_data);
      let arriba = null;
      try { arriba = await almacen.obtener({ ruta: f.doc_ruta, blob: null }); }
      catch (e) { console.error(`    ✗ ${t.tabla}#${f.pk}: no se pudo bajar del bucket — ${e.message}`); }

      if (!arriba || arriba.length !== local.length || sha(arriba) !== sha(local)) {
        fallas++;
        console.error(`    ✗ ${t.tabla}#${f.pk}: NO coincide con el bucket — se conserva el blob`);
        /* Se marca para no volver a mirarlo en la vuelta siguiente: sin esto el
           mismo registro fallado vuelve a salir en el LIMIT 5 y el ciclo no
           termina nunca. */
        await pool.query(`UPDATE \`${t.tabla}\` SET doc_storage='db' WHERE \`${pk}\`=?`, [f.pk]);
        await pool.query(`UPDATE \`${t.tabla}\` SET doc_ruta=CONCAT('!revisar:', doc_ruta) WHERE \`${pk}\`=?`, [f.pk]);
        avance = true;
        continue;
      }

      await pool.query(`UPDATE \`${t.tabla}\` SET \`${t.blob}\`=NULL WHERE \`${pk}\`=?`, [f.pk]);
      sueltos++; bytes += local.length; avance = true;
      if (sueltos % 10 === 0) process.stdout.write(`    ${alias}: ${sueltos} liberados (${MB(bytes)})\r`);
    }
    if (!avance) break;
  }
  console.log(`  ${alias.padEnd(12)} ${sueltos} liberados (${MB(bytes)})${fallas ? ` · ${fallas} conservados por no coincidir` : ''}`);
}

(async () => {
  const args = process.argv.slice(2);
  const objetivo = args.find(a => !a.startsWith('--'));
  if (!objetivo) { await informe(); process.exit(0); }

  if (!args.includes('--si')) {
    console.error('\n  Este paso NO tiene vuelta atrás: borra el archivo de la base y queda solo en el bucket.');
    console.error('  Si ya verificaste que se leen desde el bucket, agregá --si\n');
    process.exit(1);
  }
  if (!almacen.activo()) {
    console.error(`\n✗ No hay bucket accesible (${almacen.estado().motivo}). Sin poder leer el bucket no se verifica nada, y sin verificar no se borra.\n`);
    process.exit(1);
  }

  const lista = objetivo === 'todo' ? Object.keys(TABLAS) : [objetivo];
  for (const alias of lista) {
    if (!TABLAS[alias]) { console.error(`  Alias desconocido: ${alias}`); continue; }
    await soltarTabla(alias);
  }
  console.log('');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
