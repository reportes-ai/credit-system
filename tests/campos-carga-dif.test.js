'use strict';
/* Contraste de la carga contra nuestros datos — qué cuenta como diferencia.

   Esto decide qué le aparece a una persona para resolver a mano después de cada
   carga. Las dos fallas cuestan: si acusa de más, la pantalla se llena de casos
   falsos y se dejan de mirar (y ahí se pierde el caso real); si acusa de menos,
   el dato malo queda pegado para siempre — que es exactamente lo que pasó con la
   op 6251839, mala desde el alta y veinte cargas sin que nadie se enterara. */
const { test } = require('node:test');
const assert = require('node:assert');
const { difieren, aTexto, CAMPOS_DIF, POR_COL, ORDEN_GRUPOS } = require('../shared/campos-carga-dif');

test('un monto distinto es diferencia; $1 de redondeo no', () => {
  assert.equal(difieren('valor_vehiculo', 8990000, 9500000), true);
  assert.equal(difieren('valor_vehiculo', 8990000, 8990001), false);
  assert.equal(difieren('valor_vehiculo', 8990000, 8990000), false);
});

test('un lado vacío NO es diferencia: es algo por completar, no un desacuerdo', () => {
  // La carga rellena lo vacío por su cuenta; sacarlo acá evitaría el ruido de
  // cientos de campos nulos compitiendo con el archivo.
  assert.equal(difieren('pie', null, 500000), false);
  assert.equal(difieren('pie', 500000, null), false);
  assert.equal(difieren('automotora', '', 'DERCO'), false);
  assert.equal(difieren('automotora', 'DERCO', '   '), false);
});

test('un monto en 0 es "sin dato", no un desacuerdo', () => {
  assert.equal(difieren('monto_financiado', 0, 7500000), false);
  assert.equal(difieren('monto_financiado', 7500000, 0), false);
});

test('el texto se compara sin tildes, sin dobles espacios y sin importar la caja', () => {
  assert.equal(difieren('marca', 'Río Bueno', 'RIO BUENO'), false);
  assert.equal(difieren('modelo', ' SAIL  LT ', 'SAIL LT'), false);
  assert.equal(difieren('marca', 'CHEVROLET', 'MITSUBISHI'), true);
});

test('las fechas se comparan por día, venga Date o string', () => {
  assert.equal(difieren('fecha_otorgado', new Date(2026, 7, 16), '2026-08-16'), false);
  assert.equal(difieren('fecha_otorgado', '2026-08-16 00:00:00', '2026-08-16'), false);
  assert.equal(difieren('fecha_otorgado', '2026-08-16', '2026-07-31'), true);
});

test('un campo que no está en el catálogo nunca acusa', () => {
  // Sin esto, cualquier columna que se sumara al SELECT empezaría a generar
  // diferencias sin etiqueta ni tipo, imposibles de resolver en pantalla.
  assert.equal(difieren('comision_dealer', 100, 200), false);
  assert.equal(difieren('columna_inventada', 'a', 'b'), false);
});

test('la comisión del dealer NO se contrasta: la de Trinidad no es la nuestra', () => {
  const cols = CAMPOS_DIF.map(c => c.col).join(' ');
  assert.ok(!/comision|comdea/i.test(cols), 'ninguna comisión debe estar en el catálogo');
});

test('cada campo tiene etiqueta, tipo conocido y un grupo que se muestra', () => {
  for (const c of CAMPOS_DIF) {
    assert.ok(c.etiqueta, `${c.col} sin etiqueta`);
    assert.ok(['peso', 'texto', 'fecha'].includes(c.tipo), `${c.col} con tipo raro: ${c.tipo}`);
    assert.ok(ORDEN_GRUPOS.includes(c.grupo), `${c.col} en un grupo que la pantalla no dibuja: ${c.grupo}`);
    assert.equal(POR_COL[c.col], c);
  }
});

test('aTexto deja el valor listo para guardar y mostrar', () => {
  assert.equal(aTexto('fecha_otorgado', new Date(2026, 7, 16)), '2026-08-16');
  assert.equal(aTexto('valor_vehiculo', 8990000), '8990000');
  assert.equal(aTexto('marca', 'CHEVROLET'), 'CHEVROLET');
  assert.equal(aTexto('marca', null), null);
  // La columna es VARCHAR(60): un texto más largo se corta acá y no revienta el INSERT.
  assert.equal(aTexto('modelo', 'X'.repeat(80)).length, 60);
});
