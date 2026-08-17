'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   REVISIÓN MATINAL — los tres chequeos de cada mañana, en un solo comando.

   Nació como tarea programada de Claude Code en el equipo de Pato, y ahí tenía
   un defecto de fondo: el reloj vivía DENTRO de la app. Si la app no estaba
   abierta a las 08:30, la revisión no corría — el 17-08-2026 salió 58 min tarde
   por eso. Un chequeo que solo corre cuando alguien tiene el computador abierto
   no es un chequeo: es un recordatorio. Por eso se mudó a GitHub Actions
   (.github/workflows/revision-matinal.yml), que corre pase lo que pase.

   Qué revisa (TODO ES SOLO LECTURA — jamás corrige un dato):
     1. Vigía de relojes  → shared/vigia-relojes.js (el motor único; acá no se
        reimplementa el chequeo, se lo llama).
     2. Contabilidad      → eventos de las últimas 48 h que NO generaron asiento.
        Cada SIN_REGLA / DESCUADRE / ERROR es plata que se movió sin contabilizar
        (Máxima 4), o sea una regla de centralización que falta cablear.
     3. Salud del sistema → GET /api/health de producción: BD viva, bucket de
        documentos activo y —clave— ningún motor de negocio apagado.

   Cómo avisa, en tres capas para que no dependa de una sola:
     · Termina con código 1 si hay hallazgos → el job falla y GitHub manda correo.
     · Escribe el resumen en la pestaña Actions (GITHUB_STEP_SUMMARY).
     · Manda correo a ALERTA_ERRORES_MAIL si el mailer está configurado.
   Si todo está bien, sale en silencio con código 0: el buzón se reserva para
   cuando algo pasa. Un aviso diario de "todo bien" se deja de leer al mes.

   Guardia de horario: GitHub Actions no entiende de husos, así que el workflow
   dispara a las 11:30 y 12:30 UTC y este script deja pasar solo la corrida que
   cae en la hora de Chile correcta. Así queda a las 08:30 todo el año sin tener
   que acordarse de mover el cron en cada cambio de hora — este proyecto ya pagó
   caro un desfase horario silencioso (ver la cabecera del vigía de relojes).
   Con REVISION_FORZAR=1 la guardia se salta (lanzamiento a mano).

   Uso local:  node scripts/revision-matinal.js --forzar
   ───────────────────────────────────────────────────────────────────────────── */

const HORA_CHILE_OBJETIVO = 8;   // 08:xx de Chile es la ventana buena
const HEALTH_URL = process.env.HEALTH_URL || 'https://afbs.autofacilchile.cl/api/health';

const forzar = process.argv.includes('--forzar') || process.env.REVISION_FORZAR === '1';

// Hora de Chile según Node, sin depender de la zona del runner (que corre en UTC).
function horaChile() {
  return Number(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', hour12: false, hour: '2-digit',
  }).format(new Date()));
}

/* ── 1) Relojes ─────────────────────────────────────────────────────────────── */
async function chequearRelojes() {
  const { revisar } = require('../shared/vigia-relojes');
  const hallazgos = await revisar();   // devuelve [] si todo cuadra
  return (hallazgos || []).map(h => `Relojes: ${h}`);
}

/* ── 2) Contabilidad: movimientos sin asiento en las últimas 48 h ───────────── */
async function chequearContabilidad() {
  const pool = require('../shared/config/database');
  const [filas] = await pool.query(`
    SELECT estado, evento, COUNT(*) n
      FROM ctb_eventos_log
     WHERE created_at > NOW() - INTERVAL 48 HOUR
       AND estado <> 'CONTABILIZADO'
     GROUP BY estado, evento`);
  return filas.map(f => `Contabilidad: ${f.n} evento(s) "${f.evento}" en ${f.estado} — se movió plata sin asiento. Revisar Reglas de Centralización.`);
}

/* ── 3) Salud del sistema en producción ─────────────────────────────────────── */
async function chequearSalud() {
  const hallazgos = [];
  let j;
  try {
    const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) return [`Salud: ${HEALTH_URL} respondió HTTP ${r.status}.`];
    j = await r.json();
  } catch (e) {
    return [`Salud: no se pudo consultar ${HEALTH_URL} (${e.message}). El sistema puede estar caído.`];
  }

  if (j.status !== 'ok')       hallazgos.push(`Salud: status="${j.status}" (debería ser "ok").`);
  if (j.db !== true)           hallazgos.push('Salud: la base NO responde (db=false).');
  if (j.documentos?.activo !== true) {
    hallazgos.push(`Salud: el almacén de documentos NO está activo (${j.documentos?.motivo || 'sin motivo'}) — los archivos nuevos se estarían guardando en la base.`);
  }
  // Un motor de negocio apagado en PRODUCCIÓN significa que algo dejó de correr
  // solo: comisiones sin aprobar, avisos sin salir, escalamientos detenidos.
  const apagados = j.motores_apagados || [];
  if (apagados.length) hallazgos.push(`Salud: ${apagados.length} motor(es) apagados en producción → ${apagados.join(', ')}.`);

  return hallazgos;
}

/* ── Avisos ─────────────────────────────────────────────────────────────────── */
function escribirResumen(texto) {
  const ruta = process.env.GITHUB_STEP_SUMMARY;
  if (!ruta) return;
  try { require('fs').appendFileSync(ruta, texto + '\n'); } catch (e) { /* nunca romper por el resumen */ }
}

async function avisarPorCorreo(hallazgos) {
  const destino = process.env.ALERTA_ERRORES_MAIL;
  if (!destino) return;
  try {
    const { enviarCorreo, mailConfigurado } = require('../shared/mailer');
    if (!mailConfigurado()) return;
    await enviarCorreo({
      to: destino,
      subject: `🌅 Revisión matinal — ${hallazgos.length} hallazgo(s)`,
      html: `<p><b>La revisión matinal del sistema encontró esto:</b></p>
        <ul>${hallazgos.map(h => `<li>${h}</li>`).join('')}</ul>
        <p style="color:#888;font-size:12px">Chequeo automático de las 08:30 (GitHub Actions).
        Solo lee datos; no corrige nada solo.</p>`,
    });
    console.log(`✉  Aviso enviado a ${destino}`);
  } catch (e) { console.error('No se pudo enviar el correo:', e.message); }
}

/* Salir cerrando el pool primero. En Windows, un `process.exit()` con la conexión
   todavía abierta revienta con un assert de libuv y devuelve 127 — o sea el job
   fallaría SIEMPRE, aunque la revisión hubiera salido limpia. */
async function salir(codigo) {
  try { await require('../shared/config/database').end(); } catch (e) { /* ya estaba cerrado */ }
  process.exit(codigo);
}

/* ── Main ───────────────────────────────────────────────────────────────────── */
(async () => {
  if (!forzar && horaChile() !== HORA_CHILE_OBJETIVO) {
    console.log(`⏭  No son las 0${HORA_CHILE_OBJETIVO}:xx en Chile (son las ${horaChile()}:xx) — esta corrida no toca.`);
    process.exit(0);   // acá el pool ni se abrió
  }

  const hallazgos = [];
  // Cada chequeo se protege por separado: que uno falle no puede dejar los otros
  // dos sin correr, o una caída de la BD nos dejaría también sin mirar la salud.
  for (const [nombre, fn] of [['relojes', chequearRelojes], ['contabilidad', chequearContabilidad], ['salud', chequearSalud]]) {
    try { hallazgos.push(...await fn()); }
    catch (e) { hallazgos.push(`${nombre}: el chequeo mismo falló (${e.message}) — revisar a mano.`); }
  }

  if (!hallazgos.length) {
    const ok = '✓ Revisión matinal: relojes OK, contabilidad OK, salud OK';
    console.log(ok);
    escribirResumen(`## 🌅 Revisión matinal\n\n${ok}`);
    return salir(0);
  }

  const detalle = hallazgos.map(h => `- ${h}`).join('\n');
  console.error(`⚠️  Revisión matinal — ${hallazgos.length} hallazgo(s):\n${detalle}`);
  escribirResumen(`## 🌅 Revisión matinal — ${hallazgos.length} hallazgo(s)\n\n${detalle}`);
  await avisarPorCorreo(hallazgos);
  return salir(1);
})().catch(e => { console.error('Revisión matinal abortada:', e); salir(1); });
