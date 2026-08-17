'use strict';
/* EL MES, VENGA COMO VENGA — normalización de `aMes`.

   Las columnas de mes son DATE y mysql2 las entrega como objeto Date, así que
   `String(mes).slice(0,7)` daba **"Sat Aug"**: no calzaba con el formato,
   isMesCerrado devolvía false y NINGÚN mes resultaba cerrado. El candado que
   protege los meses liquidados llevaba tiempo abierto, y sin avisar — un
   candado que no traba no se queja.

   Se prueba la normalización, que vive en el motor de fechas justamente para
   ser pura: importarla desde mes-cerrado arrastraría el pool y estas pruebas
   corren SIN base (se quedaban colgadas esperando la conexión). */
const { test } = require('node:test');
const assert = require('node:assert');
const { mesDe: aMes } = require('../shared/fecha-chile');

test('un Date de la base entrega su mes, no "Sat Aug"', () => {
  assert.equal(aMes(new Date(2026, 7, 1)), '2026-08');
  assert.equal(aMes(new Date(2026, 4, 1)), '2026-05');
  // Lo que hacía antes, para que se vea por qué fallaba:
  assert.equal(String(new Date(2026, 7, 1)).slice(0, 7), 'Sat Aug');
});

test('el día 1 a medianoche de Chile no se corre al mes anterior', () => {
  // La marca de un mes es su día 1 a las 00:00 de Chile; en UTC ya es otro día
  // y, en el borde, otro mes. Por eso se convierte en zona de Chile.
  assert.equal(aMes(new Date(2026, 0, 1, 0, 0, 0)), '2026-01');
  assert.equal(aMes(new Date(2026, 11, 1, 0, 0, 0)), '2026-12');
});

test('un string que ya venía bien se respeta', () => {
  assert.equal(aMes('2026-08'), '2026-08');
  assert.equal(aMes('2026-08-01'), '2026-08');
  assert.equal(aMes('2026-05-17 10:30:00'), '2026-05');
});

test('un string "YYYY-MM" NO se reinterpreta como fecha UTC', () => {
  // new Date('2026-08') se parsea como UTC y en Chile (-04) sería julio: pasar
  // por Date un texto que ya estaba bien devolvería el mes equivocado.
  assert.equal(aMes('2026-08'), '2026-08');
  assert.equal(aMes('2026-01'), '2026-01');
});

test('lo que no es un mes devuelve null y nunca "cierra" nada por error', () => {
  for (const v of [null, undefined, '', 'basura', 'Sat Aug', {}, []]) {
    assert.equal(aMes(v), null, `${JSON.stringify(v)} debería dar null`);
  }
  assert.equal(aMes(new Date('fecha inválida')), null);
});
