/* ─────────────────────────────────────────────────────────────────────────────
   BARRIDO (parte 2) — los 2 pares anulada+aprobada que apuntan al MISMO crédito
   y que reapuntar-cartas-huerfanas-2026-09-07.js dejó fuera a propósito.
   Dos cartas por crédito (ANULADA + APROBADA, VENCIDA + -R1, REEMPLAZADA + -C1)
   es el patrón normal en los datos sanos, así que ambas se re-apuntan.
   Agrega las filas al mismo respaldo. Uso: node scripts/reapuntar-cartas-pares-2026-09-07.js
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const pool = require('../shared/config/database');
(async () => {
  const lista = [
    { carta: 240002, op_carta: '266002380AS', viejo: 750064,  nuevo: 1157693, num_op: 88411 },
    { carta: 270001, op_carta: '266002380BP', viejo: 750064,  nuevo: 1157693, num_op: 88411 },
    { carta: 390002, op_carta: '266060979B',  viejo: 990002,  nuevo: 1157988, num_op: 88712 },
    { carta: 420001, op_carta: '266060979AS', viejo: 1020001, nuevo: 1157988, num_op: 88712 },
  ];
  const f = path.join(__dirname, 'respaldo-cartas-huerfanas-2026-09-07.json');
  const resp = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const r of lista) {
    const [u] = await pool.query(
      `UPDATE cartas_aprobacion SET id_credito_creado=?, numero_credito_creado=COALESCE(numero_credito_creado, ?)
        WHERE id=? AND id_credito_creado=?`, [r.nuevo, String(r.num_op), r.carta, r.viejo]);
    console.log('carta', r.carta, r.op_carta, 'affectedRows', u.affectedRows);
    if (u.affectedRows === 1) resp.push({ ...r, nota: 'par anulada+aprobada, mismo crédito' });
  }
  fs.writeFileSync(f, JSON.stringify(resp, null, 1));
  const [[q]] = await pool.query(`SELECT COUNT(*) n FROM cartas_aprobacion ca LEFT JOIN creditos cr ON cr.id=ca.id_credito_creado WHERE ca.id_credito_creado IS NOT NULL AND cr.id IS NULL`);
  console.log(`huérfanas restantes ${q.n} (esperado 4: 3 de prueba UAT + 1 con RUT distinto) · respaldo filas ${resp.length}`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
