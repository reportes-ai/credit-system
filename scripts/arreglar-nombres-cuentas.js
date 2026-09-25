'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   NOMBRES DE CUENTAS MAL CODIFICADOS (plan de cuentas heredado de AVSOFT).

   Dos cuentas del plan llegaron con la Ó rota en la importación y se ven
   "PROVISIàN IMPUESTO DIFERIDO" / "CONDONACIàN DE DEUDAS" en el resumen de
   provisiones, en los libros y en cualquier informe que muestre el nombre.
   No es solo estética: el resumen de provisiones tuvo que buscar con
   '%PROVISI%N%' porque 'PROVISION%' no calzaba con esa fila.

   El resto del plan escribe los nombres SIN tilde (PROVISION, INDEMNIZACION,
   CONDONACION), así que se corrigen a la forma sin tilde para quedar parejos.

   Uso:  node scripts/arreglar-nombres-cuentas.js           (simulación)
         node scripts/arreglar-nombres-cuentas.js --apply   (aplica)
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const pool = require('../shared/config/database');

const APLICAR = process.argv.includes('--apply');

/* Lista explícita: se corrige lo que está escrito acá y nada más. */
const CAMBIOS = [
  ['2109030', 'PROVISIàN IMPUESTO DIFERIDO', 'PROVISION IMPUESTO DIFERIDO'],
  ['3001170', 'CONDONACIàN DE DEUDAS', 'CONDONACION DE DEUDAS'],
];

(async () => {
  const backup = [];
  const plan = [];
  for (const [codigo, esperado, nuevo] of CAMBIOS) {
    const [[c]] = await pool.query('SELECT codigo, nombre FROM ctb_cuentas WHERE codigo=?', [codigo]);
    if (!c) { console.log(`— ${codigo}: no existe en el plan, se omite`); continue; }
    if (c.nombre === nuevo) { console.log(`— ${codigo}: ya está corregida`); continue; }
    if (c.nombre !== esperado) { console.log(`⚠ ${codigo}: el nombre actual no es el esperado (${JSON.stringify(c.nombre)}) — NO se toca`); continue; }
    backup.push({ codigo, nombre: c.nombre });
    plan.push([codigo, c.nombre, nuevo]);
    console.log(`${codigo}: ${JSON.stringify(c.nombre)} → ${JSON.stringify(nuevo)}`);
  }
  if (!plan.length) { console.log('\nNada que cambiar.'); process.exit(process.exitCode || 0); }
  if (!APLICAR) { console.log(`\nSimulación: ${plan.length} cuenta(s). Corre con --apply para aplicar.`); process.exit(process.exitCode || 0); }

  // El respaldo se escribe ANTES de tocar la base: si algo falla, el nombre viejo ya está en disco.
  const archivo = path.join(__dirname, `respaldo-nombres-cuentas-${Date.now()}.json`);
  fs.writeFileSync(archivo, JSON.stringify(backup, null, 2), 'utf8');
  console.log(`\nRespaldo en ${archivo}`);

  let n = 0;
  for (const [codigo, , nuevo] of plan) {
    const [u] = await pool.query('UPDATE ctb_cuentas SET nombre=? WHERE codigo=?', [nuevo, codigo]);
    if (!u.affectedRows) { console.error(`✗ ${codigo}: el UPDATE no afectó filas`); process.exitCode = 1; continue; }
    n++;
  }
  console.log(`\n✓ ${n} cuenta(s) corregida(s).`);
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); process.exit(1); });
