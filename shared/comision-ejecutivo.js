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

/* ── Reglas de ESTRUCTURA del modelo (paramétricas desde el 07-09-2026) ──────────
   Además de tasas, pesos y umbrales, entre el modelo anterior y el anexo 08-2026
   cambiaron tres REGLAS. Para poder aplicar un modelo u otro según el mes (las
   variables tienen vigencia por mes), cada regla es un switch en comisiones_variables:
     tramo_24_tasa_menor   1 = plazo 24 exacto paga la tasa MENOR (modelo anterior: "≤ 24")
                           0 = 24 paga la tasa MAYOR (anexo 08-2026: "< 24 / ≥ 24")
     calidad_proporcional  1 = calidad = min(ops UNIDAD ÷ meta, 1) (modelo anterior)
                           0 = todo o nada: 100% si alcanza la meta, 0% si no (anexo)
     bono_sobre_base_total 1 = cada bono aplica sobre el incentivo base TOTAL (anterior)
                           0 = solo sobre la base de las ops que llevan ese seguro (19-08-2026)
   Default 0 (anexo vigente). Un modelo = un juego de variables + estos switches. */
const on = v => Number(v) > 0;
/** ¿El plazo cae en el tramo de la tasa menor (pct_24)? Motor único: lo usan el cálculo
 *  agregado, el reparto por crédito y los descuentos por prepago. */
function esPlazoMenor(plazo, vars) {
  const p = parseInt(plazo);
  return on(vars && vars.tramo_24_tasa_menor) ? p <= 24 : p < 24;
}

/* Meses ENTEROS de antigüedad al último día del mes de cálculo (fecha_ingreso YYYY-MM-DD).
   Ej.: ingreso 08-06 → en agosto (al 31-08) lleva 2 meses → todavía no cumple 3. */
function mesesAntiguedad(fechaIngreso, mes) {
  const fi = String(fechaIngreso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fi) || !/^\d{4}-\d{2}$/.test(mes || '')) return null;
  const [y, m, d] = fi.split('-').map(Number);
  const [my, mm] = mes.split('-').map(Number);
  const ultimo = new Date(my, mm, 0).getDate();
  let meses = (my - y) * 12 + (mm - m);
  if (ultimo < d) meses -= 1;          // el "mes" aún no se completa al fin de mes
  return Math.max(0, meses);
}

function calcularComision(creditos, vars, mes, opts = {}) {
  const {
    pct_24, pct_mas24, minimo_monto, factor_max,
    peso_rdh, peso_cesantia, peso_rep, peso_calidad,
    umbral_rdh, umbral_cesantia, umbral_rep, semana_corrida,
    meta_unidad,
  } = vars;
  const calidadProporcional = on(vars.calidad_proporcional);
  const bonoSobreBaseTotal  = on(vars.bono_sobre_base_total);

  const otorgados = creditos.filter(c => (c.estado_credito || '').toUpperCase() === 'OTORGADO');

  // Total financiado (todos los OTORGADOS)
  const total_financiado = otorgados.reduce((s, c) => s + (parseFloat(c.monto_financiado) || 0), 0);

  /* Piso del mes: quien lleva menos de `minimo_meses_exencion` meses en la empresa (3 por
     defecto, paramétrico) NO está acogido al mínimo — comisiona desde la primera op
     (Pato, 08-09-2026; así la planilla pagó a Fabián y Bárbara en junio). */
  const mesesEx = Number(vars.minimo_meses_exencion);
  const antig = opts.fecha_ingreso ? mesesAntiguedad(opts.fecha_ingreso, mes) : null;
  const exento_minimo = (mesesEx > 0 && antig != null && antig < mesesEx)
    ? { fecha_ingreso: String(opts.fecha_ingreso).slice(0, 10), meses: antig, meses_exencion: mesesEx } : null;
  if (!exento_minimo && total_financiado < minimo_monto) {
    return { cumple_minimo: false, total_creditos: otorgados.length, total_financiado, minimo_monto };
  }

  // Split por plazo — anexo 08-2026: MENOR a 24 = pct_24; IGUAL O MAYOR a 24 = pct_mas24.
  // Con tramo_24_tasa_menor = 1 (modelo anterior) el 24 exacto cae en la tasa menor.
  const ot24    = otorgados.filter(c =>  esPlazoMenor(c.plazo, vars));
  const otMas24 = otorgados.filter(c => !esPlazoMenor(c.plazo, vars));
  const monto24    = ot24.reduce((s, c) => s + (parseFloat(c.monto_financiado) || 0), 0);
  const montoMas24 = otMas24.reduce((s, c) => s + (parseFloat(c.monto_financiado) || 0), 0);

  const base24    = monto24    * pct_24;
  const baseMas24 = montoMas24 * pct_mas24;
  const incentivo_base = base24 + baseMas24;

  // NCNU: AUTOFIN, no CORFO, no UNIDAD — los créditos susceptibles de llevar
  // estos seguros. Es la base de medición del cumplimiento Y la única base
  // sobre la que se pagan los bonos (corrección 19-08-2026).
  const ncnu = otorgados.filter(c =>
    (c.financiera || '').toUpperCase() === 'AUTOFIN' &&
    !(c.producto || '').toUpperCase().includes('CORFO') &&
    !(c.producto || '').toUpperCase().includes('UNIDAD')
  );
  // Cesantía: los clientes INDEPENDIENTES no son asegurables (el seguro cubre
  // cesantía de dependientes) → salen de la BASE del cruce de cesantía. La marca
  // es manual por operación (creditos.cliente_independiente, desde Revisión).
  const ncnuCes = ncnu.filter(c => !Number(c.cliente_independiente || 0));
  const conRdh = ncnu.filter(c => (parseFloat(c.seguro_rdh)       || 0) > 0);
  const conCes = ncnuCes.filter(c => (parseFloat(c.seguro_cesantia)  || 0) > 0);
  const conRep = ncnu.filter(c => (parseFloat(c.seguro_rep_menor) || 0) > 0);
  const ncnu_total    = ncnu.length;
  const ncnu_ces_base = ncnuCes.length;
  const ncnu_rdh      = conRdh.length;
  const ncnu_cesantia = conCes.length;
  const ncnu_rep      = conRep.length;

  const cruce_rdh          = ncnu_total > 0 ? ncnu_rdh      / ncnu_total : 0;
  const cruce_cesantia     = ncnu_ces_base > 0 ? ncnu_cesantia / ncnu_ces_base : 0;
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
  // Con calidad_proporcional = 1 (modelo anterior) vuelve a ser ops ÷ meta, topado en 1.
  const calidad        = calidadProporcional ? Math.min(unidad_logrado / META_UNIDAD, 1)
                                             : (unidad_logrado >= META_UNIDAD ? 1 : 0);

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

  // Cada bono aplica su ajuste SOLO sobre la base de las operaciones que llevan
  // ese seguro (las mismas con que se midió el cumplimiento), no sobre el
  // incentivo_base total (corrección 19-08-2026). La base de cada operación es
  // su monto financiado por la tasa de su tramo de plazo.
  // Con bono_sobre_base_total = 1 (modelo anterior) cada bono aplica sobre el incentivo base total.
  const baseDe = ops => bonoSobreBaseTotal ? incentivo_base : ops.reduce((s, c) =>
    s + (parseFloat(c.monto_financiado) || 0) * (esPlazoMenor(c.plazo, vars) ? pct_24 : pct_mas24), 0);
  const base_rdh = baseDe(conRdh);
  const base_ces = baseDe(conCes);
  const base_rep = baseDe(conRep);
  const bono_rdh     = base_rdh * ajuste_rdh;
  const bono_ces     = base_ces * ajuste_ces;
  const bono_rep     = base_rep * ajuste_rep;
  const bono_calidad = incentivo_base * ajuste_calidad;

  const incentivo_final = incentivo_base + bono_rdh + bono_ces + bono_rep + bono_calidad;
  const factor_sc = factorSemanaCorrida(mes, vars);

  return {
    cumple_minimo: true,
    exento_minimo,
    total_creditos: otorgados.length,
    total_financiado,
    minimo_monto,
    monto_24: monto24, monto_mas24: montoMas24,
    base_24: base24, base_mas24: baseMas24,
    pct_24, pct_mas24,
    n_24: ot24.length, n_mas24: otMas24.length,
    incentivo_base,
    ncnu_total, ncnu_rdh, ncnu_cesantia, ncnu_rep, ncnu_ces_base,
    cruce_rdh, cruce_cesantia, cruce_reparaciones,
    calidad, calidad_logrado: unidad_logrado, calidad_meta: META_UNIDAD,
    umbral_rdh, umbral_cesantia, umbral_rep,
    peso_rdh, peso_cesantia, peso_rep, peso_calidad,
    cumple_rdh, cumple_cesantia: cumple_ces, cumple_reparaciones: cumple_rep,
    ajuste_rdh, ajuste_cesantia: ajuste_ces, ajuste_reparaciones: ajuste_rep,
    ajuste_calidad, factor_ajuste,
    base_rdh, base_cesantia: base_ces, base_reparaciones: base_rep,
    bono_rdh, bono_cesantia: bono_ces, bono_reparaciones: bono_rep, bono_calidad,
    incentivo_final,
    factor_semana_corrida: factor_sc,
    con_semana_corrida: incentivo_final * factor_sc,
    reglas: { tramo_24_tasa_menor: on(vars.tramo_24_tasa_menor), calidad_proporcional: calidadProporcional, bono_sobre_base_total: bonoSobreBaseTotal },
  };
}


module.exports = { calcularComision, factorSemanaCorrida, esPlazoMenor, mesesAntiguedad };
