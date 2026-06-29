#!/usr/bin/env node
/**
 * limpiar-nombre-dealer.js — Homologa el nombre del dealer SIN el prefijo del parque.
 *
 * `dealers.nombre_indexa` solía guardarse como "PARQUE X <NOMBRE>" (redundante: el parque
 * ya vive en ccs_parque). Esto lo dejaba sucio en TODOS los consumidores que leen el crudo
 * (carta de aprobación, digitación, cotizador…). Acá se le saca el prefijo del parque.
 *
 * Cuidado (máxima #1): el match dealer↔crédito es por NOMBRE — `dealers.nombre_indexa =
 * creditos.automotora` (postventa, órdenes de pago). Por eso se limpian las DOS puntas con el
 * MISMO mapeo (old→new): así el join queda intacto. Se verifica que la atribución no se pierda
 * (rollback automático si algún crédito perdiera su dealer). Backup en bkp_dealnom_*.
 *
 * Idempotente: solo actúa sobre filas que aún empiezan con "PARQUE ". Re-correr es no-op.
 * Uso:  node scripts/limpiar-nombre-dealer.js            (dry-run)
 *       node scripts/limpiar-nombre-dealer.js --apply
 */
'use strict';
const pool = require('../shared/config/database');
const APPLY = process.argv.includes('--apply');

// Saca el prefijo de parque más largo que matchee (de la lista de parques conocidos).
function stripParque(name, parques) {
  const u = String(name || '').toUpperCase();
  let best = '';
  for (const p of parques) { const pu = p.toUpperCase(); if (pu && u.startsWith(pu) && pu.length > best.length) best = pu; }
  if (!best) return String(name || '').trim();
  const s = String(name).slice(best.length).replace(/^[\s\-–—_.,·|:]+/, '').trim();
  return s || String(name).trim();   // si quedara vacío, conserva el completo
}
const pairSet = rows => new Set(rows.map(r => r.cid + '>' + r.did));
const BASE_SQL = `SELECT c.id cid, d.id_dealer did FROM creditos c JOIN dealers d ON d.nombre_indexa = c.automotora WHERE c.automotora IS NOT NULL AND c.automotora<>''`;

(async () => {
  try {
    const [pq] = await pool.query("SELECT DISTINCT ccs_parque p FROM dealers WHERE ccs_parque LIKE 'PARQUE %'");
    const parques = pq.map(r => r.p.trim());
    const [dealers] = await pool.query("SELECT id_dealer, nombre_indexa FROM dealers WHERE nombre_indexa LIKE 'PARQUE %'");
    const oldToNew = new Map(); const changed = []; let collisions = 0;
    for (const d of dealers) {
      const o = d.nombre_indexa.trim(), n = stripParque(o, parques);
      if (n === o) continue;
      if (oldToNew.has(o) && oldToNew.get(o) !== n) collisions++;
      oldToNew.set(o, n); changed.push({ id: d.id_dealer, o, n });
    }
    if (collisions) { console.log('✗ ABORT: colisiones old→2new =', collisions); return; }
    const remap = [...oldToNew.entries()];
    const [base] = await pool.query(BASE_SQL); const B = pairSet(base);
    console.log(`dealers sucios: ${dealers.length} | a limpiar: ${changed.length} | remaps automotora: ${remap.length} | baseline pares: ${B.size}`);
    if (!changed.length) { console.log('✓ Nada que limpiar (idempotente).'); return; }
    if (!APPLY) { console.log('[DRY-RUN] --apply para ejecutar.'); console.log('  ej:', JSON.stringify(changed.slice(0, 3))); return; }

    const [[bk]] = await pool.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='bkp_dealnom_dealers'");
    if (bk.n) { console.log('✗ ABORT: bkp_dealnom_dealers ya existe. Borra los bkp_dealnom_* para re-correr.'); return; }
    await pool.query('CREATE TABLE bkp_dealnom_dealers (id_dealer BIGINT PRIMARY KEY, nombre_indexa VARCHAR(250))');
    await pool.query('INSERT INTO bkp_dealnom_dealers SELECT id_dealer, nombre_indexa FROM dealers');
    await pool.query('CREATE TABLE bkp_dealnom_creditos (id BIGINT PRIMARY KEY, automotora VARCHAR(250))');
    await pool.query("INSERT INTO bkp_dealnom_creditos SELECT id, automotora FROM creditos WHERE automotora IS NOT NULL AND automotora<>''");

    for (const c of changed) await pool.query('UPDATE dealers SET nombre_indexa=? WHERE id_dealer=?', [c.n, c.id]);
    let filasC = 0;
    for (const [o, n] of remap) { const [r] = await pool.query('UPDATE creditos SET automotora=? WHERE automotora=?', [n, o]); filasC += r.affectedRows; }
    console.log(`✓ Aplicado: ${changed.length} dealers, ${filasC} créditos remapeados`);

    const [after] = await pool.query(BASE_SQL); const A = pairSet(after);
    const lost = [...B].filter(x => !A.has(x)), gained = [...A].filter(x => !B.has(x));
    console.log(`Verificación: ${B.size} → ${A.size} | LOST ${lost.length} | GAINED ${gained.length}`);
    if (lost.length) {
      console.log('✗ SE PERDIÓ ATRIBUCIÓN → ROLLBACK', lost.slice(0, 5));
      await pool.query('UPDATE dealers d JOIN bkp_dealnom_dealers b ON d.id_dealer=b.id_dealer SET d.nombre_indexa=b.nombre_indexa');
      await pool.query('UPDATE creditos c JOIN bkp_dealnom_creditos b ON c.id=b.id SET c.automotora=b.automotora');
      console.log('✓ Rollback aplicado.');
    } else {
      console.log(`✓ 0 perdidos${gained.length ? ', ' + gained.length + ' ganado(s) correctos: ' + JSON.stringify(gained) : ''}.`);
    }
  } catch (e) { console.error('ERR', e.message); } finally { await pool.end(); }
})();
