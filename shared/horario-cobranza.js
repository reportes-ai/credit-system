'use strict';
/* ── Horario LEGAL de cobranza (Ley 21.320) — MOTOR ÚNICO ─────────────────
   Las gestiones de cobranza extrajudicial (WhatsApp, correo, llamadas) solo
   pueden hacerse en días hábiles LUNES A SÁBADO (nunca domingo ni feriado),
   entre las 08:00 y las 20:00 hrs. Fuera de eso es ilegal.
   Usa la tabla paramétrica `feriados` (shared/feriados.js, mantenedor Feriados).
   El proceso corre con TZ America/Santiago (api-gateway/src/index.js línea 2),
   por lo que Date local = hora de Chile. */
const { esFeriado } = require('./feriados');

function esHorarioLegalCobranza(d = new Date()) {
  if (d.getDay() === 0) return false;      // domingo
  if (esFeriado(d)) return false;          // feriado (tabla paramétrica)
  const h = d.getHours();
  return h >= 8 && h < 20;                 // 08:00–19:59 (hasta las 20:00)
}

function motivoFueraHorario(d = new Date()) {
  if (d.getDay() === 0) return 'domingo';
  if (esFeriado(d)) return 'feriado';
  const h = d.getHours();
  if (h < 8 || h >= 20) return 'fuera de 8:00–20:00';
  return null;
}

module.exports = { esHorarioLegalCobranza, motivoFueraHorario };
