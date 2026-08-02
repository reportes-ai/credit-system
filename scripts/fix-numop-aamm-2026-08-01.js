/* Renumera las 4 operaciones de agosto de la serie transitoria 89363-89366 al
   formato definitivo AAMM#### (26080001-26080004), actualizando referencias. */
require('dotenv').config();
const pool = require('../shared/config/database');
(async () => {
  const [filas] = await pool.query(
    'SELECT id, num_op, id_financiera FROM creditos WHERE num_op BETWEEN 89363 AND 89366 ORDER BY num_op');
  for (const f of filas) {
    const nuevo = 26080001 + (f.num_op - 89363);
    await pool.query('UPDATE creditos SET num_op=? WHERE id=?', [nuevo, f.id]);
    for (const [t, tipo] of [['postventa_seguimiento','n'], ['cartolas_movimientos','s'], ['fundantes_bitacora','n']]) {
      const val = tipo === 's' ? String(f.num_op) : f.num_op;
      const nv  = tipo === 's' ? String(nuevo) : nuevo;
      const [r] = await pool.query(`UPDATE ${t} SET num_op=? WHERE num_op=?`, [nv, val]).catch(() => [{ affectedRows: 0 }]);
      if (r.affectedRows) console.log(`  ${t}: ${r.affectedRows} fila(s)`);
    }
    console.log(`${f.num_op} → OP ${nuevo} (ID fin. ${f.id_financiera})`);
  }
  process.exit(0);
})();
