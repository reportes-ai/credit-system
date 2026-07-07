'use strict';
/* Etapa 4 CARTERA AFA — fecha de otorgamiento = FAPERTURA de la cartera valorizada
   (2026.06 CartVig_val.xlsx, hoja PESOS). Solo completa creditos.fecha_otorgado
   (y mes) donde esté NULL, en las 216 ops AFA. Sin ops nuevas.
   Uso: node scripts/cargar-fapertura-afa.js [--aplicar] */

const XLSX = require('xlsx');
const pool = require('../shared/config/database');

const ARCHIVO = 'C:/Users/patri/Downloads/2026.06 CartVig_val.xlsx';
const APLICAR = process.argv.includes('--aplicar');
const fx = s => (typeof s === 'number' && Number.isFinite(s))
  ? new Date((s - 25569) * 86400000).toISOString().slice(0, 10) : null;

(async () => {
  console.log(APLICAR ? '=== APLICANDO ===' : '=== SIMULACIÓN (usa --aplicar para escribir) ===');
  const wb = XLSX.readFile(ARCHIVO);
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets['PESOS'], { header: 1 });
  const hi = aoa.findIndex(r => r && r[0] === 'OP');
  const byOp = new Map();
  for (const r of aoa.slice(hi + 1)) {
    if (typeof r?.[0] !== 'number') continue;
    const f = fx(r[5]);                        // FAPERTURA
    if (f && !byOp.has(r[0])) byOp.set(r[0], f);
  }
  console.log('Ops con FAPERTURA en el Excel:', byOp.size);

  const [creds] = await pool.query(
    "SELECT id, num_op, fecha_otorgado FROM creditos WHERE origen='CARTERA_AFA'");
  let upd = 0, sinFecha = 0, yaTenia = 0;
  for (const c of creds) {
    const f = byOp.get(c.num_op);
    if (!f) { sinFecha++; continue; }
    if (c.fecha_otorgado) { yaTenia++; continue; }
    if (APLICAR) await pool.query(
      "UPDATE creditos SET fecha_otorgado=?, mes=DATE_FORMAT(?, '%Y-%m') WHERE id=?", [f, f, c.id]);
    upd++;
  }
  console.log(`AFA: ${creds.length} | ${APLICAR ? 'actualizadas' : 'a actualizar'}: ${upd} | ya tenían fecha: ${yaTenia} | sin FAPERTURA en Excel: ${sinFecha}`);
  if (sinFecha) {
    const ops = creds.filter(c => !byOp.get(c.num_op)).map(c => c.num_op);
    console.log('  sin fecha:', ops.join(', '));
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
