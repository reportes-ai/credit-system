require('dotenv').config();
const pool = require('../shared/config/database');
const { recalcularMeses } = require('../services/creditos/src/utils/recalcular-mes');
(async () => {
  // Meses de las ops saneadas + el actual; los cerrados se saltan solos.
  const meses = ['2025-01','2025-02','2025-03','2025-04','2025-06','2025-07','2025-12','2026-01','2026-02','2026-04','2026-05','2026-07','2026-08'];
  const r = await recalcularMeses(meses);
  console.log('actualizados:', r.actualizados);
  (r.log || []).slice(-8).forEach(l => console.log(' ', l));
  const [[ruth]] = await pool.query('SELECT num_op, monto_comision_fin, ingreso_neto_total FROM creditos WHERE num_op=2607063');
  console.log('RUTH 2607063: colocacion', Number(ruth.monto_comision_fin), '| neto', Number(ruth.ingreso_neto_total));
  process.exit(0);
})();
