'use strict';
/**
 * rentabilidad-core.js — MOTOR ÚNICO de ingreso por colocación y comisión ejecutivo.
 *
 * Funciones PURAS (sin BD ni DOM): reciben los datos ya resueltos y devuelven montos.
 * Las usan TODOS los contextos para que el número nunca diverja:
 *   - Guardado de operación   (services/creditos/src/utils/calcular-operacion.js)
 *   - Recálculo mensual       (services/creditos/src/utils/recalcular-mes.js)
 *   - Simulador / cartas      (api-gateway/public/js/rentabilidad-calc.js → AF_RENT)
 *   - Cotizador de créditos   (api-gateway/public/creditos/app.js)
 *
 * Isomorfo: module.exports en Node + window.AF_RENT_CORE en el navegador.
 *
 * Regla de tasa AutoFin (confirmada por negocio):
 *   - tasa CLIENTE (para la cuota) = la real de la operación (tascli_real, ya normalizada
 *     a % mensual); por defecto es la del mantenedor a la fecha de otorgamiento, salvo que
 *     se haya fijado una distinta en la carta/digitación, que MANDA.
 *   - costo de FONDO (para descontar) = tasa del mantenedor por fecha (tramo >/≤200 UF)
 *     menos el spread del mantenedor. Es el costo de AutoFin, no depende de la tasa cliente.
 */
(function (factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AF_RENT_CORE = api;
})(function () {
  'use strict';

  // Cuota francesa de un capital a una tasa mensual (fracción) por N cuotas.
  function cuotaFrancesa(capital, tasaMensual, plazo) {
    const c = +capital || 0, t = +tasaMensual || 0, n = parseInt(plazo) || 0;
    if (!(c > 0 && t > 0 && n > 0)) return 0;
    return c * t * Math.pow(1 + t, n) / (Math.pow(1 + t, n) - 1);
  }

  // Ingreso por colocación AutoFin = VP de la cuota (a la tasa cliente) descontada al
  // costo de fondo, menos el capital. tasaCli y costoFondo en FRACCIÓN mensual.
  function ingresoColocacionAutoFin(o) {
    const mc = +o.montoCap || 0, pl = parseInt(o.plazo) || 0;
    const tc = +o.tasaCli || 0, cf = +o.costoFondo || 0;
    if (!(mc > 0 && pl > 0 && tc > 0 && cf > 0)) return 0;
    const cuota = cuotaFrancesa(mc, tc, pl);
    const pv = cuota * (1 - Math.pow(1 + cf, -pl)) / cf;
    return Math.round(pv - mc);
  }

  // Ingreso por colocación UAC = % del saldo precio (tier del mes, en fracción).
  function ingresoColocacionUAC(o) {
    const s = +o.saldo || 0, p = +o.pctUAC || 0;
    return (s > 0 && p > 0) ? Math.round(s * p) : 0;
  }

  // Comisión ejecutivo = % del monto financiado (pctEj en fracción).
  function comisionEjecutivo(o) {
    const m = +o.montoFin || 0, p = +o.pctEj || 0;
    return (m > 0 && p > 0) ? Math.round(m * p) : 0;
  }

  // ¿La operación es > umbral UF (200 por defecto)? Define el tramo de tasa/spread.
  function esMayor200(o) {
    if (!o.uf) return false;
    return (+o.montoCap || 0) > ((o.umbralUf || 200) * (+o.uf || 0));
  }

  // Ingreso neto total de la operación = ingreso financiera + ingreso seguros − costos
  // (comisión dealer + comisión parque + arriendo de parque). Recibe los valores ya
  // resueltos (forzados o calculados); no redondea (los componentes ya vienen enteros).
  function ingresoNetoTotal(o) {
    const f = +o.comFin || 0, s = +o.seguros || 0;
    const d = +o.comDealer || 0, p = +o.comParque || 0, a = +o.arriendo || 0;
    return f + s - d - p - a;
  }

  return {
    cuotaFrancesa,
    ingresoColocacionAutoFin,
    ingresoColocacionUAC,
    comisionEjecutivo,
    esMayor200,
    ingresoNetoTotal,
  };
});
