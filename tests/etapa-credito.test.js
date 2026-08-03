'use strict';
/* Motor: shared/etapa-credito.js — la etapa vive en TRES columnas y el sistema
   sufrió por escribirlas sueltas: la OP 89343 se veía otorgada en el listado
   pero quedaba fuera de vendedores, fundantes y cartolas; la OP 88558 mostraba
   como OTORGADO un crédito ANULADO. Estas pruebas fijan las invariantes que
   impiden que eso vuelva. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../shared/etapa-credito');

test('escribir la etapa toca SIEMPRE las tres columnas', () => {
  assert.equal(E.COLUMNAS.length, 3);
  for (const col of ['estado', 'estado_credito', 'estado_eval'])
    assert.ok(E.SET_ETAPA_SQL.includes(col), `${col} no está en el UPDATE`);
});

test('valoresEtapa entrega el mismo valor tres veces, normalizado', () => {
  assert.deepEqual(E.valoresEtapa('otorgado'), ['OTORGADO', 'OTORGADO', 'OTORGADO']);
  assert.deepEqual(E.valoresEtapa('  Aprobado  '), ['APROBADO', 'APROBADO', 'APROBADO']);
  // Los tres placeholders de SET_ETAPA_SQL calzan con los tres valores.
  assert.equal((E.SET_ETAPA_SQL.match(/\?/g) || []).length, E.valoresEtapa('X').length);
});

test('normalización: sin espacios y en mayúsculas', () => {
  assert.equal(E.norm('  otorgado '), 'OTORGADO');
  assert.equal(E.norm(null), '');
  assert.equal(E.norm(undefined), '');
});

test('las palabras de CARTERA no son etapa y se traducen a OTORGADO al leer', () => {
  // Un crédito "EN MORA" está, en etapa de originación, OTORGADO.
  const sql = E.ETAPA_SQL('c');
  for (const p of E.PALABRAS_CARTERA) assert.ok(sql.includes(`'${p}'`), `falta ${p} en el CASE`);
  assert.ok(/IN \([^)]*'EN MORA'[^)]*\)[\s\S]*?THEN 'OTORGADO'/.test(sql),
    'las palabras de cartera deben resolver a OTORGADO');
});

test('ETAPA_SQL respeta el alias que se le pasa', () => {
  assert.ok(E.ETAPA_SQL('c').includes('c.estado'));
  assert.ok(E.ETAPA_SQL('ob').includes('ob.estado'));
  assert.ok(!E.ETAPA_SQL('ob').includes('c.estado'));
});

test('ES_ETAPA compara contra la expresión canónica, no contra una columna suelta', () => {
  const cond = E.ES_ETAPA('otorgado', 'c');
  assert.ok(cond.includes(E.ETAPA_SQL('c')), 'debe apoyarse en ETAPA_SQL');
  assert.ok(cond.endsWith("= 'OTORGADO'"), 'debe comparar normalizado en mayúsculas');
});

test('ES_ETAPA normaliza la etapa recibida', () => {
  assert.ok(E.ES_ETAPA('  otorgado  ').endsWith("= 'OTORGADO'"));
});

test('SET_ESTADO_SQL no pisa una palabra de cartera ya guardada', () => {
  // Sincronizar desde una fuente externa no debe borrar el estado de cartera
  // de un crédito propio (esa es otra dimensión del dato).
  for (const p of E.PALABRAS_CARTERA) assert.ok(E.SET_ESTADO_SQL.includes(`'${p}'`));
  assert.ok(E.SET_ESTADO_SQL.includes('COALESCE(?, estado)'),
    'un valor NULL entrante no debe borrar el estado existente');
});
