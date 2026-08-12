'use strict';
/* Reglas de la Corrección de Cartas de Aprobación (services/cartas).
   Se prueban las funciones puras del motor: numeración con sufijo y el criterio
   de "mismo número" que decide si un campo bloqueado cambió de verdad.

   Contexto: corregir una carta emitida no la edita — emite una carta nueva y deja
   la anterior REEMPLAZADA. Para que la nueva pueda colgar del MISMO crédito, monto
   del crédito, saldo precio, tasa y cuotas tienen que quedar idénticos. */
const { test } = require('node:test');
const assert = require('node:assert/strict');

/* Copias de las funciones puras del controller (no se puede requerir el módulo:
   abre el pool de BD al cargar). Si cambian allá, este test debe cambiar acá. */
const mismoNumero = (a, b) => {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const x = Number(a), y = Number(b);
  if (isNaN(x) || isNaN(y)) return String(a).trim() === String(b).trim();
  return Math.abs(x - y) < 0.005;
};
const baseDe = op => String(op || '').replace(/-C\d+$/i, '');
const siguiente = (op, usados) => {
  const base = baseDe(op);
  const set = new Set(usados.map(u => u.toUpperCase()));
  for (let n = 1; n <= 99; n++) { const c = `${base}-C${n}`; if (!set.has(c.toUpperCase())) return c; }
  return null;
};

test('la corrección numera con sufijo -C1 sobre el número original', () => {
  assert.equal(siguiente('266274695BB', ['266274695BB']), '266274695BB-C1');
});

test('corregir una carta ya corregida sigue la serie, no la reinicia', () => {
  // la base es siempre la carta original: -C1 corregida da -C2, nunca -C1-C1
  assert.equal(siguiente('266274695BB-C1', ['266274695BB', '266274695BB-C1']), '266274695BB-C2');
  assert.equal(siguiente('266274695BB-C2', ['266274695BB', '266274695BB-C1', '266274695BB-C2']), '266274695BB-C3');
});

test('nunca reutiliza un número ya ocupado (no hay UNIQUE en op_carta)', () => {
  const usados = ['26634247LS', '26634247LS-C1', '26634247LS-C2', '26634247LS-C4'];
  assert.equal(siguiente('26634247LS', usados), '26634247LS-C3');   // toma el primer hueco libre
});

test('la comparación de montos tolera el redondeo de DECIMAL, no un cambio real', () => {
  assert.ok(mismoNumero('5280000', 5280000));        // string vs number: es el mismo saldo
  assert.ok(mismoNumero('16.000', 16));              // tasa DECIMAL(6,3) vs entero
  assert.ok(mismoNumero(2.8700, 2.87));
  assert.ok(!mismoNumero(5280000, 5280001));         // un peso de diferencia YA es otro monto
  assert.ok(!mismoNumero(48, 36));                   // cambio de cuotas
});

test('nulos: ausente y ausente es igual; ausente contra valor, no', () => {
  assert.ok(mismoNumero(null, null));
  assert.ok(!mismoNumero(null, 0));                  // "sin dato" no es "cero"
  assert.ok(!mismoNumero(5280000, null));
});

test('los textos se comparan como texto, sin convertirlos a número', () => {
  assert.ok(mismoNumero('AUTOFIN', 'AUTOFIN'));
  assert.ok(!mismoNumero('AUTOFIN', 'UNIDAD DE CREDITO'));
});

/* El saldo manda: la carta no puede decir un precio y un pie que no lo den.
   Es la validación que evita emitir una carta que se contradice a sí misma. */
test('precio menos pie tiene que seguir dando el saldo de la operación', () => {
  const cuadra = (precio, pie, saldo) => mismoNumero(precio - pie, saldo);
  assert.ok(cuadra(10380000, 4000000, 6380000));     // corrige precio y pie juntos: cuadra
  assert.ok(!cuadra(10500000, 4000000, 6380000));    // sube el precio y olvida el pie: no cuadra
});
