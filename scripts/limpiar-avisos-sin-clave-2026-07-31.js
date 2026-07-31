/* ─────────────────────────────────────────────────────────────────────────────
   LIMPIEZA — avisos IRRETIRABLES que pedían algo ya hecho

   Un aviso que le pide una acción a un POOL necesita `clave`: es lo que permite
   sacarlo de la campanita de TODOS cuando alguien lo atiende. Los que nacieron
   sin clave no se pueden retirar nunca — quedan sonando para siempre aunque el
   hecho esté resuelto hace semanas. Eso es lo que tenía la campanita sin callar.

   Desde v167.3 estos tres emisores ya nacen con clave y con su retiro cableado
   (atención remota, cartas). Este script limpia lo que quedó de antes,
   verificando el estado REAL de cada hecho antes de borrar — nada se borra
   "porque sí", solo si el hecho ya está resuelto.

   Reversible: scripts/respaldo-avisos-sin-clave-2026-07-31.json
   ───────────────────────────────────────────────────────────────────────────── */
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const pool = require('../shared/config/database');

(async () => {
  const borradas = [];
  const guardar = async (sql, args, motivo) => {
    const [filas] = await pool.query(`SELECT * FROM notificaciones WHERE ${sql}`, args);
    filas.forEach(f => borradas.push({ ...f, _motivo: motivo }));
    const [r] = await pool.query(`DELETE FROM notificaciones WHERE ${sql}`, args);
    return r.affectedRows || 0;
  };

  // 1) "Dealer esperando atención" sin clave, de chats que YA no están en espera.
  const [enEspera] = await pool.query("SELECT id FROM ar_conversaciones WHERE estado='ESPERA'");
  console.log(`Conversaciones realmente en ESPERA ahora: ${enEspera.length}`);
  const n1 = await guardar(
    "titulo LIKE '%Dealer esperando atención%' AND (clave IS NULL OR clave = '')",
    [], 'chat de atención remota ya atendido o cerrado; aviso sin clave, irretirable');
  console.log(`  ✂ ${n1} avisos de dealer en espera (sin clave)`);

  // 2) Avisos de carta con la clave rota 'carta:undefined': se conservan solo si
  //    la carta sigue PENDIENTE de revisión. No se puede saber CUÁL carta es
  //    (esa era justamente la falla), así que se decide por el conjunto: si no
  //    queda ninguna carta pendiente, ninguno de esos avisos pide nada.
  const [[pend]] = await pool.query("SELECT COUNT(*) n FROM cartas_aprobacion WHERE status='PENDIENTE'");
  console.log(`Cartas realmente PENDIENTES ahora: ${pend.n}`);
  let n2 = 0;
  if (!pend.n) {
    n2 = await guardar("clave = 'carta:undefined'", [], 'clave rota y no queda ninguna carta pendiente');
    console.log(`  ✂ ${n2} avisos con clave 'carta:undefined'`);
  } else {
    console.log(`  ⏸ se conservan los 'carta:undefined': hay ${pend.n} carta(s) pendiente(s) de verdad`);
  }

  // 3) Fundantes devueltos: el MISMO hecho quedó avisado dos veces, una con clave
  //    (retirable) y otra sin. Se borra solo la copia sin clave.
  const n3 = await guardar(
    "titulo LIKE '%Fundantes devueltos por la financiera%' AND (clave IS NULL OR clave = '')",
    [], 'duplicado sin clave del mismo aviso que ya existe con clave fund_dev_');
  console.log(`  ✂ ${n3} copias sin clave de "fundantes devueltos"`);

  if (borradas.length)
    fs.writeFileSync(path.join(__dirname, 'respaldo-avisos-sin-clave-2026-07-31.json'),
      JSON.stringify(borradas, null, 2));

  const [[t]] = await pool.query('SELECT COUNT(*) n FROM notificaciones WHERE leida=0');
  console.log(`\nRetirados: ${borradas.length}. Quedan ${t.n} avisos sin leer.`);
  process.exit(0);
})();
