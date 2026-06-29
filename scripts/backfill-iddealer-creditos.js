#!/usr/bin/env node
/**
 * backfill-iddealer-creditos.js — Completa creditos.id_dealer para poder re-keyar el match
 * dealer↔crédito de NOMBRE (dealers.nombre_indexa = creditos.automotora) a id_dealer.
 *
 * Regla: "id manda" — NO pisa el id_dealer existente (los conflictos nombre≠id se resuelven
 * a favor del id, que es el rut-consistente). Solo rellena id_dealer donde está vacío y el
 * crédito matchea un dealer por nombre → preserva EXACTO la atribución de hoy (0 perdidos).
 *
 * Tras correrlo, los joins de postventa/órdenes-pago pasan a `d.id_dealer = c.id_dealer`
 * (más robusto que el texto). Backup en bkp_iddealer_creditos. Idempotente.
 *
 * Uso:  node scripts/backfill-iddealer-creditos.js            (dry-run)
 *       node scripts/backfill-iddealer-creditos.js --apply
 */
'use strict';
const pool = require('../shared/config/database');
const APPLY = process.argv.includes('--apply');

// Compara la atribución por NOMBRE vs por ID sobre los seguimientos (el universo que leen
// los joins re-keyados). lost = seguimientos que tenían dealer por nombre y se quedarían sin id.
const VALID = `
  SELECT
    SUM(dn.id_dealer IS NOT NULL AND di.id_dealer IS NULL) lost,
    SUM(dn.id_dealer IS NOT NULL AND di.id_dealer IS NOT NULL AND dn.id_dealer<>di.id_dealer) changed,
    SUM(dn.id_dealer IS NULL AND di.id_dealer IS NOT NULL) gained
  FROM postventa_seguimiento s
  JOIN creditos c ON c.id=s.id_credito
  LEFT JOIN dealers dn ON dn.nombre_indexa=c.automotora AND c.automotora<>''
  LEFT JOIN dealers di ON di.id_dealer=c.id_dealer AND c.id_dealer<>0`;

(async () => {
  try {
    const [[empty]] = await pool.query(`SELECT COUNT(*) n FROM creditos c
      WHERE (c.id_dealer IS NULL OR c.id_dealer=0) AND c.automotora<>''
        AND EXISTS(SELECT 1 FROM dealers d WHERE d.nombre_indexa=c.automotora)`);
    const [[pre]] = await pool.query(VALID);
    console.log(`a rellenar (id vacío + matchea por nombre): ${empty.n} | seguimientos ANTES:`, JSON.stringify(pre));
    if (!empty.n) { console.log('✓ Nada que rellenar (idempotente).'); return; }
    if (!APPLY) { console.log('[DRY-RUN] --apply para ejecutar.'); return; }

    const [[bk]] = await pool.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='bkp_iddealer_creditos'");
    if (bk.n) { console.log('✗ ABORT: bkp_iddealer_creditos ya existe. Borralo para re-correr.'); return; }
    await pool.query('CREATE TABLE bkp_iddealer_creditos (id BIGINT PRIMARY KEY, id_dealer BIGINT)');
    await pool.query('INSERT INTO bkp_iddealer_creditos SELECT id, id_dealer FROM creditos');

    const [r] = await pool.query(`
      UPDATE creditos c
        SET c.id_dealer = (SELECT MIN(d.id_dealer) FROM dealers d WHERE d.nombre_indexa=c.automotora)
        WHERE (c.id_dealer IS NULL OR c.id_dealer=0) AND c.automotora<>''
          AND EXISTS (SELECT 1 FROM dealers d WHERE d.nombre_indexa=c.automotora)`);
    const [[post]] = await pool.query(VALID);
    console.log(`✓ Backfill: ${r.affectedRows} créditos | seguimientos DESPUÉS:`, JSON.stringify(post));
    if (Number(post.lost) > 0) {
      await pool.query('UPDATE creditos c JOIN bkp_iddealer_creditos b ON c.id=b.id SET c.id_dealer=b.id_dealer');
      console.log('✗ HUBO LOST → rollback aplicado.');
    } else {
      console.log(`✓ 0 perdidos. changed=${post.changed} (id manda, rut-consistente), gained=${post.gained}.`);
    }
  } catch (e) { console.error('ERR', e.message); } finally { await pool.end(); }
})();
