'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Motor ÚNICO del Plan Liquidez (anticipo de comisiones a dealers Super Partner).
   Isomorfo: Node (require) y navegador (window.AF_LIQUIDEZ). NO duplicar — máxima #1.

   Regla (confirmada): el adelanto se "resetea" cada mes al nivel de la comisión,
   con tope. Por dealer: tope (ej. $5.000.000) y deuda anterior D (adelanto vivo).
   Con comisión del mes C:
     A         = min(C, tope)        → adelanto objetivo del mes (nueva deuda)
     descuento = D − A               → abono a la deuda (>0 baja; <0 se presta extra)
     pagoNeto  = C − (D − A) = C−D+A → lo que efectivamente se le paga en la ODP
     nuevaDeuda = A
   La cartola SIEMPRE se manda por el total (C, 100% de la comisión); el descuento
   se aplica en la Orden de Pago y el abono se confirma al pagarse la ODP.
   ──────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AF_LIQUIDEZ = api;
})(typeof self !== 'undefined' ? self : this, function () {

  function n(v) { const x = Number(v); return isNaN(x) ? 0 : x; }

  // Liquidación mensual. comision C, deudaAnterior D, tope.
  function liquidar(comision, deudaAnterior, tope) {
    const C = n(comision), D = n(deudaAnterior), T = n(tope);
    const A = Math.min(C, T);          // adelanto objetivo del mes
    const descuento = D - A;           // >0 abona deuda; <0 préstamo extra
    const pagoNeto = C - descuento;    // = C − D + A
    return {
      adelantoObjetivo: A,
      descuento,                       // monto a descontar de la ODP (puede ser negativo)
      pagoNeto,                        // monto neto a pagar al dealer
      nuevaDeuda: A,
      esPrestamoExtra: descuento < 0,  // este mes se le entrega adelanto adicional
    };
  }

  return { liquidar };
});
