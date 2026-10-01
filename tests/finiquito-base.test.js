'use strict';
/* BASE DE LAS INDEMNIZACIONES (art. 172 CT) Y RETENCIÓN DE ALIMENTOS EN EL FINIQUITO (art. 13 Ley 14.908).

   Las dos cosas se pagan una sola vez y delante de un ministro de fe: un error no se corrige el mes siguiente.
   · La base: la DT incluye colación y movilización habituales y deja fuera horas extras y aguinaldos. Con el
     imponible a secas (como estuvo hasta el 01-10-2026) un finiquito de octubre arrastraba el aguinaldo de
     Fiestas Patrias y dejaba fuera la movilización.
   · La retención: no hacerla expone a multa del doble y a responder solidariamente por la pensión. */
const { test } = require('node:test');
const assert = require('node:assert');
const { DEF_BASE, lista, coincide, ajusteArt172, base172DelMes, retencionAlimentos } = require('../shared/finiquito-base');

const P = { excluye: lista(DEF_BASE.finiq_base_excluye), noImp: lista(DEF_BASE.finiq_base_no_imp) };

test('la lista por defecto deja fuera horas extras y aguinaldos, y no agrega no imponibles', () => {
  assert.deepEqual(P.excluye, ['HORAS EXTRAS', 'AGUINALDO', 'BONO NAVIDAD', 'BONO VACACIONES']);
  assert.deepEqual(P.noImp, []);
});

test('se compara por "contiene", sin tildes ni mayúsculas', () => {
  assert.ok(coincide('Aguinaldo Fiestas Patrias', P.excluye));
  assert.ok(coincide('Horas Extras (12/30 días)', P.excluye));
  assert.ok(coincide('ASIGNACIÓN CELULAR', lista('asignacion celular')));
  assert.ok(!coincide('Bono Por Meta', P.excluye));
  assert.ok(!coincide('', P.excluye));
});

test('horas extras y aguinaldo salen de la base; el bono por meta se queda', () => {
  const items = [
    { nombre: 'Horas Extras', monto: 80000, imponible: true },
    { nombre: 'Aguinaldo Fiestas Patrias', monto: 87000, imponible: true },
    { nombre: 'Bono Por Meta', monto: 150000, imponible: true },
    { nombre: 'Asignacion Celular', monto: 20000, imponible: false },
  ];
  assert.deepEqual(ajusteArt172(items, P), { excluidos: 167000, no_imp_lista: 0 });
});

test('un no imponible entra solo si el Administrador lo lista como habitual', () => {
  const items = [{ nombre: 'Asignacion Celular', monto: 20000, imponible: false }, { nombre: 'Viático', monto: 50000, imponible: false }];
  assert.equal(ajusteArt172(items, { excluye: P.excluye, noImp: lista('ASIGNACION CELULAR') }).no_imp_lista, 20000);
  assert.equal(ajusteArt172(items, P).no_imp_lista, 0);
});

test('un concepto imponible nunca entra por la lista de no imponibles, ni al revés', () => {
  const cruzadas = { excluye: lista('ASIGNACION CELULAR'), noImp: lista('HORAS EXTRAS') };
  const items = [{ nombre: 'Horas Extras', monto: 80000, imponible: true }, { nombre: 'Asignacion Celular', monto: 20000, imponible: false }];
  assert.deepEqual(ajusteArt172(items, cruzadas), { excluidos: 0, no_imp_lista: 0 });
});

test('base del mes = imponible − excluidos + colación y movilización', () => {
  // Septiembre: imponible 1.500.000 con aguinaldo de 87.000; movilización 45.000
  assert.deepEqual(base172DelMes({ imponible: 1500000, excluidos: 87000, no_imponibles: 45000 }), { excluidos: 87000, base_172: 1458000 });
  // Mes sin nada especial: la base sube exactamente en lo no imponible habitual
  assert.equal(base172DelMes({ imponible: 1413000, excluidos: 0, no_imponibles: 45000 }).base_172, 1458000);
});

test('lo excluido nunca supera el imponible ni deja la base negativa', () => {
  assert.deepEqual(base172DelMes({ imponible: 500000, excluidos: 900000, no_imponibles: 0 }), { excluidos: 500000, base_172: 0 });
  assert.equal(base172DelMes({ imponible: 0, excluidos: 0, no_imponibles: 0 }).base_172, 0);
  assert.equal(base172DelMes({}).base_172, 0);
});

test('adicionales vacíos o basura no rompen el cálculo', () => {
  for (const x of [null, undefined, [], [null], [{}], 'x']) assert.deepEqual(ajusteArt172(x, P), { excluidos: 0, no_imp_lista: 0 });
});

/* ── Retención de alimentos sobre las indemnizaciones ── */
test('del aviso previo se retiene la pensión del mes siguiente; de los años de servicio, su % en el ingreso', () => {
  // Pensión 400.000, ingreso 2.000.000 → 20%. Aviso 2.000.000; 5 años = 10.000.000
  const r = retencionAlimentos({ pension: 400000, base: 2000000, mesAviso: 2000000, indemAnos: 10000000 });
  assert.deepEqual(r, { pct: 20, ret_aviso: 400000, ret_anos: 2000000, total: 2400000 });
});

test('sin indemnizaciones (renuncia) no hay nada que retener en el finiquito', () => {
  assert.deepEqual(retencionAlimentos({ pension: 400000, base: 2000000, mesAviso: 0, indemAnos: 0 }), { pct: 20, ret_aviso: 0, ret_anos: 0, total: 0 });
});

test('solo aviso previo, o solo años de servicio: cada regla opera sobre su indemnización', () => {
  assert.equal(retencionAlimentos({ pension: 400000, base: 2000000, mesAviso: 2000000, indemAnos: 0 }).total, 400000);
  assert.equal(retencionAlimentos({ pension: 400000, base: 2000000, mesAviso: 0, indemAnos: 4000000 }).total, 800000);
});

test('nunca se retiene más que la indemnización misma', () => {
  // Pensión mayor que el ingreso: 100% de los años de servicio, y del aviso no más que el aviso
  const r = retencionAlimentos({ pension: 3000000, base: 2000000, mesAviso: 2000000, indemAnos: 6000000 });
  assert.deepEqual(r, { pct: 100, ret_aviso: 2000000, ret_anos: 6000000, total: 8000000 });
});

test('el % se mide contra el ingreso SIN topar: el tope de 90 UF limita la indemnización, no el ingreso', () => {
  // Ingreso 5.000.000, indemnización calculada con base topada 3.500.000 × 2 años
  const r = retencionAlimentos({ pension: 500000, base: 5000000, mesAviso: 3500000, indemAnos: 7000000 });
  assert.equal(r.pct, 10);
  assert.equal(r.ret_anos, 700000);
  assert.equal(r.ret_aviso, 500000);
});

test('con dos causas, la segunda retiene solo de lo que queda', () => {
  const a = retencionAlimentos({ pension: 600000, base: 1000000, mesAviso: 1000000, indemAnos: 2000000 });
  assert.deepEqual(a, { pct: 60, ret_aviso: 600000, ret_anos: 1200000, total: 1800000 });
  const b = retencionAlimentos({ pension: 600000, base: 1000000, mesAviso: 1000000, indemAnos: 2000000, topeAviso: 1000000 - a.ret_aviso, topeAnos: 2000000 - a.ret_anos });
  assert.deepEqual(b, { pct: 60, ret_aviso: 400000, ret_anos: 800000, total: 1200000 });
});

test('sin pensión, sin base o con basura: cero, nunca NaN', () => {
  for (const x of [{}, undefined, { pension: 0, base: 100, mesAviso: 100, indemAnos: 100 }, { pension: 'x', base: null, mesAviso: undefined, indemAnos: -5 }])
    assert.deepEqual(retencionAlimentos(x), { pct: 0, ret_aviso: 0, ret_anos: 0, total: 0 });
  // pensión conocida pero base desconocida: del aviso sí se retiene (no depende del %), de los años no
  assert.deepEqual(retencionAlimentos({ pension: 300000, base: 0, mesAviso: 1000000, indemAnos: 2000000 }), { pct: 0, ret_aviso: 300000, ret_anos: 0, total: 300000 });
});
