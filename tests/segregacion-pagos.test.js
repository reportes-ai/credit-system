'use strict';
/* Segregación de funciones en pagos: quien emite / manda a pago una orden no
   puede ser quien registra su pago (control de cuatro ojos sobre el egreso).

   Defecto que cubre: hasta el 13-08-2026 el único candado para pagar era tener
   Caja Activa, así que quien podía emitir y tenía caja creaba la orden y la
   pagaba solo — sin que ninguna segunda persona mirara el monto ni la cuenta de
   destino. Detectado por Pato sobre el perfil Gerente de Finanzas. */
const { test } = require('node:test');
const assert = require('node:assert');

// Se prueba la comparación pura: el interruptor del mantenedor consulta la BD.
const { esMismaPersona } = require('../shared/segregacion-pagos');

test('bloquea a la misma persona (mismo id_usuario)', () => {
  assert.equal(esMismaPersona({ idEmisor: 90001, idPagador: 90001 }), true);
});

test('permite cuando el pagador es otra persona', () => {
  assert.equal(esMismaPersona({ idEmisor: 5, idPagador: 9 }), false);
});

test('el id manda por sobre el nombre (dos personas homónimas siguen siendo dos)', () => {
  assert.equal(esMismaPersona({ idEmisor: 5, nombreEmisor: 'Juan Pérez', idPagador: 7, nombrePagador: 'Juan Pérez' }), false);
});

test('sin ids, compara por nombre y tolera mayúsculas y espacios de más', () => {
  assert.equal(esMismaPersona({ nombreEmisor: 'Juan Manuel Bustamante', nombrePagador: 'juan manuel  bustamante ' }), true);
  assert.equal(esMismaPersona({ nombreEmisor: 'Sandra Ayala', nombrePagador: 'Jorge Vargas' }), false);
});

test('las órdenes emitidas por el Sistema nunca bloquean: no hay persona detrás', () => {
  assert.equal(esMismaPersona({ idEmisor: null, nombreEmisor: 'Sistema', idPagador: 90001, nombrePagador: 'Sistema' }), false);
});

test('sin datos del emisor no bloquea (no se puede afirmar que sea la misma persona)', () => {
  assert.equal(esMismaPersona({ nombrePagador: 'Sandra Ayala' }), false);
  assert.equal(esMismaPersona({}), false);
});
