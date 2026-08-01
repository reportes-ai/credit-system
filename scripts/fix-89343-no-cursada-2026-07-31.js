/* ─────────────────────────────────────────────────────────────────────────────
   REVERSA — OP 89343 (AUTEN, idfin 6176412) vuelve a APROBADO

   La carta 266176412DI se otorgó el 23-07, pero el export de AutoFin
   (TRISolicitudWWExport-4651, cursadas de julio) NO la incluye y su
   estado_autofin dice "Aprobada": la operación NO está cursada. El export
   manda (regla Cuadratura Trinidad). El otorgamiento fue prematuro y por él
   nuestro julio AUTOFIN daba 62 con uno de más.

   Esto también explica sus columnas partidas de esta mañana: la carta escribía
   OTORGADO y la sincronización de Trinidad la devolvía a APROBADO — Trinidad
   tenía razón. La alineación de hoy (fix-etapas-89343) siguió la pista
   equivocada; esta la corrige con la evidencia completa.

   Hace: etapa APROBADO en las TRES columnas (motor único) + carta de vuelta a
   no-otorgada + retiro de la comisión en cartola si no se envió + fecha_otorgado
   a NULL (la puso el otorgamiento prematuro, no AutoFin).
   Cuando AutoFin la curse de verdad, el flujo normal la otorga de nuevo.

   Respaldo: scripts/respaldo-89343-no-cursada-2026-07-31.json
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const pool = require('../shared/config/database');
const { setEtapa } = require('../shared/etapa-credito');
(async () => {
  const [[c]] = await pool.query("SELECT * FROM creditos WHERE num_op=89343");
  const [[ca]] = await pool.query("SELECT * FROM cartas_aprobacion WHERE id_financiera='6176412'");
  const [cm] = await pool.query("SELECT * FROM cartolas_movimientos WHERE id_carta=? OR num_op IN ('89343','6176412')", [ca.id]);
  fs.writeFileSync(path.join(__dirname, 'respaldo-89343-no-cursada-2026-07-31.json'),
    JSON.stringify({ credito: c, carta: ca, cartola: cm }, null, 2));

  await setEtapa(c.id, 'APROBADO', { extraSets: ['fecha_otorgado = NULL'], extraVals: [] });
  await pool.query("UPDATE cartas_aprobacion SET otorgado=0, fecha_otorgado=NULL WHERE id=?", [ca.id]);
  const noEnviados = cm.filter(m => m.mes_cartola == null);
  if (noEnviados.length) {
    await pool.query('DELETE FROM cartolas_movimientos WHERE id IN (?)', [noEnviados.map(m => m.id)]);
    console.log('Comisión retirada de cartola:', noEnviados.length, 'movimiento(s)');
  } else console.log('Cartola: sin movimientos que retirar', cm.length ? '(ya enviados: ' + cm.length + ' — revisar a mano)' : '');

  const [[d]] = await pool.query('SELECT estado, estado_credito, estado_eval, fecha_otorgado FROM creditos WHERE id=?', [c.id]);
  console.log('DESPUÉS:', d.estado, '/', d.estado_credito, '/', d.estado_eval, '| f_otorg:', d.fecha_otorgado);
  const [[n]] = await pool.query(`
    SELECT COUNT(*) n FROM creditos WHERE financiera='AUTOFIN' AND estado_credito='OTORGADO'
      AND DATE_FORMAT(fecha_otorgado,'%Y-%m')='2026-07'`);
  console.log('AUTOFIN julio otorgados ahora:', n.n, '(AutoFin dice 62; falta otorgar la 6189286 para calzar)');
  process.exit(0);
})();
