'use strict';
/* Motor: api-gateway/public/js/rut-core.js — el RUT es la llave de identidad de
   clientes, dealers y usuarios. Un DV mal calculado o un formato que no calza
   parte a una persona en dos registros. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../api-gateway/public/js/rut-core');

test('forma canónica: sin puntos, con guion', () => {
  assert.equal(R.normalizar('12.345.678-5'), '12345678-5');
  assert.equal(R.normalizar('123456785'), '12345678-5');
  assert.equal(R.normalizar('12345678-5'), '12345678-5');
  assert.equal(R.normalizar('  12.345.678 - 5  '), '12345678-5');
});

test('el DV se calcula por módulo 11', () => {
  assert.equal(String(R.calcDV(12345678)), '5');
  assert.equal(String(R.calcDV(10000013)).toUpperCase(), 'K');   // el caso K
  assert.equal(String(R.calcDV(10000004)), '0');                 // el caso 0
});

test('validar: distingue DV correcto de incorrecto', () => {
  assert.equal(R.validar('12345678-5'), true);
  assert.equal(R.validar('12345678-9'), false);
  assert.equal(R.validar('10000013-K'), true);
  assert.equal(R.validar('10000013-k'), true);   // minúscula también vale
  assert.equal(R.validar('10000004-0'), true);
});

test('validar devuelve null (no false) cuando NO es un RUT', () => {
  // Distinción que importa: "no es RUT" no es lo mismo que "RUT inválido".
  // Los placeholders como S/I no deben tratarse como error de digitación.
  assert.equal(R.validar('S/I'), null);
  assert.equal(R.validar(''), null);
  assert.equal(R.validar(null), null);
});

test('normalizar no inventa: si no parece RUT devuelve null y no se toca el dato', () => {
  assert.equal(R.normalizar(''), null);
  assert.equal(R.normalizar('S/I'), null);
  assert.equal(R.normalizar(null), null);
});

test('formatear es solo para mostrar: agrega los puntos', () => {
  assert.equal(R.formatear('123456785'), '12.345.678-5');
  assert.equal(R.formatear('12345678-5'), '12.345.678-5');
});

test('cuerpo y DV por separado — espejo de las columnas generadas de la BD', () => {
  assert.equal(R.cuerpo('12.345.678-5'), 12345678);
  assert.equal(R.dv('12.345.678-5'), '5');
  assert.equal(R.cuerpo('10000013-K'), 10000013);
  assert.equal(String(R.dv('10000013-K')).toUpperCase(), 'K');
  assert.equal(R.cuerpo('S/I'), null);
});

test('el mismo RUT escrito de cuatro formas produce la MISMA llave', () => {
  // Es lo que evita que un cliente quede duplicado según cómo lo digitaron.
  const formas = ['12.345.678-5', '12345678-5', '123456785', ' 12.345.678 - 5 '];
  const llaves = new Set(formas.map(f => R.normalizar(f)));
  assert.equal(llaves.size, 1);
  assert.equal([...llaves][0], '12345678-5');
});
