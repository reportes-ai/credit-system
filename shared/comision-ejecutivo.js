'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   COMISIÓN DEL EJECUTIVO COMERCIAL — motor único (Máxima 1).

   Función PURA: recibe los créditos del mes ya resueltos y los parámetros del
   mantenedor (`comisiones_variables`), y devuelve el desglose completo. Sin BD.

   Vivía dentro de `services/comisiones/.../comisiones.controller.js`; se movió
   acá TAL CUAL (auditoría 03-08-2026, hallazgo B-3) porque ese controller corre
   migraciones al importarse y el cálculo no se podía probar sin levantar la base.
   El controller la sigue consumiendo desde acá — no hay una segunda copia.

   La estructura del incentivo (anexo de contrato 08-2026):
     · piso: bajo `minimo_monto` de financiado en el mes NO hay comisión;
     · base: % del monto financiado, con tramo por plazo (< 24 / ≥ 24 cuotas);
     · ajustes: cruce de seguros (RDH, cesantía, reparaciones) y calidad, cada uno
       solo si supera su umbral, ponderado por su peso y por `factor_max`;
     · semana corrida (art. 45 CT) multiplica al final.
   ───────────────────────────────────────────────────────────────────────────── */
/* Semana corrida: motor único en shared/semana-corrida.js (art. 45 CT, jornada L-S).
   Paramétrico: con semana_corrida_calc = 0 se vuelve al multiplicador fijo.

   El `require` es PEREZOSO a propósito: semana-corrida arrastra la tabla de
   feriados, que se siembra contra la base al importarse. Cargándolo solo cuando
   de verdad se necesita, este módulo se puede probar —y usar en un script— sin
   levantar la BD. El comportamiento no cambia. */
function factorSemanaCorrida(mes, vars) {
  if (!(vars.semana_corrida_calc > 0)) return vars.semana_corrida || 1;
  const SC = require('./semana-corrida');   // días hábiles = sin fines de semana ni feriados chilenos
  return SC.factorMes(mes, 6, vars.semana_corrida || 1);
}

function calcularComision(creditos, vars, mes) {
  const {
    pct_24, pct_mas24, minimo_monto, factor_max,
    peso_rdh, peso_cesantia, peso_rep, peso_calidad,
    umbral_rdh, umbral_cesantia, umbral_rep, semana_corrida,
    meta_unidad,
  } = vars;

  const otorgados = creditos.filter(c => (c.estado_credito || '').toUpperCase() === 'OTORGADO');

  // Total financiado (todos los OTORGADOS)
  const total_financiado = otorgados.reduce((s, c) => s + (parseFloat(c.monto_financiado) || 0), 0);

  if (total_financiado < minimo_monto) {
    return { cumple_minimo: false, total_creditos: otorgados.length, total_financiado, minimo_monto };
  }

  // Split por plazo — regla del anexo de contrato: MENOR a 24 = pct_24; IGUAL O MAYOR a 24 = pct_mas24.
  // (el plazo de 24 exactos paga la tasa mayor; antes caía en la menor)
  const ot24    = otorgados.filter(c => parseInt(c.plazo) <  24);
  const otMas24 = otorgados.filter(c => parseInt(c.plazo) >= 24);
  const monto24    = ot24.reduce((s, c) => s + (parseFloat(c.monto_financiado) || 0), 0);
  const montoMas24 = otMas24.reduce((s, c) => s + (parseFloat(c.monto_financiado) || 0), 0);

  const base24    = monto24    * pct_24;
  const baseMas24 = montoMas24 * pct_mas24;
  const incentivo_base = base24 + baseMas24;

  // NCNU: AUTOFIN, no CORFO (base de medición de seguros)
  const ncnu = otorgados.filter(c =>
    (c.financiera || '').toUpperCase() === 'AUTOFIN' &&
    !(c.producto || '').toUpperCase().includes('CORFO')
  );
  const ncnu_total    = ncnu.length;
  const ncnu_rdh      = ncnu.filter(c => (parseFloat(c.seguro_rdh)       || 0) > 0).length;
  const ncnu_cesantia = ncnu.filter(c => (parseFloat(c.seguro_cesantia)  || 0) > 0).length;
  const ncnu_rep      = ncnu.filter(c => (parseFloat(c.seguro_rep_menor) || 0) > 0).length;

  const cruce_rdh          = ncnu_total > 0 ? ncnu_rdh      / ncnu_total : 0;
  const cruce_cesantia     = ncnu_total > 0 ? ncnu_cesantia / ncnu_total : 0;
  const cruce_reparaciones = ncnu_total > 0 ? ncnu_rep      / ncnu_total : 0;

  // Calidad: meta = N créditos UNIDAD DE CRÉDITO en el mes (paramétrico: comisiones_variables.meta_unidad)
  const META_UNIDAD = meta_unidad > 0 ? meta_unidad : 3;
  const unidad_logrado = otorgados.filter(c =>
    (c.financiera || '').toUpperCase().includes('UNIDAD') ||
    (c.producto   || '').toUpperCase().includes('UNIDAD')
  ).length;
  // TODO O NADA (anexo de contrato 08-2026): la meta es una EXIGENCIA, no un divisor.
  // Bajo la meta el indicador aporta 0; alcanzada o superada, aporta el 100%.
  // (antes era proporcional: 1 de 3 operaciones ya pagaba un tercio del indicador)
  const calidad        = unidad_logrado >= META_UNIDAD ? 1 : 0;

  const cumple_rdh = cruce_rdh          > umbral_rdh;
  const cumple_ces = cruce_cesantia     > umbral_cesantia;
  const cumple_rep = cruce_reparaciones > umbral_rep;

  // Cada indicador entra con su cruce solo si supera su umbral; si no, entra con 0.
  // El peso de calidad quedó en 0 con el anexo 08-2026 (salió del modelo), pero la
  // variable sigue existiendo: basta darle peso en el mantenedor para reactivarla.
  const ajuste_rdh     = (cumple_rdh ? cruce_rdh          : 0) * peso_rdh      * factor_max;
  const ajuste_ces     = (cumple_ces ? cruce_cesantia     : 0) * peso_cesantia * factor_max;
  const ajuste_rep     = (cumple_rep ? cruce_reparaciones : 0) * peso_rep      * factor_max;
  const ajuste_calidad = calidad * (peso_calidad || 0) * factor_max;
  const factor_ajuste  = ajuste_rdh + ajuste_ces + ajuste_rep + ajuste_calidad;

  // Cada bono aplica su propio ajuste sobre el incentivo_base total
  const bono_rdh     = incentivo_base * ajuste_rdh;
  const bono_ces     = incentivo_base * ajuste_ces;
  const bono_rep     = incentivo_base * ajuste_rep;
  const bono_calidad = incentivo_base * ajuste_calidad;

  const incentivo_final = incentivo_base + bono_rdh + bono_ces + bono_rep + bono_calidad;
  const factor_sc = factorSemanaCorrida(mes, vars);

  return {
    cumple_minimo: true,
    total_creditos: otorgados.length,
    total_financiado,
    minimo_monto,
    monto_24: monto24, monto_mas24: montoMas24,
    base_24: base24, base_mas24: baseMas24,
    incentivo_base,
    ncnu_total, ncnu_rdh, ncnu_cesantia, ncnu_rep,
    cruce_rdh, cruce_cesantia, cruce_reparaciones,
    calidad, calidad_logrado: unidad_logrado, calidad_meta: META_UNIDAD,
    umbral_rdh, umbral_cesantia, umbral_rep,
    peso_rdh, peso_cesantia, peso_rep, peso_calidad,
    cumple_rdh, cumple_cesantia: cumple_ces, cumple_reparaciones: cumple_rep,
    ajuste_rdh, ajuste_cesantia: ajuste_ces, ajuste_reparaciones: ajuste_rep,
    ajuste_calidad, factor_ajuste,
    bono_rdh, bono_cesantia: bono_ces, bono_reparaciones: bono_rep, bono_calidad,
    incentivo_final,
    factor_semana_corrida: factor_sc,
    con_semana_corrida: incentivo_final * factor_sc,
  };
}


module.exports = { calcularComision, factorSemanaCorrida };
