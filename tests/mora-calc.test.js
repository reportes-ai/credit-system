'use strict';
/* El DINERO de la mora — shared/mora-calc.js
   (mora-core.test.js prueba los DÍAS de mora; esto prueba cuánto cuestan.)

   Dos magnitudes distintas que no se fusionan:
     · interés por mora  = diario simple sobre la cuota, a la TMC;
     · gasto de cobranza = tramos MARGINALES sobre la deuda en UF.
   Ambas se le cobran a un cliente, así que las reglas legales que las sostienen
   —Ley 18.010 art. 16 y la cláusula 6.1 del contrato— quedan fijadas acá. */
const { test } = require('node:test');
const assert = require('node:assert');
const { calcularGastoCobranza, calcularInteresMora, moraFechaFija, addDias } = require('../shared/mora-calc');

/* TMC por rango de fechas, como vienen de la tabla `tasas`. La de agosto es más
   alta que la de junio a propósito: así se ve cuál se usó. */
const TASAS = [
  { fecha_desde: '2026-06-01', fecha_hasta: '2026-06-30', tasa_mensual_menor: 2.4, tasa_mensual_mayor: 1.8 },
  { fecha_desde: '2026-07-01', fecha_hasta: '2026-07-31', tasa_mensual_menor: 3.0, tasa_mensual_mayor: 2.0 },
  { fecha_desde: '2026-08-01', fecha_hasta: '2026-08-31', tasa_mensual_menor: 3.6, tasa_mensual_mayor: 2.2 },
];

// ─── Interés por mora ─────────────────────────────────────────────────────────

test('el día 1 de mora es el SIGUIENTE al vencimiento, no el del vencimiento', () => {
  const mismoDia = calcularInteresMora(300000, '2026-07-10', '2026-07-10', 'menor', TASAS, null);
  assert.strictEqual(mismoDia.dias, 0);
  assert.strictEqual(mismoDia.interes, 0);      // pagar el día del vencimiento no devenga mora

  const alDiaSiguiente = calcularInteresMora(300000, '2026-07-10', '2026-07-11', 'menor', TASAS, null);
  assert.strictEqual(alDiaSiguiente.dias, 1);
});

test('el interés es diario simple: TMC mensual dividida en 30', () => {
  // 10 días al 3,0% mensual sobre una cuota de 300.000
  const r = calcularInteresMora(300000, '2026-07-10', '2026-07-20', 'menor', TASAS, null);
  assert.strictEqual(r.dias, 10);
  assert.strictEqual(r.interes, Math.round(300000 * 0.03 / 30 * 10));   // 3.000
});

test('el tramo MAYOR de 200 UF usa su propia columna de TMC', () => {
  const menor = calcularInteresMora(300000, '2026-07-10', '2026-07-20', 'menor', TASAS, null);
  const mayor = calcularInteresMora(300000, '2026-07-10', '2026-07-20', 'mayor', TASAS, null);
  assert.strictEqual(mayor.interes, Math.round(300000 * 0.02 / 30 * 10));   // 2,0% en vez de 3,0%
  assert.ok(mayor.interes < menor.interes);
});

test('TMC FIJA al otorgamiento: la mora se cobra a la tasa pactada, no a la de hoy', () => {
  // Contrato 6.1 + Ley 18.010 art. 16: el interés máximo convencional se pacta al
  // originar. El crédito se otorgó en junio (2,4%) y la mora corre en agosto (3,6%):
  // se debe cobrar la de JUNIO.
  const r = calcularInteresMora(300000, '2026-07-31', '2026-08-10', 'menor', TASAS, '2026-06-15');
  assert.strictEqual(r.dias, 10);
  assert.strictEqual(r.interes, Math.round(300000 * 0.024 / 30 * 10));
  assert.strictEqual(r.detalle.length, 1);                 // una sola tasa en todo el período
  assert.strictEqual(r.detalle[0].tmc_mensual, 2.4);
});

test('modo variable: cada día de mora usa la TMC de SU mes', () => {
  // Sin fecha de tasa fija, la mora que cruza de julio a agosto cambia de tasa.
  const r = calcularInteresMora(300000, '2026-07-29', '2026-08-02', 'menor', TASAS, null);
  assert.strictEqual(r.dias, 4);                            // 30 y 31 de julio + 1 y 2 de agosto
  assert.strictEqual(r.detalle.length, 2);                  // dos tramos de tasa
  const esperado = 300000 * 0.03 / 30 * 2 + 300000 * 0.036 / 30 * 2;
  assert.strictEqual(r.interes, Math.round(esperado));
});

test('si a la fecha de otorgamiento no hay TMC cargada, cae a variable en vez de cobrar cero', () => {
  // Historia incompleta (créditos migrados): otorgado en 2019, sin tasa en la tabla.
  const r = calcularInteresMora(300000, '2026-07-10', '2026-07-20', 'menor', TASAS, '2019-03-01');
  assert.strictEqual(r.interes, Math.round(300000 * 0.03 / 30 * 10));   // usó la del período
  assert.ok(r.interes > 0, 'una historia incompleta no puede regalar la mora');
});

test('sin cuota o sin vencimiento no se inventa interés', () => {
  assert.deepStrictEqual(calcularInteresMora(0, '2026-07-10', '2026-07-20', 'menor', TASAS, null), { dias: 0, interes: 0, detalle: [] });
  assert.deepStrictEqual(calcularInteresMora(300000, null, '2026-07-20', 'menor', TASAS, null), { dias: 0, interes: 0, detalle: [] });
});

test('sin tabla de tasas el interés es cero, no NaN', () => {
  const r = calcularInteresMora(300000, '2026-07-10', '2026-07-20', 'menor', [], null);
  assert.strictEqual(r.interes, 0);
  assert.strictEqual(r.dias, 10);   // los días sí corrieron: el dato queda visible
});

// ─── Gasto de cobranza ────────────────────────────────────────────────────────

/* Tramos del mantenedor: como la tabla del impuesto a la renta, cada porción de
   la deuda paga SU porcentaje. El último tramo (sin tope) cubre el resto. */
const TRAMOS = [
  { hasta_uf: 10,   pct: 9 },
  { hasta_uf: 50,   pct: 6 },
  { hasta_uf: null, pct: 3 },
];
const UF = 40000;

test('los tramos son MARGINALES: no se aplica el % del tramo a toda la deuda', () => {
  // Deuda de 20 UF: 10 UF al 9% + 10 UF al 6% = 0,9 + 0,6 = 1,5 UF
  const r = calcularGastoCobranza(20 * UF, UF, TRAMOS);
  assert.strictEqual(r.deuda_uf, 20);
  assert.ok(Math.abs(r.gasto_uf - 1.5) < 1e-9);
  assert.strictEqual(r.gasto_pesos, Math.round(1.5 * UF));   // 60.000
  assert.notStrictEqual(r.gasto_pesos, Math.round(20 * UF * 0.06));
});

test('una deuda dentro del primer tramo paga solo ese porcentaje', () => {
  const r = calcularGastoCobranza(5 * UF, UF, TRAMOS);
  assert.ok(Math.abs(r.gasto_uf - 0.45) < 1e-9);
  assert.strictEqual(r.detalle.length, 1);
});

test('el último tramo sin tope absorbe el resto de la deuda', () => {
  // 100 UF: 10 al 9% + 40 al 6% + 50 al 3% = 0,9 + 2,4 + 1,5 = 4,8 UF
  const r = calcularGastoCobranza(100 * UF, UF, TRAMOS);
  assert.ok(Math.abs(r.gasto_uf - 4.8) < 1e-9);
  assert.strictEqual(r.detalle.length, 3);
});

test('el gasto crece con la deuda, sin saltos en los bordes de tramo', () => {
  const g = uf => calcularGastoCobranza(uf * UF, UF, TRAMOS).gasto_uf;
  assert.ok(g(9.99) < g(10));
  assert.ok(Math.abs(g(10.01) - g(10)) < 0.001, 'cruzar el borde no puede dar un salto');
  assert.ok(g(49) < g(50) && g(50) < g(51));
});

test('sin UF del día no se cobra gasto: no se estima con una UF inventada', () => {
  const r = calcularGastoCobranza(20 * 40000, 0, TRAMOS);
  assert.strictEqual(r.gasto_pesos, 0);
  assert.strictEqual(r.deuda_uf, 0);
});

test('sin tramos configurados el gasto es cero, no NaN', () => {
  assert.strictEqual(calcularGastoCobranza(20 * UF, UF, []).gasto_pesos, 0);
  assert.strictEqual(calcularGastoCobranza(20 * UF, UF, null).gasto_pesos, 0);
});

// ─── Parámetros y fechas ──────────────────────────────────────────────────────

test('el modo de tasa sale del mantenedor: fija por defecto, variable si se pide', () => {
  assert.strictEqual(moraFechaFija({ mora_tasa_modo: 'fija_otorgamiento' }, '2026-06-15'), '2026-06-15');
  assert.strictEqual(moraFechaFija({ mora_tasa_modo: 'variable' }, '2026-06-15'), null);
  assert.strictEqual(moraFechaFija({}, '2026-06-15'), '2026-06-15');   // sin config: fija
  assert.strictEqual(moraFechaFija(null, '2026-06-15'), '2026-06-15');
});

test('el umbral de gastos: el día 20 de mora no los habilita, el 21 sí', () => {
  // `gastos_dias` = 21 en el mantenedor. La UF se fija en venc + 21 días.
  const GASTOS_DIAS = 21;
  const venc = '2026-07-10';
  const dias = f => calcularInteresMora(300000, venc, f, 'menor', TASAS, null).dias;
  assert.ok(dias('2026-07-30') < GASTOS_DIAS, 'al día 20 todavía no aplican gastos');
  assert.ok(dias('2026-07-31') >= GASTOS_DIAS, 'al día 21 ya aplican');
  assert.strictEqual(addDias(venc, GASTOS_DIAS), '2026-07-31');
});

test('addDias cruza fin de mes y fin de año sin correrse por el huso horario', () => {
  assert.strictEqual(addDias('2026-01-31', 1), '2026-02-01');
  assert.strictEqual(addDias('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(addDias('2028-02-28', 1), '2028-02-29');   // bisiesto
  assert.strictEqual(addDias('2026-07-10', 0), '2026-07-10');
});
