/* ─────────────────────────────────────────────────────────────────────────────
   PRELACIÓN DE PAGOS — motor único (isomorfo: navegador `window.AF_PRELACION` y Node).
   Aplica un monto recibido a los ítems de una deuda en el ORDEN DE PRELACIÓN del mantenedor
   (Tesorería › Aplicación de Fondos › Orden de prelación). Lo que el monto no alcanza a cubrir
   de cada ítem queda como DESCUENTO; lo que sobra después del último ítem es DEVOLUCIÓN al cliente.
   Réplica del Excel de cobranza "FORMULARIO APLICACION DE FONDOS" (cascada de columnas F/G).
   · items: { key: deuda_total_del_item (incluye IVA si lleva) }
   · orden: ['honorarios','gastos_procesales','capital', ...]  (keys; los que falten van al final)
   · recibido: monto total disponible (recibido + renegociado)
   ───────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AF_PRELACION = api;
})(this, function () {
  'use strict';
  const R = v => Math.round(Number(v) || 0);
  function aplicar(items, orden, recibido) {
    const keys = Object.keys(items || {});
    const seq = [...(orden || []).filter(k => keys.includes(k)), ...keys.filter(k => !(orden || []).includes(k))];
    let disp = Math.max(0, R(recibido));
    const out = {};
    for (const k of seq) {
      const deuda = Math.max(0, R(items[k]));
      const aplicado = Math.min(disp, deuda);
      disp -= aplicado;
      out[k] = { deuda, aplicado, descuento: deuda - aplicado };
    }
    return { items: out, devolucion: disp, orden: seq };
  }
  // Orden por defecto = el del Excel de cobranza (columna H)
  const ORDEN_DEFAULT = ['honorarios', 'gastos_procesales', 'capital', 'int_corriente', 'int_mora', 'gastos_cobranza', 'costo_prepago'];
  return { aplicar, ORDEN_DEFAULT };
});
