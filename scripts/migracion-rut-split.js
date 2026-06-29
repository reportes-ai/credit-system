#!/usr/bin/env node
/**
 * migracion-rut-split.js — Split del RUT en cuerpo + DV (columnas GENERADAS VIRTUAL).
 *
 * En las tablas MAESTRAS (donde el RUT es identidad) agrega, derivadas de la columna RUT
 * canónica y robustas a cualquier formato:
 *   - `<col>_cuerpo` BIGINT (VIRTUAL, INDEXADO) → la llave entera limpia (para joins/lookups)
 *   - `<col>_dv`     CHAR(1) (VIRTUAL)          → el dígito verificador en su propio campo
 *
 * Una sola fuente de verdad: el `rut` canónico (ver rut-core.js). El cuerpo/DV NO se pueden
 * desincronizar — los calcula la BD. Idempotente: re-correr es seguro.
 *
 * Uso:  node scripts/migracion-rut-split.js          (verifica/aplica)
 *       node scripts/migracion-rut-split.js --check   (solo verifica, no altera)
 */
'use strict';
const pool = require('../shared/config/database');
const R = require('../api-gateway/public/js/rut-core');
const CHECK_ONLY = process.argv.includes('--check');

// (tabla, columna_rut) maestras donde el RUT es identidad.
const COLS = [
  ['clientes', 'rut'],
  ['dealers', 'rut'], ['dealers', 'rut_pago'],
  ['proveedores', 'rut'],
  ['usuarios', 'rut'],
  ['dealer_fichas', 'rut'], ['dealer_fichas', 'rut_cuenta'],
];

const clean = col => `UPPER(REPLACE(REPLACE(REPLACE(\`${col}\`,'.',''),'-',''),' ',''))`;
const cuerpoExpr = col => `CASE WHEN ${clean(col)} REGEXP '^[0-9]+[0-9Kk]$' AND CHAR_LENGTH(${clean(col)})>=2 THEN CAST(LEFT(${clean(col)}, CHAR_LENGTH(${clean(col)})-1) AS UNSIGNED) ELSE NULL END`;
const dvExpr = col => `CASE WHEN ${clean(col)} REGEXP '^[0-9]+[0-9Kk]$' AND CHAR_LENGTH(${clean(col)})>=2 THEN RIGHT(${clean(col)},1) ELSE NULL END`;

const colExists = async (t, c) => {
  const [[r]] = await pool.query(
    'SELECT COUNT(*) n FROM information_schema.columns WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', [t, c]);
  return r.n > 0;
};

(async () => {
  try {
    for (const [t, c] of COLS) {
      const cuerpo = `${c}_cuerpo`, dv = `${c}_dv`;
      if (await colExists(t, cuerpo)) { console.log(`= ${t}.${cuerpo} ya existe`); continue; }
      if (CHECK_ONLY) { console.log(`~ ${t}.${cuerpo} FALTA (se agregaría)`); continue; }
      await pool.query(`ALTER TABLE \`${t}\` ADD COLUMN \`${cuerpo}\` BIGINT AS (${cuerpoExpr(c)}) VIRTUAL`);
      await pool.query(`ALTER TABLE \`${t}\` ADD COLUMN \`${dv}\` CHAR(1) AS (${dvExpr(c)}) VIRTUAL`);
      await pool.query(`ALTER TABLE \`${t}\` ADD INDEX \`idx_${cuerpo}\` (\`${cuerpo}\`)`);
      console.log(`✓ ${t}: +${cuerpo} (idx) +${dv}`);
    }

    console.log('\n── Verificación + calidad de DV ──');
    for (const [t, c] of COLS) {
      const cuerpo = `${c}_cuerpo`, dv = `${c}_dv`;
      if (!await colExists(t, cuerpo)) { console.log(`${t}.${c}: (sin columnas aún)`); continue; }
      const [[s]] = await pool.query(`SELECT
          SUM(\`${c}\` IS NOT NULL AND \`${c}\`<>'') con_rut,
          SUM(\`${cuerpo}\` IS NOT NULL) con_cuerpo,
          SUM(\`${c}\` IS NOT NULL AND \`${c}\`<>'' AND \`${cuerpo}\` IS NULL) rut_sin_cuerpo
        FROM \`${t}\``);
      const [rows] = await pool.query(`SELECT \`${cuerpo}\` cuerpo, \`${dv}\` dv FROM \`${t}\` WHERE \`${cuerpo}\` IS NOT NULL`);
      let dvMal = 0; const ej = [];
      for (const r of rows) if (R.calcDV(String(r.cuerpo)) !== r.dv) { dvMal++; if (ej.length < 3) ej.push(`${r.cuerpo}-${r.dv}`); }
      console.log(`${t}.${c}: con_rut=${s.con_rut} con_cuerpo=${s.con_cuerpo} rut_sin_cuerpo=${s.rut_sin_cuerpo} | DV_invalidos=${dvMal}${ej.length ? ' ej:' + ej.join(',') : ''}`);
    }
  } catch (e) { console.error('ERR', e.message); } finally { await pool.end(); }
})();
