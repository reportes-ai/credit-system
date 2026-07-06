'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   MOTOR ÚNICO DE CAE — definición oficial AutoFácil (Excel "CALCULO CAE.xlsx"):
     tasa mensual implícita r = RATE(plazo, -cuota, saldoPrecio líquido)
     CAE = r × 12 (anualización LINEAL, no compuesta)
   Base = lo que efectivamente recibe el cliente (saldo precio), NUNCA el monto
   financiado: así el CAE captura gastos y seguros capitalizados en la cuota.

   Isomorfo (Node + navegador), patrón rentabilidad-core.js. Lo usan:
     - shared/cotizador.js               (simulador rápido dealers/interna)
     - cotizaciones/index.html           (simulador de créditos)
     - creditos/app.js                   (creación de créditos)
     - creditos/documentos.html          (contratos/pagarés recursos propios)
   Si se corrige, se corrige AQUÍ y en ninguna otra parte.
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.AF_CAE = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  /** Tasa mensual implícita: r que cumple PV(cuota, plazo, r) = saldoPrecio.
   *  Bisección en [0, 100%] mensual — robusta, sin problemas de convergencia. */
  function tasaImplicita(saldoPrecio, cuota, plazo) {
    const s = +saldoPrecio, c = +cuota, n = parseInt(plazo);
    if (!(s > 0 && c > 0 && n > 0) || c * n <= s) return null; // sin interés positivo no hay tasa
    let lo = 0, hi = 1;
    for (let i = 0; i < 80; i++) {
      const r = (lo + hi) / 2;
      const pv = r < 1e-10 ? c * n : c * (1 - Math.pow(1 + r, -n)) / r;
      if (pv > s) lo = r; else hi = r;
    }
    return (lo + hi) / 2;
  }

  /** CAE en % anual (ej: 39.32) o null si no es calculable. */
  function cae(saldoPrecio, cuota, plazo) {
    const r = tasaImplicita(saldoPrecio, cuota, plazo);
    return r == null ? null : Math.round(r * 12 * 10000) / 100;
  }

  return { tasaImplicita, cae };
});
