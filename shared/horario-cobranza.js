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

/* ── Tope SEMANAL de gestiones por crédito (paramétrico) ──────────────────
   cobranza_config.tope_gestiones_semana (0 = sin tope). Cuenta TODAS las
   gestiones de la bitácora de cobranzas de los últimos 7 días (manuales +
   automáticas, excluye SIMULADO porque nada llegó al cliente). Los motores
   automáticos NO envían a un crédito que ya alcanzó el tope. */
const pool = require('./config/database');
let _tope = { valor: null, ts: 0 };
async function topeSemanal() {
  if (_tope.valor !== null && Date.now() - _tope.ts < 60000) return _tope.valor;
  try {
    const [[r]] = await pool.query("SELECT valor FROM cobranza_config WHERE clave='tope_gestiones_semana' LIMIT 1");
    _tope = { valor: Math.max(0, parseInt(r?.valor, 10) || 0), ts: Date.now() };
  } catch (e) { _tope = { valor: 0, ts: Date.now() }; }
  return _tope.valor;
}

// De un set de créditos, cuáles YA alcanzaron el tope semanal → Set(id_credito)
async function creditosConTopeAlcanzado(ids) {
  const tope = await topeSemanal();
  if (!tope || !ids || !ids.length) return new Set();
  try {
    const [rows] = await pool.query(`
      SELECT id_credito, COUNT(*) n FROM cobranza_gestiones
      WHERE id_credito IN (?) AND created_at >= (NOW() - INTERVAL 7 DAY) AND resultado <> 'SIMULADO'
      GROUP BY id_credito HAVING n >= ?`, [ids, tope]);
    return new Set(rows.map(r => r.id_credito));
  } catch (e) { return new Set(); }
}

module.exports = { esHorarioLegalCobranza, motivoFueraHorario, topeSemanal, creditosConTopeAlcanzado };
