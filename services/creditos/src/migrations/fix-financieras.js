'use strict';
/**
 * Migración de datos ONE-TIME (jun-2026).
 * Sincroniza financiera / estado_credito / automotora de las operaciones con el
 * archivo "FINANCIERAS POR CREDITO.xlsx" (fuente de verdad provista por negocio).
 * Solo se actualizan los campos que DIFIEREN (4.840 ops: 185 financiera, 4.778
 * estado, 40 automotora). NO toca ejecutivo (el Excel usa otro formato de nombre).
 *
 * - Corre una sola vez (guard en data_migraciones); idempotente entre deploys.
 * - Match por num_op (único).
 * - RESPALDO: antes de actualizar guarda el estado previo de las ops afectadas en
 *   fin_fix_backup_2026_06 (reversible).
 * - Al cambiar la financiera, dispara el recálculo de los meses ABIERTOS (los
 *   cerrados se omiten, como siempre) para que la comisión refleje la institución.
 */
const fs   = require('fs');
const path = require('path');
const pool = require('../../../../shared/config/database');

const FLAG = 'fin_fix_2026_06';

require('../../../../shared/migrate').enFila('fix-financieras', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS data_migraciones (
      clave VARCHAR(60) PRIMARY KEY, detalle VARCHAR(255), applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    const [[ya]] = await pool.query('SELECT 1 ok FROM data_migraciones WHERE clave=? LIMIT 1', [FLAG]);
    if (ya) return;   // ya aplicada

    let changes;
    try { changes = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/fin-fix-2026-06.json'), 'utf8')); }
    catch (e) { console.error('[fin-fix] no se pudo leer el JSON:', e.message); return; }
    if (!Array.isArray(changes) || !changes.length) return;
    const ops = [...new Set(changes.map(c => c && c.op).filter(Boolean).map(String))];

    // ── Respaldo del estado previo de las ops afectadas (reversible) ──────────
    await pool.query(`CREATE TABLE IF NOT EXISTS fin_fix_backup_2026_06 (
      num_op VARCHAR(40), financiera VARCHAR(80), estado_credito VARCHAR(40), automotora VARCHAR(250),
      saved_at DATETIME DEFAULT CURRENT_TIMESTAMP, INDEX idx_op (num_op))`);
    for (let i = 0; i < ops.length; i += 1000) {
      const chunk = ops.slice(i, i + 1000);
      await pool.query(
        `INSERT INTO fin_fix_backup_2026_06 (num_op, financiera, estado_credito, automotora)
           SELECT num_op, financiera, estado_credito, automotora FROM creditos WHERE num_op IN (?)`, [chunk]);
    }

    // ── Aplicar los cambios (solo los campos presentes en cada entrada) ───────
    let nf = 0, ne = 0, na = 0, filas = 0, financieraTocada = false;
    for (const c of changes) {
      if (!c || !c.op) continue;
      const sets = [], vals = [];
      if (c.f) { sets.push('financiera=?');     vals.push(c.f); nf++; financieraTocada = true; }
      if (c.e) { sets.push('estado_credito=?'); vals.push(c.e); ne++; }
      if (c.a) { sets.push('automotora=?');     vals.push(c.a); na++; }
      if (!sets.length) continue;
      try {
        const [r] = await pool.query(`UPDATE creditos SET ${sets.join(',')} WHERE num_op=?`, [...vals, String(c.op)]);
        filas += r.affectedRows || 0;
      } catch (e) { /* op puntual sin fila → continuar */ }
    }
    await pool.query('INSERT IGNORE INTO data_migraciones (clave, detalle) VALUES (?,?)',
      [FLAG, `financiera:${nf} estado:${ne} automotora:${na} filas:${filas} ops:${ops.length}`]);
    console.log(`[fin-fix] aplicado — financiera:${nf} estado:${ne} automotora:${na} (filas:${filas}, respaldadas:${ops.length})`);

    // La financiera cambia la fórmula de comisión → recalcula meses ABIERTOS (los cerrados se omiten).
    if (financieraTocada) {
      try {
        const { recalcularMesesAbiertos } = require('../utils/recalcular-mes');
        recalcularMesesAbiertos()
          .then(x => { if (x && x.actualizados != null) console.log('[fin-fix] recalc meses abiertos — ops:', x.actualizados); })
          .catch(e => console.error('[fin-fix recalc]', e.message));
      } catch (e) { console.error('[fin-fix recalc require]', e.message); }
    }
  } catch (e) { console.error('[fin-fix migration]', e.message); }
});
