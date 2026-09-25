#!/usr/bin/env node
/* ─────────────────────────────────────────────────────────────────────────────
   Homologa el FORMATO de los nombres ya guardados (25-09-2026).

     Empresas (dealer, razón social, fantasía, parque) → MAYÚSCULAS
     Personas (socios, representante legal, contactos, titular) → Nombre Propio

   Usa el motor único api-gateway/public/js/nombres-core.js, el mismo que aplican
   el formulario y el backend al guardar.

   ⚠ `dealers.nombre_indexa` es la LLAVE de match con `creditos.automotora` y la
   base es CASE-SENSITIVE (utf8mb4_bin). Por eso ese campo se cambia SIEMPRE junto
   con sus copias, en la misma transacción, y solo cuando el cambio es de puro
   formato (mismo nombre escrito distinto). Si el texto cambiara de verdad, la fila
   se salta y se reporta.

     node scripts/homologar-nombres-dealers.js            → simula, no escribe nada
     node scripts/homologar-nombres-dealers.js --apply    → aplica, con respaldo JSON
   ───────────────────────────────────────────────────────────────────────────── */
const fs = require('fs');
const path = require('path');
const pool = require('../shared/config/database');
const NOM = require('../api-gateway/public/js/nombres-core');

const APLICAR = process.argv.includes('--apply');
const cambios = [];          // { tabla, columna, id, antes, despues }
const respaldo = [];

const registrar = (tabla, columna, id, antes, despues) => {
  if (antes == null || String(antes).trim() === '') return;
  if (String(antes) === String(despues)) return;
  cambios.push({ tabla, columna, id, antes, despues });
};

/* Copias del nombre del dealer (snapshots). Se mueven junto con nombre_indexa. */
const COPIAS = [
  ['creditos', 'automotora'],
  ['cartas_aprobacion', 'nombre_dealer'],
  ['cartas_aprobacion', 'automotora'],
  ['cartolas_movimientos', 'nombre_dealer'],
  ['postventa_seguimiento', 'nombre_dealer'],
];

async function main() {
  console.log(APLICAR ? '=== APLICANDO ===' : '=== SIMULACIÓN (no escribe nada) ===\n');

  /* ── 1. dealers: razón social (empresa) y personas ─────────────────────── */
  const [dealers] = await pool.query('SELECT id_dealer, numero, nombre_indexa, nombre_razon, contacto, nombre_cuenta FROM dealers');
  for (const d of dealers) {
    registrar('dealers', 'nombre_razon', d.id_dealer, d.nombre_razon, NOM.empresa(d.nombre_razon));
    registrar('dealers', 'contacto', d.id_dealer, d.contacto, NOM.persona(d.contacto));
    registrar('dealers', 'nombre_cuenta', d.id_dealer, d.nombre_cuenta, NOM.persona(d.nombre_cuenta));
  }

  /* ── 2. dealers.nombre_indexa + sus copias ─────────────────────────────── */
  const renombres = [];      // { id_dealer, antes, despues, copias: {tabla.col: n} }
  for (const d of dealers) {
    const antes = d.nombre_indexa, despues = NOM.empresa(antes);
    if (!antes || antes === despues) continue;
    if (!NOM.mismoNombre(antes, despues)) { console.log(`  ⚠ ${d.numero}: "${antes}" → "${despues}" cambia el texto, se salta`); continue; }
    const copias = {};
    for (const [tabla, col] of COPIAS) {
      try {
        const [[r]] = await pool.query(`SELECT COUNT(*) n FROM \`${tabla}\` WHERE \`${col}\` = ?`, [antes]);
        if (r.n) copias[`${tabla}.${col}`] = r.n;
      } catch (e) { /* la tabla puede no existir en este ambiente */ }
    }
    renombres.push({ id_dealer: d.id_dealer, numero: d.numero, antes, despues, copias });
  }

  /* ── 3. dealer_fichas: empresa, personas y socios ──────────────────────── */
  let fichas = [];
  try {
    [fichas] = await pool.query('SELECT id, nombre_razon, nombre_fantasia, nombre_parque, rl_nombre, cc_nombre, cf_nombre, nombre_cuenta, socios FROM dealer_fichas');
  } catch (e) { console.log('  (sin dealer_fichas en este ambiente)'); }
  const sociosNuevos = [];
  for (const f of fichas) {
    for (const c of ['nombre_razon', 'nombre_fantasia', 'nombre_parque']) registrar('dealer_fichas', c, f.id, f[c], NOM.empresa(f[c]));
    for (const c of ['rl_nombre', 'cc_nombre', 'cf_nombre', 'nombre_cuenta']) registrar('dealer_fichas', c, f.id, f[c], NOM.persona(f[c]));
    let socios = f.socios;
    if (typeof socios === 'string') { try { socios = JSON.parse(socios); } catch { socios = null; } }
    if (Array.isArray(socios) && socios.length) {
      const nuevos = socios.map(x => ({ ...x, nombre: NOM.persona((x && x.nombre) || '') }));
      if (JSON.stringify(nuevos) !== JSON.stringify(socios)) {
        sociosNuevos.push({ id: f.id, antes: JSON.stringify(socios), despues: JSON.stringify(nuevos) });
        registrar('dealer_fichas', 'socios', f.id, socios.map(x => x.nombre).join(' / '), nuevos.map(x => x.nombre).join(' / '));
      }
    }
  }

  /* ── 4. vendedores del dealer (personas) ───────────────────────────────── */
  let vendedores = [];
  try { [vendedores] = await pool.query('SELECT id, nombre FROM vendedores_dealer'); } catch (e) {}
  for (const v of vendedores) registrar('vendedores_dealer', 'nombre', v.id, v.nombre, NOM.persona(v.nombre));

  /* ── Informe ───────────────────────────────────────────────────────────── */
  const porTabla = {};
  cambios.forEach(c => { porTabla[`${c.tabla}.${c.columna}`] = (porTabla[`${c.tabla}.${c.columna}`] || 0) + 1; });
  console.log('\nCAMBIOS DE FORMATO (sin tocar la llave de match):');
  Object.entries(porTabla).forEach(([k, n]) => console.log(`  ${k.padEnd(34)} ${n}`));
  console.log('\n  Ejemplos:');
  cambios.slice(0, 12).forEach(c => console.log(`    ${c.tabla}.${c.columna} #${c.id}: "${c.antes}" → "${c.despues}"`));

  console.log(`\nRENOMBRES DE dealers.nombre_indexa (arrastran sus copias): ${renombres.length}`);
  renombres.slice(0, 15).forEach(r => {
    const cop = Object.entries(r.copias).map(([k, n]) => `${k}=${n}`).join(', ') || 'sin copias';
    console.log(`    N°${r.numero}: "${r.antes}" → "${r.despues}"  [${cop}]`);
  });
  const totalCopias = renombres.reduce((s, r) => s + Object.values(r.copias).reduce((a, b) => a + b, 0), 0);
  console.log(`  Filas de copias a mover: ${totalCopias}`);

  if (!APLICAR) { console.log('\nSimulación: no se escribió nada. Correr con --apply para aplicar.'); process.exit(0); }

  /* ── Aplicar ───────────────────────────────────────────────────────────── */
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const c of cambios.filter(x => x.columna !== 'socios')) {
      respaldo.push(c);
      await conn.query(`UPDATE \`${c.tabla}\` SET \`${c.columna}\` = ? WHERE ${c.tabla === 'dealers' ? 'id_dealer' : 'id'} = ?`, [c.despues, c.id]);
    }
    for (const s of sociosNuevos) {
      respaldo.push({ tabla: 'dealer_fichas', columna: 'socios', id: s.id, antes: s.antes, despues: s.despues });
      await conn.query('UPDATE dealer_fichas SET socios = ? WHERE id = ?', [s.despues, s.id]);
    }
    for (const r of renombres) {
      respaldo.push({ tabla: 'dealers', columna: 'nombre_indexa', id: r.id_dealer, antes: r.antes, despues: r.despues, copias: r.copias });
      await conn.query('UPDATE dealers SET nombre_indexa = ? WHERE id_dealer = ?', [r.despues, r.id_dealer]);
      for (const [tabla, col] of COPIAS) {
        try { await conn.query(`UPDATE \`${tabla}\` SET \`${col}\` = ? WHERE \`${col}\` = ?`, [r.despues, r.antes]); } catch (e) {}
      }
    }
    await conn.commit();
    const f = path.join(__dirname, `respaldo-nombres-dealers-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify(respaldo, null, 1), 'utf8');
    console.log(`\n✓ Aplicado. Respaldo en ${f}`);
  } catch (e) {
    await conn.rollback();
    console.error('ROLLBACK:', e.message);
    process.exitCode = 1;
  } finally { conn.release(); }
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
