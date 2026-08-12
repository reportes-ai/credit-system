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
const baseDe = op => String(op || '').replace(/-[CR]\d+$/i, '');
const sufijo = (op, usados, letra) => {
  const base = baseDe(op);
  const set = new Set(usados.map(u => u.toUpperCase()));
  for (let n = 1; n <= 99; n++) { const c = `${base}-${letra}${n}`; if (!set.has(c.toUpperCase())) return c; }
  return null;
};
const siguiente = (op, usados) => sufijo(op, usados, 'C');
// Número de una carta NUEVA: libre se respeta; ocupado sale redigitada (-R).
const libre = (op, usados) => usados.includes(op) ? sufijo(op, usados, 'R') : op;

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

/* Redigitación (-R): cuando la carta de una operación muere (vence, se desiste, se
   anula o se rechaza), la operación se puede volver a digitar — es un flujo legítimo.
   Pero el número se arma como año + ID financiera + iniciales, así que el mismo
   ejecutivo redigitando producía el MISMO número y nacían duplicadas indistinguibles.
   Este fue el origen de los 22 duplicados limpiados el 12-08-2026. */
test('un número de carta libre se respeta tal cual, sin sufijo', () => {
  assert.equal(libre('26999999ZZ', ['266274695BB']), '26999999ZZ');
});

test('redigitar una operación cuya carta murió da -R1, no un duplicado', () => {
  assert.equal(libre('265313613TA', ['265313613TA']), '265313613TA-R1');
});

test('la segunda redigitación da -R2, no repite -R1', () => {
  assert.equal(libre('265313613TA', ['265313613TA', '265313613TA-R1']), '265313613TA-R2');
});

test('no encadena sufijos: redigitar una -R1 da -R2, nunca -R1-R1', () => {
  assert.equal(libre('265313613TA-R1', ['265313613TA', '265313613TA-R1']), '265313613TA-R2');
});

test('corrección y redigitación conviven sin pisarse (-C y -R por separado)', () => {
  const usados = ['265313613TA', '265313613TA-R1'];
  assert.equal(sufijo('265313613TA', usados, 'C'), '265313613TA-C1');   // la corrección no salta a -C2
  assert.equal(sufijo('265313613TA', usados, 'R'), '265313613TA-R2');
});

/* Buscador de la Corrección: se identifica una carta por cinco cosas distintas
   (N° de carta, N° de operación, ID de la financiera, RUT y nombre del cliente) y
   nadie escribe el RUT ni las tildes igual dos veces. */
const texto = s => String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const clave = s => String(s == null ? '' : s).toUpperCase().replace(/[^0-9A-Z]/g, '');

test('el RUT calza escrito de cualquier forma', () => {
  const guardado = clave('7031537-8');
  for (const escrito of ['7.031.537-8', '7031537-8', '70315378', '7.031.537 - 8'])
    assert.ok(guardado.includes(clave(escrito)), escrito);
});

test('el nombre calza sin tildes y sin importar mayúsculas', () => {
  const c = texto('José Guillermo Gutiérrez Vera');
  assert.ok(c.includes(texto('jose')));
  assert.ok(c.includes(texto('GUTIÉRREZ')));
  assert.ok(c.includes(texto('gutierrez')));
});

test('el N° de carta calza aunque tenga sufijo de corrección o redigitación', () => {
  assert.ok(clave('266274695BB-C1').includes(clave('266274695BB')));
  assert.ok(clave('266274695BB-R1').includes(clave('266274695bb')));
});

test('un RUT no se confunde con un número de carta', () => {
  // "465475" es el ID de la financiera de una carta; no debe traer RUTs que lo contengan por casualidad
  assert.ok(clave('26465475AS').includes(clave('465475')));
  assert.ok(!clave('7031537-8').includes(clave('465475')));
});

/* El saldo manda: la carta no puede decir un precio y un pie que no lo den.
   Es la validación que evita emitir una carta que se contradice a sí misma. */
test('precio menos pie tiene que seguir dando el saldo de la operación', () => {
  const cuadra = (precio, pie, saldo) => mismoNumero(precio - pie, saldo);
  assert.ok(cuadra(10380000, 4000000, 6380000));     // corrige precio y pie juntos: cuadra
  assert.ok(!cuadra(10500000, 4000000, 6380000));    // sube el precio y olvida el pie: no cuadra
});
