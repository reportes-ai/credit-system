'use strict';
/* Motor: api-gateway/public/js/rentabilidad-core.js — cuota francesa, tabla de
   desarrollo y tramo UF. Lo usan el guardado de operación, el recálculo mensual,
   las cartas, el simulador y el cotizador: si acá cambia algo, cambia el dinero
   en cinco lugares a la vez. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../api-gateway/public/js/rentabilidad-core');

test('cuota francesa: caso conocido verificable a mano', () => {
  // $1.000.000 a 2% mensual en 12 cuotas. Fórmula: C·i·(1+i)^n / ((1+i)^n − 1)
  const esperado = 1000000 * 0.02 * Math.pow(1.02, 12) / (Math.pow(1.02, 12) - 1);
  assert.ok(Math.abs(R.cuotaFrancesa(1000000, 0.02, 12) - esperado) < 0.01);
  assert.equal(Math.round(R.cuotaFrancesa(1000000, 0.02, 12)), 94560);
});

test('cuota francesa: plazo 1 = capital + un período de interés', () => {
  assert.equal(Math.round(R.cuotaFrancesa(1000000, 0.02, 1)), 1020000);
});

test('cuota francesa: entradas inválidas devuelven 0, nunca NaN ni Infinity', () => {
  assert.equal(R.cuotaFrancesa(1000000, 0, 12), 0);      // sin tasa no hay cuota francesa
  assert.equal(R.cuotaFrancesa(0, 0.02, 12), 0);
  assert.equal(R.cuotaFrancesa(1000000, 0.02, 0), 0);
  assert.equal(R.cuotaFrancesa(null, null, null), 0);
  assert.equal(R.cuotaFrancesa('abc', 0.02, 12), 0);
});

test('tabla de desarrollo: amortiza el capital EXACTO y cierra en cero', () => {
  const t = R.tablaDesarrollo(1000000, 0.02, 3);
  assert.equal(t.length, 3);
  assert.equal(t.reduce((s, x) => s + x.amortizacion, 0), 1000000);  // sin peso perdido
  assert.equal(t[t.length - 1].saldo_insoluto, 0);                   // cierra en cero
});

test('tabla de desarrollo: el interés baja y la amortización sube', () => {
  const t = R.tablaDesarrollo(5000000, 0.018, 12);
  for (let i = 1; i < t.length; i++) {
    assert.ok(t[i].interes <= t[i - 1].interes, `interés subió en la cuota ${i + 1}`);
    assert.ok(t[i].amortizacion >= t[i - 1].amortizacion, `amortización bajó en la cuota ${i + 1}`);
  }
});

test('tabla de desarrollo con tasa 0: cuotas iguales, sin interés', () => {
  const t = R.tablaDesarrollo(1200000, 0, 12);   // caso real: OP 22086, tasa cero a 80 cuotas
  assert.equal(t.reduce((s, x) => s + x.interes, 0), 0);
  assert.equal(t.reduce((s, x) => s + x.amortizacion, 0), 1200000);
  assert.equal(t[t.length - 1].saldo_insoluto, 0);
});

test('valor presente de anualidad: es la inversa de la cuota francesa', () => {
  const cuota = R.cuotaFrancesa(1000000, 0.02, 12);
  assert.ok(Math.abs(R.valorPresenteAnualidad(cuota, 0.02, 12) - 1000000) < 1);
});

test('valor presente con tasa ~0: suma simple, sin descuento', () => {
  assert.equal(R.valorPresenteAnualidad(100000, 0, 12), 1200000);
});

test('tramo MAYOR/MENOR 200 UF: el umbral se evalúa con la UF entregada', () => {
  const uf = 39000;                                  // 200 UF = $7.800.000
  assert.equal(R.esMayor200({ montoCap: 7800001, uf }), true);
  assert.equal(R.esMayor200({ montoCap: 7800000, uf }), false);   // el umbral exacto NO es mayor
  assert.equal(R.esMayor200({ montoCap: 1000000, uf }), false);
});

test('tramo UF: sin UF no se puede clasificar y NO asume mayor', () => {
  assert.equal(R.esMayor200({ montoCap: 99000000, uf: 0 }), false);
  assert.equal(R.esMayor200({ montoCap: 99000000 }), false);
});

test('tramo UF: el umbral es parametrizable (mantenedor), no fijo en 200', () => {
  const uf = 39000;
  assert.equal(R.esMayor200({ montoCap: 4000000, uf, umbralUf: 100 }), true);   // 100 UF = 3,9M
  assert.equal(R.esMayor200({ montoCap: 4000000, uf, umbralUf: 200 }), false);
});
