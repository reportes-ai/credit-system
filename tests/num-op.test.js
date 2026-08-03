'use strict';
/* Motor: shared/num-op.js — correlativo AAMM#### del número de operación.
   `num_op` es la llave de negocio: si se repite, dos créditos distintos comparten
   identidad. El índice único de la BD lo impide, pero antes eso le llegaba al
   usuario como un error 500 en mitad de otorgar (auditoría A-8). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const N = require('../shared/num-op');

/* Doble de BD: responde el MAX() sin tocar TiDB. Así la prueba corre en
   milisegundos y no depende de la red ni del estado de producción. */
const fakeDb = (maxActual) => ({
  async query() { return [[{ mx: maxActual }]]; },
});

test('el prefijo es AAMM en hora de Chile', () => {
  const p = N.prefijoMes();
  assert.match(p, /^\d{4}$/);
  const esperado = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago', year: '2-digit', month: '2-digit',
  }).format(new Date()).split('-').join('');
  assert.equal(p, esperado);
});

test('el primer número del mes es AAMM0001', async () => {
  const base = Number(N.prefijoMes()) * 10000;
  assert.equal(await N.siguienteNumOpAF(fakeDb(base)), base + 1);
});

test('el correlativo avanza de uno en uno', async () => {
  const base = Number(N.prefijoMes()) * 10000;
  assert.equal(await N.siguienteNumOpAF(fakeDb(base + 41)), base + 42);
});

test('cuatro dígitos alcanzan para el mes completo', async () => {
  const base = Number(N.prefijoMes()) * 10000;
  assert.equal(await N.siguienteNumOpAF(fakeDb(base + 9998)), base + 9999);
});

test('esIdFinanciera distingue el número de Trinidad del nuestro', () => {
  assert.equal(N.esIdFinanciera(6203227), true);      // ID Trinidad (~6,2 millones)
  assert.equal(N.esIdFinanciera(26080001), false);    // correlativo nuestro (>20 millones)
  assert.equal(N.esIdFinanciera(88150), false);       // serie histórica AutoFácil
  assert.equal(N.esIdFinanciera(519001), false);      // serie INDEXA
});

test('la serie nueva NUNCA colisiona con las series existentes', () => {
  const nuestro = Number(N.prefijoMes()) * 10000 + 1;
  assert.ok(nuestro > 20000000, 'la serie AAMM#### debe superar los 20 millones');
  assert.ok(nuestro > 6300000,  'debe quedar sobre los IDs de Trinidad');
  assert.ok(nuestro > 519999,   'debe quedar sobre la serie INDEXA');
});

test('conNumOpAF reintenta cuando otro proceso gana la carrera (el bug A-8)', async () => {
  const base = Number(N.prefijoMes()) * 10000;
  const usados = new Set([base + 1, base + 2]);   // otros dos ya se llevaron esos números
  const intentados = [];

  const resultado = await N.conNumOpAF(fakeDb(base), async (num) => {
    intentados.push(num);
    if (usados.has(num)) {
      const e = new Error(`Duplicate entry '${num}' for key 'uq_num_op'`);
      e.code = 'ER_DUP_ENTRY';
      throw e;
    }
    return num;
  });

  assert.deepEqual(intentados, [base + 1, base + 2, base + 3]);
  assert.equal(resultado, base + 3, 'debe entregar el primer número libre');
});

test('conNumOpAF NO reintenta ante un error que no sea de duplicado', async () => {
  const base = Number(N.prefijoMes()) * 10000;
  let veces = 0;
  await assert.rejects(
    () => N.conNumOpAF(fakeDb(base), async () => { veces++; throw new Error('columna inexistente'); }),
    /columna inexistente/,
  );
  assert.equal(veces, 1, 'un error real debe propagarse de inmediato');
});

test('conNumOpAF se rinde tras agotar los intentos y no gira infinito', async () => {
  const base = Number(N.prefijoMes()) * 10000;
  let veces = 0;
  await assert.rejects(() => N.conNumOpAF(fakeDb(base), async () => {
    veces++;
    const e = new Error('Duplicate entry'); e.code = 'ER_DUP_ENTRY'; throw e;
  }, 3));
  assert.equal(veces, 3);
});
