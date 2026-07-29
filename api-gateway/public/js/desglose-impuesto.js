/* ─────────────────────────────────────────────────────────────────────────────
   MOTOR ÚNICO — desglose de impuesto de un monto BRUTO (Máxima 1).
   Regla de negocio: la COMISIÓN que calcula el sistema es SIEMPRE BRUTA
   (IVA INCLUIDO). El neto y el impuesto se DESAGREGAN hacia abajo; jamás se le
   suma impuesto encima a un monto que ya lo trae.

     Factura afecta (IVA):  neto = bruto / (1 + iva)   · impuesto = bruto − neto
                            a pagar (líquido) = bruto
     Boleta de honorarios:  base = honorario bruto     · retención = base × ret
                            a pagar (líquido) = base − retención

   EQUIVALENCIA FACTURA ↔ BOLETA (regla de negocio): el costo real de AutoFácil es
   SIEMPRE el NETO. Con factura el IVA es crédito fiscal (el dealer solo actúa de
   agente retenedor); con boleta no hay IVA que recuperar y la retención se la
   devuelven al dealer reajustada al año siguiente. Por eso, al emitir boleta, el
   HONORARIO BRUTO que se pasa aquí es el NETO de la factura equivalente
   (comisión ÷ (1 + iva)), nunca la comisión bruta.

   Isomorfo: se usa igual en el backend (require) y en el navegador (window).
   Consumidores: carga masiva (guarda el desglose), orden de pago de comisión,
   órdenes de pago de Tesorería.
   ───────────────────────────────────────────────────────────────────────────── */
(function (raiz) {
  'use strict';

  /**
   * Desagrega un monto BRUTO (impuesto incluido) en sus componentes.
   * @param {number} bruto  monto total, impuesto incluido (CLP)
   * @param {number} pct    porcentaje del impuesto (ej. 19 para IVA, 15.25 retención)
   * @param {boolean} esBoleta  true = boleta de honorarios (retención), false = factura afecta (IVA)
   * @returns {{bruto:number, neto:number, impuesto:number, liquido:number, base:number, pct:number}}
   *   base    = valor que se registra como "monto" del documento (neto en factura, bruto en boleta)
   *   liquido = lo que efectivamente se deposita
   */
  function desglosar(bruto, pct, esBoleta) {
    const b = Math.round(Number(bruto) || 0);
    const p = Number(pct) || 0;
    if (esBoleta) {
      const impuesto = Math.round(b * p / 100);
      return { bruto: b, neto: b - impuesto, impuesto, liquido: b - impuesto, base: b, pct: p };
    }
    const neto = p > 0 ? Math.round(b / (1 + p / 100)) : b;
    return { bruto: b, neto, impuesto: b - neto, liquido: b, base: neto, pct: p };
  }

  const api = { desglosar };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.AF_IMPUESTO = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
