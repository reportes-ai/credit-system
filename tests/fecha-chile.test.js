'use strict';
const test = require('node:test');
const assert = require('node:assert');
const F = require('../shared/fecha-chile');

/* El caso que motivó el motor: de noche en Chile, toISOString() ya está en el
   día siguiente. 2026-08-16 01:30 UTC = 2026-08-15 21:30 en Chile. */
test('de noche en Chile, el día es el de Chile y no el de UTC', () => {
  const nocheDelQuince = new Date('2026-08-16T01:30:00Z');
  assert.strictEqual(nocheDelQuince.toISOString().slice(0, 10), '2026-08-16');  // lo que hacía mal
  assert.strictEqual(F.isoDe(nocheDelQuince), '2026-08-15');                    // lo correcto
});

test('durante el día no hay diferencia con UTC', () => {
  assert.strictEqual(F.isoDe(new Date('2026-08-15T18:00:00Z')), '2026-08-15');
});

test('una fecha suelta no retrocede un día al parsearse', () => {
  // new Date('2026-08-16') es medianoche UTC = 20:00 del 15 en Chile
  assert.strictEqual(F.isoDe(new Date('2026-08-16')), '2026-08-15');   // la trampa
  assert.strictEqual(F.isoDe(F.desdeISO('2026-08-16')), '2026-08-16'); // desdeISO la evita
});

test('sumar y restar días no se cae al día vecino', () => {
  assert.strictEqual(F.sumarDias('2026-08-15', 5), '2026-08-20');
  assert.strictEqual(F.sumarDias('2026-08-01', -1), '2026-07-31');
  assert.strictEqual(F.sumarDias('2026-12-31', 1), '2027-01-01');
});

test('restar meses respeta el día del mes', () => {
  assert.strictEqual(F.sumarMeses('2026-08-16', -6), '2026-02-16');
  assert.strictEqual(F.sumarMeses('2026-01-15', -1), '2025-12-15');
});

test('primer día del mes', () => {
  assert.strictEqual(F.primerDiaMes('2026-08-16'), '2026-08-01');
});

test('el fin del día cubre la jornada completa de una columna con hora', () => {
  assert.strictEqual(F.finDelDia('2026-07-31'), '2026-07-31 23:59:59.999999');
});

test('valores vacíos o basura devuelven null, no una fecha inventada', () => {
  assert.strictEqual(F.isoDe(null), null);
  assert.strictEqual(F.isoDe(''), null);
  assert.strictEqual(F.isoDe('no soy fecha'), null);
  assert.strictEqual(F.desdeISO('15/08/2026'), null);
});

test('hoyISO y mesActualISO tienen el formato esperado', () => {
  assert.match(F.hoyISO(), /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(F.mesActualISO(), F.hoyISO().slice(0, 7));
});
