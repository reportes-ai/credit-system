'use strict';
/**
 * comision-dealer.js — MOTOR ÚNICO de comisión dealer y parque.
 *
 * Precedencia del % de comisión dealer:
 *   1. TABLA INDIVIDUAL del dealer (dealers.com_* / com_parque_*) si tiene ese tramo → MANDA.
 *   2. Si no, la PIZARRA (parametros_credito: dealer_pct_* parque, dealer_calle_pct_* calle),
 *      que es solo el default/semilla al crear la ficha de un dealer nuevo.
 *
 * Comisión parque = lo que se paga al DUEÑO del parque automotriz: arriendo (fijo) +
 * % del saldo precio, paramétrico por parque (parques_comisiones) con fallback a patio_pct.
 *
 * Función PURA: recibe los datos ya cargados (no toca BD). La usan el guardado
 * (calcular-operacion.js), el recálculo (recalcular-mes.js) y —a futuro— la carta,
 * para que el número nunca diverja entre procesos.
 */

const normRutD = r => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();

// Pizarra PARQUE: % default por plazo (parametros_credito.dealer_pct_*).
function pizarraParque(plazo, p) {
  if (plazo <= 6)  return (p.dealer_pct_6  || 0) / 100;
  if (plazo <= 12) return (p.dealer_pct_12 || 0) / 100;
  if (plazo <= 24) return (p.dealer_pct_24 || 0) / 100;
  if (plazo <= 36) return (p.dealer_pct_36 || 0) / 100;
  return (p.dealer_pct_99 || 0) / 100;
}
// Pizarra CALLE: dealer_calle_pct_* si existe; si no, dealer_pct_* + patio_pct.
function pizarraCalle(plazo, p) {
  const v = (k, fb) => (p[k] != null ? p[k] : fb) / 100;
  if (plazo <= 6)  return v('dealer_calle_pct_6',  (p.dealer_pct_6  || 0) + (p.patio_pct || 0));
  if (plazo <= 12) return v('dealer_calle_pct_12', (p.dealer_pct_12 || 0) + (p.patio_pct || 0));
  if (plazo <= 24) return v('dealer_calle_pct_24', (p.dealer_pct_24 || 0) + (p.patio_pct || 0));
  if (plazo <= 36) return v('dealer_calle_pct_36', (p.dealer_pct_36 || 0) + (p.patio_pct || 0));
  return v('dealer_calle_pct_99', (p.dealer_pct_99 || 0) + (p.patio_pct || 0));
}

// Tabla pactada del dealer (su % por tramo). Manda sobre la pizarra. Si la op es en
// PARQUE y el dealer tiene tabla parque (com_parque_*), usa esa; si no, la de CALLE.
function dealerTablePct(d, plazo, esParque) {
  if (!d) return null;
  if (esParque) {
    const pv = plazo <= 12 ? d.com_parque_6_12 : plazo <= 24 ? d.com_parque_13_24 : plazo <= 36 ? d.com_parque_25_36 : d.com_parque_37;
    if (pv != null && pv !== '') return Number(pv) / 100;
  }
  const v = plazo <= 12 ? d.com_6_12 : plazo <= 24 ? d.com_13_24 : plazo <= 36 ? d.com_25_36 : d.com_37;
  return (v == null || v === '') ? null : Number(v) / 100;
}

/**
 * comisionDealer({ saldo, plazo, esParque }, { dealerTabla, parqData, pizarra })
 *   dealerTabla = fila de `dealers` del dealer (o null) — su tabla pactada
 *   parqData    = fila de `parques_comisiones` del parque (o null) — comision_pct + arriendo
 *   pizarra     = objeto parametros_credito
 * → { comdea_real, com_parque, arriendo, base_pct }
 */
function comisionDealer({ saldo, plazo, esParque }, { dealerTabla, parqData, pizarra }) {
  const s  = parseFloat(saldo) || 0;
  const pl = parseInt(plazo)   || 0;
  let comdea_real = 0, com_parque = 0, arriendo = 0, base_pct = 0;
  if (s > 0 && pl > 0) {
    const dPct = dealerTablePct(dealerTabla, pl, esParque);
    base_pct = esParque
      ? (dPct != null ? dPct : pizarraParque(pl, pizarra))
      : (dPct != null ? dPct : pizarraCalle(pl, pizarra));
    comdea_real = Math.round(s * base_pct);
    if (esParque) {
      // Guard: parqData puede existir con comision_pct null → cae a patio_pct (no NaN).
      const patioPct = (parqData && parqData.comision_pct != null)
        ? parseFloat(parqData.comision_pct)
        : ((pizarra.patio_pct || 0) / 100);
      arriendo   = parqData ? (parseFloat(parqData.arriendo) || 0) : 0;
      com_parque = Math.round(s * (patioPct || 0));
    }
  }
  return { comdea_real, com_parque, arriendo, base_pct };
}

module.exports = { comisionDealer, dealerTablePct, normRutD };
