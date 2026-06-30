#!/usr/bin/env node
/**
 * migracion-dealer-comisiones.js — Normaliza las tablas de comisión pactada del dealer a una
 * tabla hija por UBICACIÓN, para soportar que un mismo dealer (identidad única = RUT) tenga
 * varias tablas (calle + parque(s)). Llave de cálculo: (id_dealer, ubicacion).
 *
 *   dealer_comisiones (id_dealer, ubicacion, com_6_12, com_13_24, com_25_36, com_37)
 *     ubicacion = 'CALLE'  ó  el nombre del parque.
 *
 * Migra fielmente lo actual de `dealers`:
 *   - com_*         → fila 'CALLE'
 *   - com_parque_*  → fila con el nombre del parque (ccs_parque)
 * El motor seguirá leyendo de `dealers` hasta que se cablee la capa 2 (esto es solo el store).
 * Idempotente. Uso:  node scripts/migracion-dealer-comisiones.js [--apply]
 */
'use strict';
const pool = require('../shared/config/database');
const APPLY = process.argv.includes('--apply');
const T = ['6_12', '13_24', '25_36', '37'];

(async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS dealer_comisiones (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      id_dealer BIGINT NOT NULL,
      ubicacion VARCHAR(150) NOT NULL,
      com_6_12 DECIMAL(5,2) NULL, com_13_24 DECIMAL(5,2) NULL,
      com_25_36 DECIMAL(5,2) NULL, com_37 DECIMAL(5,2) NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_dealer_ubic (id_dealer, ubicacion),
      KEY idx_id_dealer (id_dealer)
    )`);
    console.log('✓ Tabla dealer_comisiones lista');

    // Fuente: dealers con tabla CALLE (com_*) y/o PARQUE (com_parque_*)
    const [calle] = await pool.query(
      `SELECT id_dealer, com_6_12, com_13_24, com_25_36, com_37 FROM dealers
        WHERE com_6_12 IS NOT NULL OR com_13_24 IS NOT NULL OR com_25_36 IS NOT NULL OR com_37 IS NOT NULL`);
    const [parque] = await pool.query(
      `SELECT id_dealer, ccs_parque, com_parque_6_12, com_parque_13_24, com_parque_25_36, com_parque_37 FROM dealers
        WHERE com_parque_6_12 IS NOT NULL OR com_parque_13_24 IS NOT NULL OR com_parque_25_36 IS NOT NULL OR com_parque_37 IS NOT NULL`);
    console.log(`Origen: ${calle.length} dealers con tabla CALLE, ${parque.length} con tabla PARQUE`);

    if (!APPLY) { console.log('\n[DRY-RUN] --apply para poblar.'); return; }

    let n = 0;
    for (const d of calle) {
      await pool.query(
        `INSERT INTO dealer_comisiones (id_dealer, ubicacion, com_6_12, com_13_24, com_25_36, com_37)
         VALUES (?, 'CALLE', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE com_6_12=VALUES(com_6_12), com_13_24=VALUES(com_13_24), com_25_36=VALUES(com_25_36), com_37=VALUES(com_37)`,
        [d.id_dealer, d.com_6_12, d.com_13_24, d.com_25_36, d.com_37]); n++;
    }
    for (const d of parque) {
      const ubic = (d.ccs_parque || '').trim() || 'PARQUE';
      await pool.query(
        `INSERT INTO dealer_comisiones (id_dealer, ubicacion, com_6_12, com_13_24, com_25_36, com_37)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE com_6_12=VALUES(com_6_12), com_13_24=VALUES(com_13_24), com_25_36=VALUES(com_25_36), com_37=VALUES(com_37)`,
        [d.id_dealer, ubic, d.com_parque_6_12, d.com_parque_13_24, d.com_parque_25_36, d.com_parque_37]); n++;
    }
    console.log(`✓ ${n} filas migradas`);

    // Golden master: cada fila reproduce la columna origen
    let bad = 0;
    const [rows] = await pool.query('SELECT dc.*, d.com_6_12 c1,d.com_13_24 c2,d.com_25_36 c3,d.com_37 c4, d.com_parque_6_12 p1,d.com_parque_13_24 p2,d.com_parque_25_36 p3,d.com_parque_37 p4 FROM dealer_comisiones dc JOIN dealers d ON d.id_dealer=dc.id_dealer');
    for (const r of rows) {
      const src = r.ubicacion === 'CALLE' ? [r.c1, r.c2, r.c3, r.c4] : [r.p1, r.p2, r.p3, r.p4];
      const got = [r.com_6_12, r.com_13_24, r.com_25_36, r.com_37];
      if (String(src) !== String(got)) { bad++; console.log(`✗ id=${r.id_dealer} ${r.ubicacion}: src=${src} got=${got}`); }
    }
    console.log(bad === 0 ? `✓ GOLDEN MASTER OK: ${rows.length} filas idénticas al origen` : `✗ ${bad} discrepancias`);
  } catch (e) { console.error('ERR', e.message); } finally { await pool.end(); }
})();
