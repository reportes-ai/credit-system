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

/* ── Cupo semanal de gestiones REMOTAS (Ley del Consumidor) ────────────────
   MISMA regla que aplica Pre-judicial a las gestiones manuales
   (cobranza.controller.js → disponibilidad): por crédito, máx 2 gestiones
   REMOTAS (WhatsApp/SMS/Email) por SEMANA CALENDARIO (lunes a domingo,
   YEARWEEK ISO), separadas por al menos 2 días. Cuenta manuales + automáticas
   de la bitácora de cobranzas (excluye SIMULADO: nada llegó al cliente).
   Los motores automáticos son canal REMOTA → no envían a un crédito sin cupo. */
const pool = require('./config/database');

// De un set de créditos, cuáles NO tienen cupo remoto esta semana → Set(id_credito)
async function creditosSinCupoRemota(ids) {
  if (!ids || !ids.length) return new Set();
  try {
    const [rows] = await pool.query(`
      SELECT id_credito, COUNT(*) n, MAX(DATE(created_at)) ultima
      FROM cobranza_gestiones
      WHERE id_credito IN (?) AND canal = 'REMOTA' AND resultado <> 'SIMULADO'
        AND YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)
      GROUP BY id_credito`, [ids]);
    const sin = new Set();
    for (const r of rows) {
      if (r.n >= 2) { sin.add(r.id_credito); continue; }                    // agotó las 2 de la semana
      // separación mínima de 2 días respecto de la última remota
      const dif = Math.floor((Date.now() - new Date(String(r.ultima).slice(0, 10) + 'T12:00:00').getTime()) / 86400000);
      if (dif < 2) sin.add(r.id_credito);
    }
    return sin;
  } catch (e) { return new Set(); }
}

module.exports = { esHorarioLegalCobranza, motivoFueraHorario, creditosSinCupoRemota };
