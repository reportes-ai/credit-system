'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   VIGÍA DE RELOJES — chequeo diario (08:00 Chile) de que las fechas del sistema
   están coherentes. Nace del episodio de las 4 horas (ago-2026): las cartas
   guardaban datetimes que venían del navegador en UTC y cada re-guardado corría
   la marca +4 h. Se reparó y se selló, pero la lección es que este tipo de bug
   NO avisa: se descubre semanas después mirando un informe.

   Importante: los relojes físicos NO se desajustan (Render y TiDB usan NTP).
   Lo que falla es la INTERPRETACIÓN (qué zona horaria usa el código). Por eso
   este vigía no "calibra" nada — verifica coherencia y ACUSA:

   1. NOW() de la BD vs hora de Chile calculada en Node → si difieren más de
      2 min, el `SET time_zone` del pool se perdió o alguien cambió la config.
   2. Marcas de tiempo DEL FUTURO en tablas críticas → síntoma inequívoco de
      que algún código volvió a escribir un datetime UTC como si fuera local
      (a las 21:00 de Chile, una marca UTC dice 01:00 de "mañana").

   Si algo no cuadra → correo a ALERTA_ERRORES_MAIL. Si todo bien → una línea
   en el log y nada más. Solo LEE datos; jamás corrige solo.
   ───────────────────────────────────────────────────────────────────────────── */

const pool = require('./config/database');
const { programar } = require('./scheduler');
const { TZ } = require('./fecha-chile');

const MARGEN_RELOJ_SEG = 120;   // BD vs Node: más de esto es hallazgo
const MARGEN_FUTURO_MIN = 10;   // marcas más de 10 min en el futuro = sospechosas

/* Tablas y columnas donde una marca del futuro delata el bug. Todas tienen
   DEFAULT CURRENT_TIMESTAMP o se escriben con NOW() desde el sello de v208.5. */
const VIGILADAS = [
  { tabla: 'cartas_aprobacion', cols: ['fecha_creacion', 'fecha_aprobacion', 'fecha_otorgado', 'fecha_rechazo'] },
  { tabla: 'creditos', cols: ['created_at'] },
  { tabla: 'auditoria_movimientos', cols: ['fecha'] },
];

// Hora de Chile según Node, como 'YYYY-MM-DD HH:mm:ss' (comparable con NOW()).
function ahoraChileNode() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

async function revisar() {
  const hallazgos = [];

  // 1) El reloj de la BD debe decir hora de Chile (el pool hace SET time_zone).
  const [[bd]] = await pool.query("SELECT NOW() ahora, @@session.time_zone tz");
  const nodeChile = ahoraChileNode();
  // mysql2 entrega NOW() como objeto Date interpretado con el offset de Chile del pool.
  // Se compara en ÉPOCA contra Date.now(): si el SET time_zone de la sesión se pierde,
  // NOW() devuelve otra pared horaria y la época queda corrida 3-4 h. Comparar contra el
  // string local de Node daría falsa alarma en Render (Node corre en UTC), y parsear el
  // Date como string da NaN y deja el chequeo mudo.
  const bdMs = bd.ahora instanceof Date ? bd.ahora.getTime() : Date.parse(String(bd.ahora).replace(' ', 'T'));
  const difSeg = Math.abs((bdMs - Date.now()) / 1000);
  if (difSeg > MARGEN_RELOJ_SEG) {
    hallazgos.push(`NOW() de la BD (${bd.ahora}, tz=${bd.tz}) difiere ${Math.round(difSeg / 60)} min de la hora de Chile (${nodeChile}). El SET time_zone del pool pudo perderse.`);
  }

  // 2) Marcas del futuro en las tablas críticas.
  for (const v of VIGILADAS) {
    for (const col of v.cols) {
      try {
        const [[r]] = await pool.query(
          `SELECT COUNT(*) n, MAX(${col}) peor FROM ${v.tabla} WHERE ${col} > NOW() + INTERVAL ${MARGEN_FUTURO_MIN} MINUTE`);
        if (r.n > 0) hallazgos.push(`${v.tabla}.${col}: ${r.n} marca(s) EN EL FUTURO (la peor: ${r.peor}). Algún código volvió a guardar UTC como hora local.`);
      } catch (e) { hallazgos.push(`${v.tabla}.${col}: no se pudo revisar (${e.message})`); }
    }
  }

  if (!hallazgos.length) {
    console.log(`✓ [vigia-relojes] Relojes coherentes (BD=${bd.ahora}, Node=${nodeChile}, tz=${bd.tz})`);
    return hallazgos;
  }

  console.error('⚠️ [vigia-relojes] HALLAZGOS:\n - ' + hallazgos.join('\n - '));
  const destino = process.env.ALERTA_ERRORES_MAIL || '';
  if (!destino) return;
  try {
    const { enviarCorreo, mailConfigurado } = require('./mailer');
    if (!mailConfigurado()) return;
    await enviarCorreo({
      to: destino,
      subject: `⏰ Vigía de relojes — ${hallazgos.length} hallazgo(s)`,
      html: `<p><b>El chequeo diario de fechas y horas encontró incoherencias:</b></p>
        <ul>${hallazgos.map(h => `<li>${h}</li>`).join('')}</ul>
        <p style="color:#888;font-size:12px">Regla: las marcas de tiempo las pone la BD (NOW()), nunca el navegador.
        Ver "Fechas y horas" en la Documentación Técnica. Este vigía solo acusa; no corrige nada solo.</p>`,
    });
  } catch (e) { /* la alerta nunca debe causar otro error */ }
  return hallazgos;
}

/* Corre cada 30 min pero actúa UNA vez al día, pasadas las 08:00 de Chile.
   (No a las 08:00 exactas: si el proceso partió a las 09:00, revisa igual.) */
let ultimoDia = null;
async function tick() {
  const ahora = ahoraChileNode();               // 'YYYY-MM-DD HH:mm:ss'
  const dia = ahora.slice(0, 10);
  const hora = Number(ahora.slice(11, 13));
  if (hora < 8 || ultimoDia === dia) return;
  ultimoDia = dia;
  await revisar();
}

programar('vigia-relojes', tick, 30 * 60 * 1000, { arranqueMs: 2 * 60 * 1000, arranqueFn: tick });

module.exports = { revisar };
