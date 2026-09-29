'use strict';
/**
 * seguros-sura-core.js — MOTOR ÚNICO (puro, isomorfo) de las primas de los seguros SURA de los
 * créditos AUTOFÁCIL (recursos propios): desgravamen y cesantía.
 *
 *   prima_neta    = tasa del tramo de plazo (opción vigente) × MIC        (MIC = monto inicial del crédito)
 *   prima_cliente = prima_neta × (1 + markup del tramo)                   (solo opción 2; opción 1 ya es bruta)
 *
 * Capitalización (el crédito financia sus propias primas, igual que en el canal AutoFin):
 *   MIC = (saldo precio + gastos) / (1 − r_desg − r_cesa)   con r = tasa cliente del tramo / 100
 *
 * Lo usan: shared/seguros-autofacil.js (servidor: mantenedor y API /prima), el Simulador y las
 * Cartas de Aprobación (navegador, con la configuración que entrega GET /api/seguros-autofacil).
 * Sin BD ni DOM. module.exports en Node + window.AF_SEG_SURA en el navegador.
 * NO es el motor de los seguros del canal AUTOFIN (seg_full_* de Factores de Seguros Clientes).
 */
(function (root) {
  const R = v => Math.round(Number(v) || 0);

  /** Configuración de un seguro por nombre, desde la lista que entrega el mantenedor (cargar()/GET). */
  function seguroDe(segs, nombre) {
    return (segs || []).find(s => String(s.seguro || '').toUpperCase() === String(nombre || '').toUpperCase()) || null;
  }

  /** Tramo y tasa CLIENTE (%) de un seguro para un plazo, en la opción vigente (o la indicada). */
  function tarifa(s, plazo, opcion) {
    if (!s) return { error: 'Seguro no configurado' };
    if (s.activo != null && !Number(s.activo)) return { seguro: s.seguro, error: 'Seguro inactivo en el mantenedor' };
    const op = opcion || s.opcion_vigente;
    if (!op) return { seguro: s.seguro, error: 'Sin opción de tarifa vigente' };
    const tramos = (s.tramos && s.tramos[op]) || [];
    const t = tramos.find(x => plazo >= x.plazo_desde && plazo <= x.plazo_hasta);
    if (!t) return { seguro: s.seguro, opcion: op, plazo, error: `Plazo ${plazo} fuera de los tramos de la opción ${op}` };
    const markup = Number(op) === 2 ? (t.markup_pct != null ? Number(t.markup_pct) : (s.markup_pct != null ? Number(s.markup_pct) : 0)) : 0;
    return { seguro: s.seguro, opcion: op, plazo, tramo: `${t.plazo_desde}-${t.plazo_hasta}`, tasa_pct: Number(t.tasa_pct), markup_pct: markup,
      tasa_cliente_pct: Number(t.tasa_pct) * (1 + markup / 100), tope_capital_uf: s.tope_capital_uf, exento_iva: Number(s.exento_iva) === 1 };
  }

  /** Prima única de un seguro sobre un MIC dado. */
  function primaDe(s, mic, plazo, opcion) {
    const tf = tarifa(s, plazo, opcion);
    if (tf.error) return tf;
    const prima_neta = R(Number(mic) * tf.tasa_pct / 100);
    const prima_cliente = R(prima_neta * (1 + tf.markup_pct / 100));
    const comisiones = ((s.comisiones && s.comisiones[tf.opcion]) || []).map(c => ({ nombre: c.nombre, pct: Number(c.pct), iva_incluido: !!c.iva_incluido, monto: R(prima_neta * Number(c.pct) / 100) }));
    return { ...tf, mic: R(mic), prima_neta, prima_cliente, margen: prima_cliente - prima_neta, comisiones };
  }

  /**
   * Primas capitalizadas de un crédito AutoFácil: desgravamen + cesantía (sin RDH: SURA no lo tarifica).
   * @param segs   lista del mantenedor (GET /api/seguros-autofacil o cargar())
   * @param subSinSeg  saldo precio + gastos (lo que se financia antes de las primas)
   * @param plazo  meses
   * @param o      { desgravamen:true, cesantia:true } para excluir alguno
   */
  function capitalizar(segs, subSinSeg, plazo, o) {
    const inc = Object.assign({ desgravamen: true, cesantia: true }, o || {});
    const sub = R(subSinSeg);
    const sd = inc.desgravamen ? seguroDe(segs, 'DESGRAVAMEN') : null;
    const sc = inc.cesantia ? seguroDe(segs, 'CESANTIA') : null;
    const td = sd ? tarifa(sd, plazo) : null, tc = sc ? tarifa(sc, plazo) : null;
    if (td && td.error) return { error: 'Desgravamen: ' + td.error };
    if (tc && tc.error) return { error: 'Cesantía: ' + tc.error };
    const rd = td ? td.tasa_cliente_pct / 100 : 0, rc = tc ? tc.tasa_cliente_pct / 100 : 0;
    const factor = (rd + rc) > 0 && (rd + rc) < 1 ? 1 / (1 - rd - rc) : 1;
    const capital = R(sub * factor);
    const desg = sd ? primaDe(sd, capital, plazo) : null;
    const cesa = sc ? primaDe(sc, capital, plazo) : null;
    const total = (desg ? desg.prima_cliente : 0) + (cesa ? cesa.prima_cliente : 0);
    // Comisión de intermediación de cesantía (la cobra el corredor FACILSEGUROS, no AutoFácil)
    const comCesa = cesa ? cesa.comisiones.reduce((a, c) => a + c.monto, 0) : 0;
    return { capital, sub, factor, desg, cesa, total, margen_desg: desg ? desg.margen : 0, comision_cesantia: comCesa,
      tasa_desg_pct: td ? td.tasa_cliente_pct : 0, tasa_cesa_pct: tc ? tc.tasa_cliente_pct : 0 };
  }

  const api = { seguroDe, tarifa, primaDe, capitalizar };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AF_SEG_SURA = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
