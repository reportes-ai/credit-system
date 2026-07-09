'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   MOTOR ÚNICO — Tier UAC (% de ingreso por colocación UNIDAD DE CRÉDITO).

   Dos MODELOS parametrizables (mantenedor Parámetros Financieras,
   parametros_credito.uac_modelo = 1|2). Solo UNO está activo a la vez:

   · Modelo 1 (clásico): % por tramo según N° de ops UAC del mes
     (uac_pct_tier1..4, uac_ops_tier1..3_max).
   · Modelo 2 (corte por plazo): mismos tramos con sus propios parámetros
     (uac2_pct_tier1..4, uac2_ops_tier1..3_max) PERO las operaciones con
     plazo >= uac2_plazo_corte (default 36 cuotas) NO reciben el tier alto:
     su % queda topado en uac2_pct_largo (default 16%).

   Lo usan: calcular-operacion.js (guardado), recalcular-mes.js (recálculo)
   y cartas.controller.js (snapshot del tier del mes en la carta).
   ═══════════════════════════════════════════════════════════════════════════ */

const modeloActivo = p => (Math.round(Number(p.uac_modelo)) === 2 ? 2 : 1);

// Lee un parámetro del modelo activo con fallback al modelo 1 y a defaults.
function param(p, key, def) {
  if (modeloActivo(p) === 2) {
    const v2 = p['uac2_' + key];
    if (v2 !== undefined && v2 !== null && !isNaN(v2)) return Number(v2);
  }
  const v1 = p['uac_' + key];
  return (v1 !== undefined && v1 !== null && !isNaN(v1)) ? Number(v1) : def;
}

/* % del tier del MES (fracción 0-1) según N° de ops UAC, con el modelo activo. */
function pctUACMes(cnt, p) {
  if (cnt >= param(p, 'ops_tier3_max', 15)) return param(p, 'pct_tier4', param(p, 'pct_tier3', 18)) / 100;
  if (cnt >= param(p, 'ops_tier2_max', 10)) return param(p, 'pct_tier3', 18) / 100;
  if (cnt >= param(p, 'ops_tier1_max',  5)) return param(p, 'pct_tier2', 16) / 100;
  return param(p, 'pct_tier1', 14) / 100;
}

/* Tope por plazo del Modelo 2: una op con plazo >= corte no recibe el tier
   alto — su % queda en min(pctTier, uac2_pct_largo). En Modelo 1 es no-op. */
function aplicarCortePlazoUAC(pct, plazo, p) {
  if (modeloActivo(p) !== 2) return pct;
  const corte = Math.round(Number(p.uac2_plazo_corte)) || 36;
  if (!plazo || Number(plazo) < corte) return pct;
  const tope = (p.uac2_pct_largo !== undefined && p.uac2_pct_largo !== null && !isNaN(p.uac2_pct_largo)
    ? Number(p.uac2_pct_largo) : 16) / 100;
  return Math.min(pct, tope);
}

/* % efectivo de UNA operación: tier del mes + corte por plazo (modelo 2). */
const pctUACOperacion = ({ ops, plazo }, p) => aplicarCortePlazoUAC(pctUACMes(ops, p), plazo, p);

/* Tier "informativo" (n° y %) del mes — para el snapshot de la carta. */
function tierUACInfo(cnt, p) {
  const t1 = param(p, 'ops_tier1_max', 5), t2 = param(p, 'ops_tier2_max', 10), t3 = param(p, 'ops_tier3_max', 15);
  let n, pct;
  if (cnt <= t1)      { n = 1; pct = param(p, 'pct_tier1', 14); }
  else if (cnt <= t2) { n = 2; pct = param(p, 'pct_tier2', 16); }
  else if (cnt <= t3) { n = 3; pct = param(p, 'pct_tier3', 18); }
  else                { n = 4; pct = param(p, 'pct_tier4', 20); }
  return { n, pct };
}

module.exports = { modeloActivo, pctUACMes, aplicarCortePlazoUAC, pctUACOperacion, tierUACInfo };
