#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
   El TITULAR de la cuenta sigue la marca "la cuenta es de" (25-09-2026).

   La homologación anterior lo pasó a Nombre Propio parejo, pero cuando la cuenta
   es de la EMPRESA el titular es una razón social y va en MAYÚSCULAS.

     · dealers / dealer_fichas → columna `cuenta_tipo` (EMPRESA | PERSONA)
     · parques_ficha           → ahí `cuenta_tipo` guarda el tipo de cuenta
                                 (Corriente/Vista), así que se deduce del RUT de
                                 la cuenta con la regla del sistema (> 50.000.000).

     node scripts/homologar-titular-cuenta.js           → simula
     node scripts/homologar-titular-cuenta.js --apply   → aplica, con respaldo
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const pool = require('../shared/config/database');
const NOM = require('../api-gateway/public/js/nombres-core');

const APLICAR = process.argv.includes('--apply');
const cambios = [];

async function revisar(tabla, pk, porRut) {
  let filas = [];
  try { [filas] = await pool.query(`SELECT ${pk} id, nombre_cuenta, cuenta_tipo${porRut ? ', rut_cuenta' : ''} FROM ${tabla}`); }
  catch (e) { console.log(`  (sin ${tabla} en este ambiente)`); return; }
  for (const f of filas) {
    if (!f.nombre_cuenta || !String(f.nombre_cuenta).trim()) continue;
    const marca = porRut ? NOM.cuentaTipoDeRut(f.rut_cuenta) : f.cuenta_tipo;
    const despues = NOM.titular(f.nombre_cuenta, marca);
    if (despues !== f.nombre_cuenta) cambios.push({ tabla, pk, id: f.id, antes: f.nombre_cuenta, despues, marca: marca || '(sin marca)' });
  }
}

(async () => {
  console.log(APLICAR ? '=== APLICANDO ===\n' : '=== SIMULACIÓN (no escribe nada) ===\n');
  await revisar('dealers', 'id_dealer', false);
  await revisar('dealer_fichas', 'id', false);
  await revisar('parques_ficha', 'id', true);

  const porTabla = {};
  cambios.forEach(c => { porTabla[c.tabla] = (porTabla[c.tabla] || 0) + 1; });
  Object.entries(porTabla).forEach(([t, n]) => console.log(`  ${t.padEnd(16)} ${n}`));
  console.log('\n  Ejemplos:');
  cambios.slice(0, 10).forEach(c => console.log(`    ${c.tabla} #${c.id} [${c.marca}]: "${c.antes}" → "${c.despues}"`));
  if (!cambios.length) console.log('  Nada que cambiar.');

  if (!APLICAR) { console.log('\nSimulación: no se escribió nada.'); process.exit(0); }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const c of cambios) await conn.query(`UPDATE ${c.tabla} SET nombre_cuenta=? WHERE ${c.pk}=?`, [c.despues, c.id]);
    await conn.commit();
    const f = path.join(__dirname, `respaldo-titular-cuenta-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify(cambios, null, 1), 'utf8');
    console.log(`\n✓ ${cambios.length} titular(es) corregido(s). Respaldo en ${f}`);
  } catch (e) { await conn.rollback(); console.error('ROLLBACK:', e.message); process.exitCode = 1; }
  finally { conn.release(); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
