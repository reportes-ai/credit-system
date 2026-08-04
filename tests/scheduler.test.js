'use strict';
/* Scheduler — quién corre los motores automáticos y quién no.
   Esto no es cosmético: los motores MUTAN datos (aprueban comisiones, generan
   devengos, cierran castigos). Que dos procesos los ejecuten a la vez contra la
   misma base duplica plata en silencio, y que no corran cuando deben significa
   que nadie aprueba nada. Las dos fallas son caras, así que la decisión de
   correr o no queda fijada acá. */
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const RUTA = path.join(__dirname, '..', 'shared', 'scheduler.js');
const RUTA_ENT = path.join(__dirname, '..', 'shared', 'entorno.js');

/* El scheduler lee las variables de entorno AL IMPORTARSE, así que cada
   escenario necesita una copia limpia del módulo. */
function cargar({ MOTORES, ENTORNO } = {}) {
  delete require.cache[require.resolve(RUTA)];
  delete require.cache[require.resolve(RUTA_ENT)];
  const antes = { MOTORES: process.env.MOTORES, ENTORNO: process.env.ENTORNO };
  if (MOTORES == null) delete process.env.MOTORES; else process.env.MOTORES = MOTORES;
  if (ENTORNO == null) delete process.env.ENTORNO; else process.env.ENTORNO = ENTORNO;
  const mod = require(RUTA);
  if (antes.MOTORES == null) delete process.env.MOTORES; else process.env.MOTORES = antes.MOTORES;
  if (antes.ENTORNO == null) delete process.env.ENTORNO; else process.env.ENTORNO = antes.ENTORNO;
  return mod;
}
const activo = (sch, nombre) => sch.listar().find(r => r.nombre === nombre).activo;

test('en producción los motores corren — que es lo normal', () => {
  const sch = cargar();
  sch.programar('cobranza', () => {}, 60000);
  assert.strictEqual(activo(sch, 'cobranza'), true);
  assert.strictEqual(sch.motoresActivos(), true);
});

test('MOTORES=off apaga TODOS los motores de negocio', () => {
  const sch = cargar({ MOTORES: 'off' });
  sch.programar('comisiones-auto-aprobar', () => {}, 60000);
  sch.programar('rrhh-devengo-vacaciones', () => {}, 60000);
  assert.strictEqual(activo(sch, 'comisiones-auto-aprobar'), false);
  assert.strictEqual(activo(sch, 'rrhh-devengo-vacaciones'), false);
  assert.strictEqual(sch.motoresActivos(), false);
});

test('MOTORES=off NO apaga las tareas de infraestructura', () => {
  // El host en espera tiene que seguir midiendo su propio uptime y limpiando
  // memoria: eso no toca datos de negocio y no se duplica con nada.
  const sch = cargar({ MOTORES: 'off' });
  sch.programar('uptime', () => {}, 60000, { infra: true });
  assert.strictEqual(activo(sch, 'uptime'), true);
});

test('solo el valor "off" apaga: un valor cualquiera no puede apagar la producción por accidente', () => {
  for (const v of ['', 'on', 'false', '0', 'OFF ', 'si']) {
    const sch = cargar({ MOTORES: v });
    sch.programar('motor', () => {}, 60000);
    const deberiaCorrer = v.trim().toLowerCase() !== 'off';
    assert.strictEqual(activo(sch, 'motor'), deberiaCorrer,
      `MOTORES=${JSON.stringify(v)} no se comportó como corresponde`);
  }
});

test('en staging los motores que salen al mundo no se programan', () => {
  const sch = cargar({ ENTORNO: 'staging' });
  sch.programar('wsp-cobranza', () => {}, 60000);
  assert.strictEqual(activo(sch, 'wsp-cobranza'), false);
});

test('en staging, lo marcado enStaging sí corre', () => {
  const sch = cargar({ ENTORNO: 'staging' });
  sch.programar('uptime', () => {}, 60000, { enStaging: true });
  assert.strictEqual(activo(sch, 'uptime'), true);
});

test('MOTORES=off manda por sobre enStaging: el standby no ejecuta nada de negocio', () => {
  const sch = cargar({ MOTORES: 'off', ENTORNO: 'staging' });
  sch.programar('sincronizacion', () => {}, 60000, { enStaging: true });
  assert.strictEqual(activo(sch, 'sincronizacion'), false);
});

test('un motor apagado devuelve null y no deja temporizador vivo', () => {
  const sch = cargar({ MOTORES: 'off' });
  assert.strictEqual(sch.programar('motor', () => {}, 60000), null);
});

test('listar() informa el estado de cada motor — es lo que expone /api/health', () => {
  const sch = cargar({ MOTORES: 'off' });
  sch.programar('a', () => {}, 1000);
  sch.programar('b', () => {}, 2000, { infra: true });
  const r = sch.listar();
  assert.deepStrictEqual(r.map(x => [x.nombre, x.activo]), [['a', false], ['b', true]]);
  assert.strictEqual(r[0].ms, 1000);
});

test('el error de un motor no tumba el proceso ni al motor siguiente', async () => {
  const sch = cargar();
  let corrio = false;
  const t = sch.programar('explota', () => { throw new Error('boom'); }, 3600000, { arranqueMs: 1 });
  sch.programar('sano', () => { corrio = true; }, 3600000, { arranqueMs: 1 });
  await new Promise(r => setTimeout(r, 40));
  assert.strictEqual(corrio, true, 'el segundo motor debió correr igual');
  if (t) clearInterval(t);
});

test('arranqueFn: al arrancar puede correr algo DISTINTO que en cada vuelta', async () => {
  // indicadores-sync se pone al día con {force:true} al arrancar y después
  // sincroniza normal. Sin esto, migrarlo al scheduler le cambiaba la conducta.
  const sch = cargar();
  const llamadas = [];
  const t = sch.programar('sync', () => llamadas.push('normal'), 3600000,
    { arranqueMs: 1, arranqueFn: () => llamadas.push('forzado') });
  await new Promise(r => setTimeout(r, 40));
  assert.deepStrictEqual(llamadas, ['forzado']);
  if (t) clearInterval(t);
});

test('sin arranqueFn, el arranque usa la misma tarea del intervalo', async () => {
  const sch = cargar();
  let n = 0;
  const t = sch.programar('tick', () => { n++; }, 3600000, { arranqueMs: 1 });
  await new Promise(r => setTimeout(r, 40));
  assert.strictEqual(n, 1);
  if (t) clearInterval(t);
});
