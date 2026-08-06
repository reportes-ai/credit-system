/* ═══════════════════════════════════════════════════════════════════════════
   Devolución automática de conversaciones al bot
   ───────────────────────────────────────────────────────────────────────────
   QUÉ HACE: una conversación en estado DERIVADA deja al bot fuera a propósito
   (si contestara, le hablaría por encima al ejecutivo que la tomó). El efecto
   secundario es que una derivación que nadie retoma deja al cliente hablándole
   a un número mudo — para siempre. Este motor la devuelve al bot pasadas N
   horas sin actividad, y la suelta del ejecutivo para que vuelva al pool.

   QUIÉN LO CONFIGURA: el Administrador, en /whatsapp/ → pestaña Configuración
   → "Devolver al bot tras N horas sin actividad" (wsp_config.devolver_bot_horas,
   0 = nunca devolver).

   NO TOCA las CERRADAS: esas se cerraron a propósito y reabrirlas sería revivir
   un caso terminado.
   ═══════════════════════════════════════════════════════════════════════════ */
// El pool se pide dentro de tick(), no al cargar el módulo: así las pruebas
// pueden importar normalizarHoras sin abrir una conexión que deje el proceso vivo.

/* 0 = nunca devolver. Tope 30 días: un dedazo no puede dejar una conversación
   colgada un año, ni un valor absurdo generar un UPDATE con INTERVAL inválido. */
function normalizarHoras(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 720);
}

async function tick() {
  const pool = require('../../../shared/config/database');
  const [[cfg]] = await pool.query('SELECT devolver_bot_horas FROM wsp_config WHERE id=1');
  const horas = normalizarHoras(cfg?.devolver_bot_horas);
  if (horas <= 0) return { devueltas: 0 };

  // ultima_actividad y NOW() se comparan del lado de la base: mismo reloj, sin
  // riesgo de desfase de zona horaria entre el proceso y TiDB.
  const [r] = await pool.query(
    `UPDATE wsp_conversaciones
        SET estado='BOT', asignada_a=NULL, asignada_nombre=NULL, area=NULL
      WHERE estado='DERIVADA'
        AND ultima_actividad < NOW() - INTERVAL ? HOUR`, [horas]);

  if (r.affectedRows) console.log(`[wsp-devolver-bot] ${r.affectedRows} conversación(es) devueltas al bot tras ${horas} h sin actividad`);
  return { devueltas: r.affectedRows };
}

module.exports = { tick, normalizarHoras };

require('../../../shared/scheduler').programar('wsp-devolver-bot', tick, 10 * 60 * 1000);
