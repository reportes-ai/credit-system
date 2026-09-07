/* ─────────────────────────────────────────────────────────────────────────────
   BARRIDO — cartas_aprobacion.id_credito_creado huérfano (07-09-2026)

   382 de 600 cartas apuntaban a ids de `creditos` anteriores a la re-migración
   de la tabla. Efecto: el envío de cartola no encontraba el seguimiento de Post
   Venta y la op nunca recibía CARTOLA ENVIADA (ops 5381115/5714593/5738833).

   Patrón (descubre): carta huérfana → crédito por id_financiera (financiera ≠
   NO APLICA), único candidato y RUT del cliente igual. Ejecuta SOLO la lista
   verificada en el JSON del barrido en seco (cambio por lista explícita).
   Respaldo: respaldo-cartas-huerfanas-2026-09-07.json (carta, viejo, nuevo).
   Uso: node scripts/reapuntar-cartas-huerfanas-2026-09-07.js <barrido.json>
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const pool = require('../shared/config/database');
(async () => {
  const out = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const cnt = {}; out.unico.forEach(r => cnt[r.cands[0].id] = (cnt[r.cands[0].id] || 0) + 1);
  const repetidos = out.unico.filter(r => cnt[r.cands[0].id] > 1);
  console.log('DESTINOS REPETIDOS (no se tocan, decidir a mano):');
  console.table(repetidos.map(r => ({ carta: r.carta, op: r.op_carta, status: r.status, viejo: r.viejo, nuevo: r.cands[0].id, num_op: r.cands[0].num_op })));
  const lista = out.unico.filter(r => cnt[r.cands[0].id] === 1);
  const respaldo = []; let ok = 0, sinEfecto = 0;
  for (const r of lista) {
    const nuevo = r.cands[0].id;
    const [u] = await pool.query(
      `UPDATE cartas_aprobacion SET id_credito_creado=?, numero_credito_creado=COALESCE(numero_credito_creado, ?)
        WHERE id=? AND id_credito_creado=?`, [nuevo, String(r.cands[0].num_op), r.carta, r.viejo]);
    if (u.affectedRows === 1) { ok++; respaldo.push({ carta: r.carta, op_carta: r.op_carta, viejo: r.viejo, nuevo, num_op: r.cands[0].num_op }); }
    else { sinEfecto++; console.log('SIN EFECTO carta', r.carta, r.op_carta); }
  }
  fs.writeFileSync(path.join(__dirname, 'respaldo-cartas-huerfanas-2026-09-07.json'), JSON.stringify(respaldo, null, 1));
  const [[q]] = await pool.query(`SELECT COUNT(*) n FROM cartas_aprobacion ca LEFT JOIN creditos cr ON cr.id=ca.id_credito_creado WHERE ca.id_credito_creado IS NOT NULL AND cr.id IS NULL`);
  console.log(`re-apuntadas ${ok} · sin efecto ${sinEfecto} · huérfanas restantes ${q.n}`);
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
