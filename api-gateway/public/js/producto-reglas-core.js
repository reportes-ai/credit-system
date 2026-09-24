/* ─────────────────────────────────────────────────────────────────────────────
   MOTOR ÚNICO — REGLAS PROPIAS DE UN PRODUCTO (Máxima 1: un solo motor).
   Un producto de Productos por Financiera con `reglas_propias = 1` (hoy AUTOFIN
   PREFERENTE) se comporta "como otra financiera": tasa al cliente por tramo UF,
   spread (costo de fondo = tasa − spread), comisión dealer por tramo de plazo sobre
   el saldo precio, comisión parque (% del saldo) y comisión ejecutivo (% del monto
   financiado). Las cifras viven en el mantenedor; aquí solo la lógica.

   Lo usan: el Simulador de Rentabilidad, el Generador de Cartas (checkbox
   PREFERENTE: tasa fija, comisión dealer y parque topadas por el producto), los
   motores de guardado y recálculo de créditos (calcular-operacion / recalcular-mes)
   y el motor de comisión de ejecutivos. En Node lo envuelve shared/producto-reglas.js
   (carga y caché desde la BD).

   Funciones PURAS: reciben la fila del producto (pr) ya cargada. Porcentajes de
   salida en FRACCIÓN (0.025 = 2,5%) salvo tasaPct / spreadPct, que devuelven el %
   mensual tal como se digita en el mantenedor (2.39 = 2,39%), igual que la pizarra.
   Isomorfo: module.exports en Node + window.AF_PROD_REGLAS en el navegador. (24-09-2026)
   ───────────────────────────────────────────────────────────────────────────── */
(function (factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AF_PROD_REGLAS = api;
})(function () {
  'use strict';
  const num = v => (v == null || v === '' || isNaN(v)) ? null : Number(v);

  // dealer_tramos viene como JSON en la BD ([{hasta:35,pct:0},…]) o ya parseado
  function parseTramos(raw) {
    if (Array.isArray(raw)) return raw;
    try { const a = JSON.parse(raw || 'null'); return Array.isArray(a) ? a : []; } catch (_) { return []; }
  }
  // % (fracción) del tramo cuyo "hasta" cubre el plazo; sobre el último tramo, el último manda
  function pctTramo(tramos, plazo) {
    const p = parseInt(plazo, 10) || 0;
    const t = parseTramos(tramos).slice().sort((a, b) => Number(a.hasta) - Number(b.hasta));
    const f = t.find(x => p <= Number(x.hasta)) || (t.length ? t[t.length - 1] : null);
    return f ? (Number(f.pct) || 0) / 100 : 0;
  }
  const activas      = pr => !!pr && Number(pr.reglas_propias) === 1;
  const esPreferente = pr => activas(pr) && /PREFERENTE/i.test(String(pr.producto || ''));
  const tasaPct      = (pr, esMayor) => num(esMayor ? pr.tasa_mayor_pct : pr.tasa_menor_pct);      // % mensual
  const spreadPct    = (pr, esMayor) => num(esMayor ? pr.spread_mayor_pct : pr.spread_menor_pct);  // % mensual
  const dealerPct    = (pr, plazo)   => pctTramo(pr.dealer_tramos, plazo);                          // fracción del saldo precio
  const parquePct    = pr => (num(pr.parque_pct) || 0) / 100;                                       // fracción del saldo precio
  const ejecutivoPct = pr => { const v = num(pr.ejecutivo_pct); return v == null ? null : v / 100; }; // fracción del monto financiado

  return { parseTramos, pctTramo, activas, esPreferente, tasaPct, spreadPct, dealerPct, parquePct, ejecutivoPct };
});
