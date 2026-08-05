'use strict';
/* Motor: api-gateway/public/js/mora-core.js — días de mora, cuotas vencidas y
   estado de cartera. De acá salen los gastos de cobranza, el interés por mora,
   los tramos de cobranza y las provisiones: es el motor con más consecuencias
   legales del sistema (Ley 21.320 regula qué se le puede cobrar y cuándo). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../api-gateway/public/js/mora-core');

// El calendario congelado usa `valor_cuota` (así viene de cuotas_credito)
const CAL = (venc) => venc.map((fecha, i) => ({ numero_cuota: i + 1, fecha_vencimiento: fecha, valor_cuota: 100000 }));

test('clasificación por días: los umbrales por defecto', () => {
  assert.equal(M.UMBRALES_DEFAULT.mora, 1);
  assert.equal(M.UMBRALES_DEFAULT.vencido, 91);
  assert.equal(M.clasificarPorDias(0), 'VIGENTE');
  assert.equal(M.clasificarPorDias(1), 'EN MORA');  // el día 1 ya es mora
  assert.equal(M.clasificarPorDias(90), 'EN MORA');
  assert.equal(M.clasificarPorDias(91), 'VENCIDO');   // el 91 cruza a vencido
});

test('los umbrales son parametrizables (mantenedor), no fijos', () => {
  const u = { mora: 5, vencido: 60 };
  assert.equal(M.clasificarPorDias(3, u), 'VIGENTE');
  assert.equal(M.clasificarPorDias(5, u), 'EN MORA');
  assert.equal(M.clasificarPorDias(60, u), 'VENCIDO');
});

test('sin cuotas vencidas el crédito está VIGENTE y con cero días', () => {
  const r = M.estadoMora({
    calendario: CAL(['2026-09-05', '2026-10-05', '2026-11-05']),
    pagadas: [], hoy: '2026-08-03',
  });
  assert.equal(r.estado, 'VIGENTE');
  assert.equal(r.dias, 0);
  assert.equal(r.cuotas_mora, 0);
});

test('los días de mora se cuentan desde la cuota impaga MÁS ANTIGUA', () => {
  const r = M.estadoMora({
    calendario: CAL(['2026-07-05', '2026-08-01', '2026-09-05']),
    pagadas: [], hoy: '2026-08-03',
  });
  assert.equal(r.cuotas_mora, 2);            // la de julio y la del 1 de agosto
  assert.equal(r.oldest_n, 1);               // la más antigua manda
  assert.equal(r.dias, 29);                  // 05-07 → 03-08
  assert.equal(r.monto_mora, 200000);
});

test('una cuota pagada NO cuenta como mora aunque esté vencida', () => {
  const r = M.estadoMora({
    calendario: CAL(['2026-07-05', '2026-08-01', '2026-09-05']),
    pagadas: [1], hoy: '2026-08-03',
  });
  assert.equal(r.cuotas_mora, 1);
  assert.equal(r.oldest_n, 2);               // ahora la más antigua impaga es la 2
  assert.equal(r.dias, 2);                   // 01-08 → 03-08
});

test('el día exacto del vencimiento todavía NO es mora', () => {
  const r = M.estadoMora({ calendario: CAL(['2026-08-03']), pagadas: [], hoy: '2026-08-03' });
  assert.equal(r.dias, 0);
  assert.equal(r.estado, 'VIGENTE');
});

test('el umbral de 21 días de los gastos de cobranza cae del lado correcto', () => {
  // Regla legal: los gastos de cobranza solo proceden desde el día 21 de mora.
  const dias = (hoy) => M.estadoMora({ calendario: CAL(['2026-07-05']), pagadas: [], hoy }).dias;
  assert.equal(dias('2026-07-25'), 20);      // día 20: SIN gastos
  assert.equal(dias('2026-07-26'), 21);      // día 21: recién con gastos
});

test('todo pagado DESPUÉS del último vencimiento = TERMINADO', () => {
  const r = M.estadoMora({
    calendario: CAL(['2026-06-05', '2026-07-05']), pagadas: [1, 2], hoy: '2026-08-03',
  });
  assert.equal(r.estado, 'TERMINADO');
  assert.equal(r.cuotas_mora, 0);
  assert.equal(r.dias, 0);
  assert.equal(r.pagadas_count, 2);
});

test('todo pagado ANTES del último vencimiento = PREPAGADO', () => {
  // Regla de negocio: pagar por adelantado no es lo mismo que terminar el plan.
  const r = M.estadoMora({
    calendario: CAL(['2026-09-05', '2026-10-05']), pagadas: [1, 2], hoy: '2026-08-03',
  });
  assert.equal(r.estado, 'PREPAGADO');
  assert.equal(r.cuotas_mora, 0);
});

test('sin calendario no inventa un estado: devuelve null', () => {
  assert.equal(M.estadoMora({ calendario: [], pagadas: [] }), null);
  assert.equal(M.estadoMora({}), null);
});

test('el calendario CONGELADO manda por sobre la cuota teórica', () => {
  // Si viene calendario real (cuotas_credito), se usa ese y no se recalcula.
  const r = M.estadoMora({
    calendario: CAL(['2026-07-05']), plazo: 24, cuota: 999999,
    fecha_primera_cuota: '2020-01-01', pagadas: [], hoy: '2026-08-03',
  });
  assert.equal(r.schedule.length, 1, 'debe usar el calendario entregado, no el teórico');
  assert.equal(r.monto_mora, 100000, 'debe usar el monto del calendario, no la cuota teórica');
});
