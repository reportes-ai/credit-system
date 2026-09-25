#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
   El nombre del vendedor en las cartas, con el mismo formato del maestro (25-09-2026).

   `vendedores_dealer.nombre` quedó en Nombre Propio, pero la copia que guarda cada
   carta venía en MAYÚSCULAS (el generador las forzaba). El módulo Vendedores con
   Ventas cruza carta ↔ vendedor por NOMBRE normalizado (ignora mayúsculas), así que
   el cambio no altera ningún cruce; lo que arregla es que el selector de la carta
   encuentre al vendedor en la lista y no lo muestre duplicado.

   Solo se tocan filas donde el cambio es de PURO FORMATO (mismo nombre escrito
   distinto). Si el texto cambiara, la fila se salta y se reporta.

     node scripts/homologar-vendedor-cartas.js           → simula
     node scripts/homologar-vendedor-cartas.js --apply   → aplica, con respaldo
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const pool = require('../shared/config/database');
const NOM = require('../api-gateway/public/js/nombres-core');

const APLICAR = process.argv.includes('--apply');
/* creditos.vendedor NO se toca: ahí vive el placeholder de Trinidad ("VENDEDOR (AFA)",
   "VENDEDOR PARQUE…"), que es otra cosa y el sistema lo detecta por texto. */
const TABLAS = [['cartas_aprobacion', 'id', 'vendedor']];

(async () => {
  console.log(APLICAR ? '=== APLICANDO ===\n' : '=== SIMULACIÓN (no escribe nada) ===\n');
  const cambios = [], saltadas = [];

  for (const [tabla, pk, col] of TABLAS) {
    let filas = [];
    try { [filas] = await pool.query(`SELECT ${pk} id, ${col} v FROM ${tabla} WHERE ${col} IS NOT NULL AND ${col} <> ''`); }
    catch (e) { console.log(`  (sin ${tabla})`); continue; }
    for (const f of filas) {
      const despues = NOM.persona(f.v);
      if (despues === f.v) continue;
      if (!NOM.mismoNombre(f.v, despues)) { saltadas.push(`${tabla} #${f.id}: "${f.v}"`); continue; }
      cambios.push({ tabla, pk, col, id: f.id, antes: f.v, despues });
    }
    console.log(`  ${tabla}.${col}: ${filas.length} con vendedor · ${cambios.filter(c => c.tabla === tabla).length} a homologar`);
  }

  console.log('\n  Ejemplos:');
  cambios.slice(0, 10).forEach(c => console.log(`    #${c.id}: "${c.antes}" → "${c.despues}"`));
  if (saltadas.length) { console.log(`\n  ⚠ ${saltadas.length} saltada(s) porque cambiaba el texto:`); saltadas.slice(0, 5).forEach(x => console.log('    ' + x)); }

  /* Cuántas de esas cartas quedan calzando con el maestro (lo que arregla el selector) */
  const [[{ n: maestro }]] = await pool.query('SELECT COUNT(*) n FROM vendedores_dealer');
  console.log(`\n  Maestro de vendedores: ${maestro} nombres.`);

  if (!APLICAR) { console.log('\nSimulación: no se escribió nada.'); process.exit(0); }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const c of cambios) await conn.query(`UPDATE ${c.tabla} SET ${c.col}=? WHERE ${c.pk}=?`, [c.despues, c.id]);
    await conn.commit();
    const f = path.join(__dirname, `respaldo-vendedor-cartas-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify(cambios, null, 1), 'utf8');
    console.log(`\n✓ ${cambios.length} carta(s) homologada(s). Respaldo en ${f}`);
  } catch (e) { await conn.rollback(); console.error('ROLLBACK:', e.message); process.exitCode = 1; }
  finally { conn.release(); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
