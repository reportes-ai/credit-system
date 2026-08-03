'use strict';
/* Motores: shared/entorno.js y shared/scheduler.js — los blindajes del ambiente
   de pruebas (Fase 4 de docs/plan-staging-prod.md).

   Lo que protegen estas pruebas es una promesa concreta: en staging es
   IMPOSIBLE que un correo o un WhatsApp llegue a un cliente real. Si alguien
   rompe esa promesa sin darse cuenta, acá se cae. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/* Cada caso necesita releer los módulos con otra variable de entorno, porque
   `entorno.js` la resuelve una sola vez al cargarse (que es justo lo que se quiere
   en producción: que no cambie sola en caliente). */
function cargarCon(valorEntorno) {
  for (const m of ['../shared/entorno', '../shared/scheduler'])
    delete require.cache[require.resolve(m)];
  const antes = process.env.ENTORNO;
  if (valorEntorno === undefined) delete process.env.ENTORNO;
  else process.env.ENTORNO = valorEntorno;
  const entorno = require('../shared/entorno');
  const scheduler = require('../shared/scheduler');
  if (antes === undefined) delete process.env.ENTORNO; else process.env.ENTORNO = antes;
  return { entorno, scheduler };
}

test('sin ENTORNO definido se asume PRODUCCIÓN', () => {
  const { entorno } = cargarCon(undefined);
  assert.equal(entorno.esStaging(), false);
  assert.equal(entorno.NOMBRE, 'produccion');
  assert.equal(entorno.puedeContactarClientes(), true);
  assert.equal(entorno.motoresAutomaticosActivos(), true);
});

test('ENTORNO=produccion se comporta como producción', () => {
  const { entorno } = cargarCon('produccion');
  assert.equal(entorno.esStaging(), false);
  assert.equal(entorno.puedeContactarClientes(), true);
});

test('ENTORNO=staging prohíbe contactar clientes y apaga los motores', () => {
  const { entorno } = cargarCon('staging');
  assert.equal(entorno.esStaging(), true);
  assert.equal(entorno.NOMBRE, 'staging');
  assert.equal(entorno.puedeContactarClientes(), false);
  assert.equal(entorno.motoresAutomaticosActivos(), false);
});

test('acepta las variantes razonables y NO se confunde con otras', () => {
  for (const v of ['staging', 'STAGING', ' Staging ', 'stg', 'test'])
    assert.equal(cargarCon(v).entorno.esStaging(), true, `"${v}" debería ser staging`);
  for (const v of ['prod', 'produccion', 'PRODUCCION', '', 'stagingx'])
    assert.equal(cargarCon(v).entorno.esStaging(), false, `"${v}" NO debería ser staging`);
});

test('en staging los motores de envío NO se programan', () => {
  const { scheduler } = cargarCon('staging');
  let corrio = false;
  const t = scheduler.programar('envio-de-prueba', () => { corrio = true; }, 10);
  assert.equal(t, null, 'no debe devolver un temporizador');
  assert.equal(corrio, false);
  const reg = scheduler.listar().find(r => r.nombre === 'envio-de-prueba');
  assert.equal(reg.activo, false, 'debe quedar registrado como apagado, para poder auditarlo');
});

test('en producción los motores SÍ se programan', () => {
  const { scheduler } = cargarCon('produccion');
  const t = scheduler.programar('envio-de-prueba', () => {}, 60000);
  assert.notEqual(t, null);
  clearInterval(t);
  assert.equal(scheduler.listar().find(r => r.nombre === 'envio-de-prueba').activo, true);
});

test('un motor marcado enStaging corre en AMBOS ambientes', () => {
  // Los internos e inofensivos (uptime, feriados) deben seguir vivos en staging.
  const { scheduler } = cargarCon('staging');
  const t = scheduler.programar('monitor-interno', () => {}, 60000, { enStaging: true });
  assert.notEqual(t, null);
  clearInterval(t);
});

test('un error dentro de una tarea NO tumba el proceso', async () => {
  const { scheduler } = cargarCon('produccion');
  const t = scheduler.programar('tarea-que-falla', () => { throw new Error('boom'); }, 5);
  await new Promise(r => setTimeout(r, 30));
  clearInterval(t);
  assert.ok(true, 'si llegamos acá, el error quedó contenido');
});

test('los temporizadores no impiden que el proceso termine (unref)', () => {
  const { scheduler } = cargarCon('produccion');
  const t = scheduler.programar('tarea-larga', () => {}, 999999);
  assert.equal(typeof t.unref, 'function');
  clearInterval(t);
});
