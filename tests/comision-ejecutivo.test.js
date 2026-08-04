'use strict';
/* Comisión del ejecutivo comercial — shared/comision-ejecutivo.js
   Es la plata que llega al sueldo de una persona todos los meses, así que las
   reglas del anexo de contrato 08-2026 quedan fijadas acá: el piso, el tramo de
   24 cuotas exactas, los umbrales de cruce y la meta de calidad "todo o nada". */
const { test } = require('node:test');
const assert = require('node:assert');
const { calcularComision, factorSemanaCorrida } = require('../shared/comision-ejecutivo');

/* Parámetros del mantenedor (`comisiones_variables`) con los valores del seed.
   Se pasan explícitos para que la prueba no dependa de lo que haya en la BD. */
const VARS = {
  pct_24: 0.0075, pct_mas24: 0.0100,
  minimo_monto: 35000000, factor_max: 1,
  peso_rdh: 0.4, peso_cesantia: 0.3, peso_rep: 0.3, peso_calidad: 0,
  umbral_rdh: 0.5, umbral_cesantia: 0.5, umbral_rep: 0.5,
  semana_corrida: 1, semana_corrida_calc: 0,
  meta_unidad: 3,
};
const vars = extra => ({ ...VARS, ...extra });

// Crédito otorgado mínimo, sin seguros.
const op = (extra = {}) => ({
  estado_credito: 'OTORGADO', monto_financiado: 10000000, plazo: 36,
  financiera: 'AUTOFIN', producto: 'NCNU', ...extra,
});

test('bajo el mínimo del mes NO hay comisión, por mucho que haya vendido', () => {
  const r = calcularComision([op({ monto_financiado: 34999999 })], VARS, '2026-08');
  assert.strictEqual(r.cumple_minimo, false);
  assert.strictEqual(r.total_financiado, 34999999);
  assert.strictEqual(r.incentivo_final, undefined);   // ni siquiera se calcula
});

test('el mínimo se alcanza EN el monto exacto, no después', () => {
  const r = calcularComision([op({ monto_financiado: 35000000 })], VARS, '2026-08');
  assert.strictEqual(r.cumple_minimo, true);
});

test('solo suman los OTORGADOS: aprobados y rechazados no cuentan', () => {
  const creditos = [
    op({ monto_financiado: 40000000 }),
    op({ monto_financiado: 99000000, estado_credito: 'APROBADO' }),
    op({ monto_financiado: 99000000, estado_credito: 'RECHAZADO' }),
  ];
  const r = calcularComision(creditos, VARS, '2026-08');
  assert.strictEqual(r.total_creditos, 1);
  assert.strictEqual(r.total_financiado, 40000000);
});

test('tramo por plazo: 24 cuotas EXACTAS pagan la tasa mayor', () => {
  // El borde importa: antes 24 caía en la tasa menor y se pagaba de menos.
  const r24 = calcularComision([op({ monto_financiado: 40000000, plazo: 24 })], VARS, '2026-08');
  assert.strictEqual(r24.monto_mas24, 40000000);
  assert.strictEqual(r24.monto_24, 0);
  assert.strictEqual(r24.incentivo_base, 40000000 * 0.0100);   // 400.000

  const r23 = calcularComision([op({ monto_financiado: 40000000, plazo: 23 })], VARS, '2026-08');
  assert.strictEqual(r23.monto_24, 40000000);
  assert.strictEqual(r23.incentivo_base, 40000000 * 0.0075);   // 300.000
});

test('la base se calcula por tramo separado, no con una tasa promedio', () => {
  const creditos = [
    op({ monto_financiado: 20000000, plazo: 12 }),   // < 24 → 0,75%
    op({ monto_financiado: 20000000, plazo: 48 }),   // ≥ 24 → 1,00%
  ];
  const r = calcularComision(creditos, VARS, '2026-08');
  assert.strictEqual(r.base_24, 150000);
  assert.strictEqual(r.base_mas24, 200000);
  assert.strictEqual(r.incentivo_base, 350000);
});

test('el cruce de seguros bajo su umbral aporta CERO, no una parte', () => {
  // 1 de 4 operaciones con RDH = 25% de cruce, bajo el umbral de 50%.
  const creditos = [
    op({ monto_financiado: 10000000, seguro_rdh: 50000 }),
    op({ monto_financiado: 10000000 }), op({ monto_financiado: 10000000 }), op({ monto_financiado: 10000000 }),
  ];
  const r = calcularComision(creditos, VARS, '2026-08');
  assert.strictEqual(r.cruce_rdh, 0.25);
  assert.strictEqual(r.cumple_rdh, false);
  assert.strictEqual(r.bono_rdh, 0);
  assert.strictEqual(r.incentivo_final, r.incentivo_base);
});

test('el umbral se supera ESTRICTAMENTE: empatarlo no paga', () => {
  // 2 de 4 = 50% exacto, y la regla es "> umbral".
  const creditos = [
    op({ monto_financiado: 10000000, seguro_rdh: 50000 }),
    op({ monto_financiado: 10000000, seguro_rdh: 50000 }),
    op({ monto_financiado: 10000000 }), op({ monto_financiado: 10000000 }),
  ];
  const r = calcularComision(creditos, VARS, '2026-08');
  assert.strictEqual(r.cruce_rdh, 0.5);
  assert.strictEqual(r.cumple_rdh, false);
  assert.strictEqual(r.bono_rdh, 0);
});

test('superado el umbral, el bono es el cruce por su peso sobre la base', () => {
  // 3 de 4 con RDH = 75% > 50% → ajuste = 0,75 × 0,4 = 0,30
  const creditos = [
    op({ monto_financiado: 10000000, seguro_rdh: 50000 }),
    op({ monto_financiado: 10000000, seguro_rdh: 50000 }),
    op({ monto_financiado: 10000000, seguro_rdh: 50000 }),
    op({ monto_financiado: 10000000 }),
  ];
  const r = calcularComision(creditos, VARS, '2026-08');
  assert.strictEqual(r.cumple_rdh, true);
  assert.ok(Math.abs(r.ajuste_rdh - 0.30) < 1e-9);
  // Tolerancia de un peso: 0,75 × 0,4 no es exacto en punto flotante y el motor
  // no redondea acá a propósito (redondea el consumidor, al liquidar).
  assert.ok(Math.abs(r.bono_rdh - r.incentivo_base * 0.30) < 1);
  assert.ok(Math.abs(r.incentivo_final - r.incentivo_base * 1.30) < 1);
});

test('la base de medición de seguros (NCNU) excluye CORFO y lo que no es AUTOFIN', () => {
  const creditos = [
    op({ monto_financiado: 20000000, seguro_rdh: 50000 }),
    op({ monto_financiado: 20000000, producto: 'CORFO' }),                        // fuera de NCNU
    op({ monto_financiado: 20000000, financiera: 'UNIDAD DE CREDITO' }),          // fuera de NCNU
  ];
  const r = calcularComision(creditos, VARS, '2026-08');
  assert.strictEqual(r.ncnu_total, 1);
  assert.strictEqual(r.cruce_rdh, 1);        // la única NCNU trae RDH
  assert.strictEqual(r.total_creditos, 3);   // pero las tres sí suman al financiado
});

test('calidad es TODO O NADA: bajo la meta aporta 0, alcanzada aporta el 100%', () => {
  const conPeso = vars({ peso_calidad: 0.2 });
  const unidad = n => Array.from({ length: n }, () => op({ monto_financiado: 20000000, financiera: 'UNIDAD DE CREDITO' }));

  const dos = calcularComision(unidad(2), conPeso, '2026-08');
  assert.strictEqual(dos.calidad, 0);        // 2 de 3: no es "dos tercios", es cero
  assert.strictEqual(dos.bono_calidad, 0);

  const tres = calcularComision(unidad(3), conPeso, '2026-08');
  assert.strictEqual(tres.calidad, 1);
  assert.ok(Math.abs(tres.ajuste_calidad - 0.2) < 1e-9);
});

test('la meta de calidad sale del mantenedor, no está fija en 3', () => {
  const creditos = Array.from({ length: 4 }, () => op({ monto_financiado: 20000000, financiera: 'UNIDAD DE CREDITO' }));
  assert.strictEqual(calcularComision(creditos, vars({ meta_unidad: 4 }), '2026-08').calidad, 1);
  assert.strictEqual(calcularComision(creditos, vars({ meta_unidad: 5 }), '2026-08').calidad, 0);
});

test('factor_max acota cuánto pueden sumar los ajustes', () => {
  const creditos = [op({ monto_financiado: 40000000, seguro_rdh: 50000 })];
  const pleno  = calcularComision(creditos, VARS, '2026-08');
  const mitad  = calcularComision(creditos, vars({ factor_max: 0.5 }), '2026-08');
  assert.strictEqual(mitad.ajuste_rdh, pleno.ajuste_rdh / 2);
});

test('la semana corrida multiplica al final y es parametrizable', () => {
  const creditos = [op({ monto_financiado: 40000000, plazo: 24 })];
  const r = calcularComision(creditos, vars({ semana_corrida: 1.25 }), '2026-08');
  assert.strictEqual(r.factor_semana_corrida, 1.25);
  assert.strictEqual(r.con_semana_corrida, r.incentivo_final * 1.25);
});

test('con semana_corrida_calc apagado manda el multiplicador fijo del mantenedor', () => {
  // Sin este atajo el motor consultaría la tabla de feriados; acá se prueba el
  // camino puro, que es el que garantiza que el parámetro se respeta.
  assert.strictEqual(factorSemanaCorrida('2026-08', { semana_corrida_calc: 0, semana_corrida: 1.19 }), 1.19);
  assert.strictEqual(factorSemanaCorrida('2026-08', { semana_corrida_calc: 0 }), 1);
});

test('un mes sin operaciones no revienta: no cumple el mínimo y no hay comisión', () => {
  const r = calcularComision([], VARS, '2026-08');
  assert.strictEqual(r.cumple_minimo, false);
  assert.strictEqual(r.total_creditos, 0);
  assert.strictEqual(r.total_financiado, 0);
});
