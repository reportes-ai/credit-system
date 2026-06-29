'use strict';
/**
 * tasa-utils.js — MOTOR ÚNICO de derivación de tasas (mantenedor Tasas / sync CMF).
 *
 * La tasa la ingresa/sincroniza el usuario en formato ANUAL; de ahí se derivan los
 * campos que se guardan en la tabla `tasas`: la tasa MENSUAL (anual/12) y el spread
 * implícito ≤200 UF. Todo a 4 decimales (formato % de la tabla).
 *
 * Lo usan, con el MISMO criterio, para no divergir:
 *   - services/mantenedores/src/controllers/tasas.controller.js  (create / update)
 *   - services/mantenedores/src/tmc-sync.js                       (sincronización CMF)
 */

// Redondeo a 4 decimales (formato % de la tabla tasas).
const round4 = n => Math.round(n * 10000) / 10000;

// Tasa ANUAL (%) → tasa MENSUAL (%) = anual / 12, a 4 decimales. Acepta string o número.
const anualAMensual = anual => round4(parseFloat(anual) / 12);

// Spread implícito ≤200 UF: costo de fondo = mensual_mayor − spread_mayor, y el spread
// ≤200 = mensual_menor − costo_fondo  ⇒  spread_menor = mensual_menor − mensual_mayor + spread_mayor.
// Devuelve null si no hay spread_mayor (mismo criterio que el mantenedor).
const spreadMenor = (mensualMenor, mensualMayor, spreadMayor) =>
  spreadMayor === null ? null : round4(mensualMenor - mensualMayor + spreadMayor);

// Parsea el spread_mayor que viene del form (string / number / '' / null) → número o null.
const parseSpreadMayor = v =>
  (v !== undefined && v !== '' && v !== null && !isNaN(parseFloat(v))) ? parseFloat(v) : null;

module.exports = { round4, anualAMensual, spreadMenor, parseSpreadMayor };
