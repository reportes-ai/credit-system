'use strict';
/* Auditoría 03-08-2026 (A-9) — tercera pasada: `fin_fix_backup_2026_06`.
 *
 * Es el respaldo de reversa de la migración one-time `fix-financieras` (jun-2026,
 * flag `fin_fix_2026_06` en data_migraciones): guardó financiera/estado/automotora
 * previos de 4.840 operaciones. La migración está aplicada y validada hace dos
 * meses, y su tabla NO la caza el barrido por prefijo `bkp_`/`tmp_` — exactamente
 * el hueco que describe A-9: 9.680 filas de datos comerciales fuera de todo
 * control de acceso de la aplicación.
 *
 * Antes de borrar, exporta a disco (JSON + SQL con INSERTs) igual que el barrido
 * anterior. Si la exportación no queda completa, ABORTA sin borrar.
 *
 * REGLA QUE SE ADOPTA (para que esto no se repita): toda tabla de respaldo nace
 * con prefijo `bkp_` y fecha en el nombre, así un barrido por patrón la encuentra
 * siempre. La migración fix-financieras quedó con el nombre viejo por historia.
 *
 * Uso:  node scripts/borrar-fin-fix-backup-2026-08-04.js            (simulación)
 *       node scripts/borrar-fin-fix-backup-2026-08-04.js --ejecutar (aplica)
 */
const pool = require('../shared/config/database');
const fs   = require('fs');
const path = require('path');

const EJECUTAR = process.argv.includes('--ejecutar');
const TABLA    = 'fin_fix_backup_2026_06';
const DESTINO  = 'C:\\Users\\patri\\Documents\\respaldos-bd\\bkp-tablas-2026-08-03';

const esc = v => v === null || v === undefined ? 'NULL'
  : (v instanceof Date ? `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`
  : (typeof v === 'number' ? String(v) : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`));

(async () => {
  const [[existe]] = await pool.query(
    `SELECT COUNT(*) n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`, [TABLA]);
  if (!existe.n) { console.log(`La tabla ${TABLA} ya no existe. Nada que hacer.`); process.exit(0); }

  const [filas] = await pool.query(`SELECT * FROM \`${TABLA}\``);
  const [[ddl]] = await pool.query(`SHOW CREATE TABLE \`${TABLA}\``);
  console.log(`${TABLA}: ${filas.length.toLocaleString('es-CL')} filas`);

  if (!fs.existsSync(DESTINO)) fs.mkdirSync(DESTINO, { recursive: true });
  const fJson = path.join(DESTINO, `${TABLA}.json`);
  const fSql  = path.join(DESTINO, `${TABLA}.sql`);
  fs.writeFileSync(fJson, JSON.stringify(filas, null, 1), 'utf8');

  const cols = filas.length ? Object.keys(filas[0]) : [];
  const inserts = filas.map(r => `INSERT INTO \`${TABLA}\` (${cols.map(c => '`' + c + '`').join(',')}) VALUES (${cols.map(c => esc(r[c])).join(',')});`);
  fs.writeFileSync(fSql, `${ddl['Create Table']};\n\n${inserts.join('\n')}\n`, 'utf8');

  // Verificación: el JSON debe releerse con la misma cantidad de filas
  const releido = JSON.parse(fs.readFileSync(fJson, 'utf8'));
  if (releido.length !== filas.length) {
    console.log('✗ ABORTA: el respaldo en disco no coincide con la tabla. No se borra nada.');
    process.exit(1);
  }
  console.log(`✓ Respaldada en ${fJson}\n✓ Respaldada en ${fSql}`);

  if (!EJECUTAR) { console.log('\n[SIMULACIÓN] Nada se borró. Corre con --ejecutar para aplicar.\n'); process.exit(0); }

  await pool.query(`DROP TABLE \`${TABLA}\``);
  console.log(`✓ Eliminada ${TABLA} (${filas.length.toLocaleString('es-CL')} filas).`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
