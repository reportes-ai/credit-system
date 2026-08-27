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

/* ─────────────────────────────────────────────────────────────────────────────
   numeroCreditoCarta — YYMM### , el número que nace en la carta.

   Vivía copiado en CUATRO lugares (cartas, créditos, operaciones y next-op) y
   tres copias resolvían la secuencia con `ORDER BY id DESC LIMIT 1`: el último
   INSERTADO, no el MAYOR. Después de una restauración eso devuelve un número ya
   usado. Estas pruebas fijan la conducta correcta para que la copia no vuelva.
   ───────────────────────────────────────────────────────────────────────────── */

test('el mes explícito manda sobre el mes en curso (op de mayo digitada en junio)', async () => {
  const db = { async query(_sql, p) { this.params = p; return [[{ mx: 0 }]]; } };
  assert.equal(await N.numeroCreditoCarta('2026-05', db), '2605001');
  assert.equal(db.params[0], '2605%', 'debe consultar el prefijo del mes pedido');
});

test('sin mes explícito usa el mes en curso en hora de Chile', async () => {
  const db = { async query() { return [[{ mx: 0 }]]; } };
  const n = await N.numeroCreditoCarta(undefined, db);
  assert.equal(n.slice(0, 4), N.prefijoMes());
});

test('el primero del mes es ###001 y después avanza de uno en uno', async () => {
  const vacio = { async query() { return [[{ mx: 0 }]]; } };
  assert.equal(await N.numeroCreditoCarta('2026-05', vacio), '2605001');
  const con41 = { async query() { return [[{ mx: 2605041 }]]; } };
  assert.equal(await N.numeroCreditoCarta('2026-05', con41), '2605042');
});

test('la secuencia sale del MAYOR, no del último insertado (bug de restauración)', async () => {
  // Tras restaurar, el último id puede ser el 2605007 mientras el mayor es 2605042.
  // La consulta pide MAX(): si alguien la cambia por ORDER BY id, esto se cae.
  const db = { async query(sql) {
    assert.match(sql, /MAX\(/, 'la secuencia debe resolverse con MAX(), nunca con ORDER BY id');
    return [[{ mx: 2605042 }]];
  } };
  assert.equal(await N.numeroCreditoCarta('2026-05', db), '2605043');
});

test('num_op también consume la serie: no se entrega un número ya tomado por una OP', async () => {
  const db = { async query(_sql, p) { this.params = p; return [[{ mx: 2605009 }]]; } };
  const n = await N.numeroCreditoCarta('2026-05', db);
  assert.equal(n, '2605010');
  // El rango de num_op del mes viaja en la consulta (2605000–2605999).
  assert.equal(db.params[1], 2605000);
  assert.equal(db.params[2], 2605999);
});

test('el número siempre trae 3 dígitos de secuencia', async () => {
  const db = { async query() { return [[{ mx: 2605008 }]]; } };
  assert.equal((await N.numeroCreditoCarta('2026-05', db)).length, 7);
});

/* ── Tripwire de la regla 27-08-2026: un crédito tiene SOLO N° OP e id ────────
   numero_credito debe ESPEJAR la OP y la OP solo puede nacer del motor único
   (siguienteNumOpAF / conNumOpAF, AAMM#### de 8 dígitos). La serie corta
   YYMM### (numeroCreditoCarta) queda para documentos históricos; si un camino
   de inserción vuelve a usarla como OP o como numero_credito de un crédito
   nuevo, estas pruebas lo delatan en el mismo commit (el caso real: crear
   crédito derivaba num_op = parseInt(numero_credito) → OP de 7 dígitos en el
   rango de los IDs Trinidad). */
const fs = require('node:fs');
const path = require('node:path');

test('ningún controller deriva la OP de la serie corta (parseInt(numero_credito))', () => {
  const raiz = path.join(__dirname, '..', 'services');
  const malos = [];
  (function rec(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.name.endsWith('.js') && /parseInt\(\s*numero_credito\s*\)/.test(fs.readFileSync(p, 'utf8')))
        malos.push(p);
    }
  })(raiz);
  assert.deepEqual(malos, [], 'la OP nunca se deriva de numero_credito: usar shared/num-op.js');
});

test('la serie corta ya no alimenta el numero_credito de créditos nuevos', () => {
  // Único uso permitido: el fallback documentado de operaciones.controller
  // (solo cuando la op nace sin OP, cosa que no debería pasar).
  const usos = [];
  const raiz = path.join(__dirname, '..', 'services');
  (function rec(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8');
        if (/numero_credito\s*=\s*(await\s+)?(generarNumero|numeroCreditoCarta)/.test(src)) usos.push(path.basename(p));
      }
    }
  })(raiz);
  assert.deepEqual(usos, [], 'numero_credito debe espejar la OP (regla 27-08-2026), no la serie YYMM###');
});
