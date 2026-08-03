'use strict';
/* Motor: shared/num-chile.js — lectura de montos en formato chileno.
   Este es EL test que habría evitado el incidente del 02-08-2026: la carga del
   Informe Canal leyó "320.118" como 320 y 22 operaciones quedaron con primas de
   $1 a $500 durante semanas. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { numeroCL, enteroCL } = require('../shared/num-chile');

test('el punto es separador de MILES, no decimal (el bug que costó dinero)', () => {
  assert.equal(enteroCL('320.118'), 320118);      // era 320
  assert.equal(enteroCL('307.000'), 307000);      // era 307
  assert.equal(enteroCL('1.109.286'), 1109286);   // era 1
  assert.equal(enteroCL('892.129'), 892129);
  assert.equal(enteroCL('1.028.266'), 1028266);
});

test('la coma es el separador DECIMAL', () => {
  assert.equal(numeroCL('1.234,56'), 1234.56);
  assert.equal(numeroCL('0,5'), 0.5);
  assert.equal(enteroCL('1.234,56'), 1235);       // entero = redondeo
  assert.equal(enteroCL('1.234,49'), 1234);
});

test('ignora símbolos de moneda, espacios y texto alrededor', () => {
  assert.equal(enteroCL('$ 892.129'), 892129);
  assert.equal(enteroCL('  7.161.289  '), 7161289);
  assert.equal(enteroCL('$1.500'), 1500);
});

test('respeta los números que Excel ya entrega numéricos', () => {
  assert.equal(enteroCL(892129), 892129);
  assert.equal(numeroCL(1234.56), 1234.56);
  assert.equal(enteroCL(0), 0);                   // el 0 explícito es un valor válido
});

test('negativos', () => {
  assert.equal(enteroCL('-1.500'), -1500);
  assert.equal(numeroCL('-1.234,50'), -1234.5);
});

test('devuelve null (nunca NaN) cuando no hay número que leer', () => {
  assert.equal(enteroCL(''), null);
  assert.equal(enteroCL('   '), null);
  assert.equal(enteroCL(null), null);
  assert.equal(enteroCL(undefined), null);
  assert.equal(enteroCL('S/I'), null);
  assert.equal(enteroCL('-'), null);
  assert.equal(numeroCL(NaN), null);
});

test('distingue vacío de cero — la regla de las primas', () => {
  // Regla de negocio: prima vacía = falta digitar; prima en $0 = no se contrató.
  assert.equal(enteroCL(''), null);
  assert.equal(enteroCL('0'), 0);
  assert.notEqual(enteroCL('0'), enteroCL(''));
});
