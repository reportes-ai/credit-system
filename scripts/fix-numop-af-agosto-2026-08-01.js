/* Renumera las solicitudes que alcanzaron a entrar en AGOSTO con el ID de
   Trinidad como num_op (la regla "toda operación nace con número nuestro"
   se activó hoy). Solo filas creadas desde el 01-08 y sin referencias aguas
   abajo (recién nacidas). Julio hacia atrás NO se toca: cerró con sus números. */
require('dotenv').config();
const pool = require('../shared/config/database');
const { siguienteNumOpAF } = require('../shared/num-op');
(async () => {
  const [filas] = await pool.query(`
    SELECT id, num_op, id_financiera, estado_credito FROM creditos
     WHERE num_op >= 1000000 AND created_at >= '2026-08-01' ORDER BY id`);
  console.log('A renumerar:', filas.length);
  for (const f of filas) {
    const nuevo = await siguienteNumOpAF();
    await pool.query('UPDATE creditos SET num_op=? WHERE id=? AND num_op>=1000000', [nuevo, f.id]);
    console.log(`  ${f.num_op} → OP ${nuevo} (ID fin. ${f.id_financiera}, ${f.estado_credito})`);
  }
  process.exit(0);
})();
