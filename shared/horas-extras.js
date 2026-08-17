'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   VALOR DE LA HORA EXTRAORDINARIA — motor único.

   Art. 32 del Código del Trabajo: las horas extraordinarias se pagan con un
   recargo de **50%** sobre el sueldo convenido para la jornada ordinaria.

   La fórmula que usa la Dirección del Trabajo para sueldo mensual:

       valor hora ordinaria = sueldo base × 7 ÷ (30 × jornada semanal)
       valor hora extra     = valor hora ordinaria × (1 + recargo)

   El 7/30 convierte el sueldo mensual a semanal (una semana de cada treinta
   días), y dividir por la jornada semanal da la hora. Con la jornada de 45 h y
   50% de recargo, eso da el factor clásico **0,0077778** del sueldo base; con
   las 44 h vigentes desde abril de 2026 (Ley 21.561) da 0,0079545. Por eso la
   jornada NO se escribe fija en el código: la ley la sigue bajando (42 h en
   2027, 40 h en 2028) y ese día esto se cambia en el mantenedor, no acá.

   QUÉ ENTRA EN LA BASE: el **sueldo base** pactado, no el total imponible. Los
   bonos, comisiones y gratificación no forman parte del sueldo convenido para
   la jornada ordinaria salvo pacto expreso; meterlos infla la hora extra y el
   error se repite todos los meses.

   ART. 22: los trabajadores excluidos de la limitación de jornada (gerentes,
   quienes prestan servicios sin fiscalización superior) **no generan horas
   extraordinarias**. Acá se responde `aplica: false` con su motivo — no se
   devuelve 0 en silencio, porque un 0 se lee como "sale gratis" y no como
   "esta persona no corresponde".
   ───────────────────────────────────────────────────────────────────────────── */

const JORNADA_SEMANAL_DEFAULT = 44;   // Ley 21.561, vigente desde el 26-04-2026
const RECARGO_PCT_DEFAULT     = 50;   // Art. 32 CT: mínimo legal

/**
 * Valor de UNA hora extraordinaria.
 * @param {object} p
 * @param {number} p.sueldoBase       sueldo base mensual ($)
 * @param {number} [p.jornadaSemanal] horas de la jornada ordinaria semanal
 * @param {number} [p.recargoPct]     recargo sobre la hora ordinaria (%)
 * @param {boolean} [p.art22]         excluido de la limitación de jornada
 * @returns {{aplica:boolean, motivo:string|null, valor_hora_ordinaria:number,
 *            valor_hora_extra:number, jornada_semanal:number, recargo_pct:number, factor:number}}
 */
function valorHoraExtra({ sueldoBase, jornadaSemanal, recargoPct, art22 } = {}) {
  const jornada = Number(jornadaSemanal) > 0 ? Number(jornadaSemanal) : JORNADA_SEMANAL_DEFAULT;
  const recargo = Number.isFinite(Number(recargoPct)) && Number(recargoPct) >= 0
    ? Number(recargoPct) : RECARGO_PCT_DEFAULT;
  const base = Math.round(Number(sueldoBase) || 0);

  const vacio = motivo => ({
    aplica: false, motivo, valor_hora_ordinaria: 0, valor_hora_extra: 0,
    jornada_semanal: jornada, recargo_pct: recargo, factor: 0,
  });

  if (art22) return vacio('Jornada del art. 22: excluido de la limitación de jornada, no genera horas extraordinarias.');
  if (base <= 0) return vacio('El colaborador no tiene sueldo base registrado en su ficha.');

  const horaOrdinaria = base * 7 / (30 * jornada);
  const horaExtra     = horaOrdinaria * (1 + recargo / 100);
  return {
    aplica: true, motivo: null,
    // Se redondea al peso recién acá: redondear la hora ordinaria antes
    // arrastraría el error a cada hora pagada.
    valor_hora_ordinaria: Math.round(horaOrdinaria),
    valor_hora_extra:     Math.round(horaExtra),
    jornada_semanal: jornada, recargo_pct: recargo,
    factor: 7 * (1 + recargo / 100) / (30 * jornada),   // el "0,0077778" de la tabla clásica
  };
}

/**
 * Monto a pagar por N horas extraordinarias.
 * Acepta medias horas (1,5 h) porque así se registran en la práctica.
 */
function montoHorasExtras(horas, params) {
  const v = valorHoraExtra(params);
  const h = Number(horas);
  if (!v.aplica || !Number.isFinite(h) || h <= 0) return { ...v, horas: 0, monto: 0 };
  /* El monto se calcula sobre el valor SIN redondear y se redondea al final:
     con el valor por hora ya redondeado, 20 horas podían quedar hasta $10 lejos
     de lo que dice la liquidación. */
  const exacto = (Number(params?.sueldoBase) || 0) * 7 / (30 * v.jornada_semanal)
                 * (1 + v.recargo_pct / 100) * h;
  return { ...v, horas: h, monto: Math.round(exacto) };
}

module.exports = { valorHoraExtra, montoHorasExtras, JORNADA_SEMANAL_DEFAULT, RECARGO_PCT_DEFAULT };
