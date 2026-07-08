'use strict';
/**
 * tasa-utils.js — MOTOR ÚNICO de derivación de tasas (mantenedor Tasas / sync CMF).
 *
 * La tasa la ingresa/sincroniza el usuario en formato ANUAL; de ahí se derivan los
 * campos que se guardan en la tabla `tasas`: la tasa MENSUAL (anual/12) y el spread
 * implícito ≤200 UF. Todo a 3 decimales (v101.2: antes 4 — regla de negocio,
 * se calcula y almacena con 3, igual que se muestra).
 *
 * Lo usan, con el MISMO criterio, para no divergir:
 *   - services/mantenedores/src/controllers/tasas.controller.js  (create / update)
 *   - services/mantenedores/src/tmc-sync.js                       (sincronización CMF)
 */

// Redondeo a 3 decimales HACIA ABAJO (regla de negocio: nunca redondear la tasa hacia arriba).
const round3 = n => Math.floor(n * 1000) / 1000;

// Tasa ANUAL (%) → tasa MENSUAL (%) = anual / 12, a 3 decimales. Acepta string o número.
const anualAMensual = anual => round3(parseFloat(anual) / 12);

// Spread implícito ≤200 UF: costo de fondo = mensual_mayor − spread_mayor, y el spread
// ≤200 = mensual_menor − costo_fondo  ⇒  spread_menor = mensual_menor − mensual_mayor + spread_mayor.
// Devuelve null si no hay spread_mayor (mismo criterio que el mantenedor).
const spreadMenor = (mensualMenor, mensualMayor, spreadMayor) =>
  spreadMayor === null ? null : round3(mensualMenor - mensualMayor + spreadMayor);

// Parsea el spread_mayor que viene del form (string / number / '' / null) → número o null,
// redondeado a 3 decimales.
const parseSpreadMayor = v =>
  (v !== undefined && v !== '' && v !== null && !isNaN(parseFloat(v))) ? round3(parseFloat(v)) : null;

module.exports = { round3, round4: round3, anualAMensual, spreadMenor, parseSpreadMayor };
