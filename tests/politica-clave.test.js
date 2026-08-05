'use strict';
/* Motor: shared/politica-clave.js — la política de claves del mantenedor
   "Seguridad de Usuarios".

   POR QUÉ EXISTE ESTE ARCHIVO: hasta el 05-08-2026 esas ocho reglas se
   configuraban, se guardaban y NO SE APLICABAN. El único control real era un
   `length < 6` escrito a mano en `cambiarClave`, así que un Administrador que
   exigía 8 caracteres con mayúscula, número y símbolo veía cómo el sistema
   aceptaba `123456`. Estas pruebas fijan que la configuración mande. */
const { test } = require('node:test');
const assert = require('node:assert/strict');

/* El motor lee `config_seguridad` con el pool compartido. Se intercepta el
   módulo de base de datos ANTES de cargarlo, para probar sin tocar TiDB. */
const rutaPool = require.resolve('../shared/config/database');
let CONFIG = {};
require.cache[rutaPool] = {
  id: rutaPool, filename: rutaPool, loaded: true,
  exports: { query: async (sql) => {
    if (/config_seguridad/.test(sql)) return [Object.entries(CONFIG).map(([clave, valor]) => ({ clave, valor }))];
    return [[]];
  } },
};
const P = require('../shared/politica-clave');
const con = cfg => { CONFIG = cfg; P.olvidarConfig(); };

test('la longitud mínima sale del mantenedor, no de un número fijo', async () => {
  con({ longitud_minima: '8' });
  assert.equal((await P.validarClave('1234567')).ok, false, '7 caracteres con mínimo 8 debe fallar');
  assert.equal((await P.validarClave('12345678')).ok, true);
});

test('el mínimo viejo escrito a mano (6) ya no manda', async () => {
  con({ longitud_minima: '10' });
  const r = await P.validarClave('123456');
  assert.equal(r.ok, false);
  assert.match(r.error, /10/, 'el mensaje debe citar el mínimo configurado');
});

test('exigir mayúscula, número y símbolo se cumple de verdad', async () => {
  con({ longitud_minima: '8', req_mayusculas: '1', req_numeros: '1', req_especiales: '1' });
  assert.equal((await P.validarClave('abcdefgh')).ok, false, 'sin mayúscula');
  assert.equal((await P.validarClave('Abcdefgh')).ok, false, 'sin número');
  assert.equal((await P.validarClave('Abcdefg1')).ok, false, 'sin símbolo');
  assert.equal((await P.validarClave('Abcdefg1!')).ok, true);
});

test('lo que el Administrador NO exige, no se exige', async () => {
  con({ longitud_minima: '6', req_mayusculas: '0', req_numeros: '0', req_especiales: '0' });
  assert.equal((await P.validarClave('abcdef')).ok, true);
});

test('la cuenta protegida queda fuera de la política', async () => {
  con({ longitud_minima: '20', req_mayusculas: '1', req_numeros: '1', req_especiales: '1' });
  assert.equal((await P.validarClave('corta', { protegido: true })).ok, true,
    'la cuenta de emergencia no puede quedar afuera por una política nueva');
});

test('el texto de ayuda refleja la configuración vigente', async () => {
  con({ longitud_minima: '8', req_mayusculas: '1', req_numeros: '1', req_especiales: '0', historial_claves: '3' });
  const t = await P.describir();
  assert.match(t, /8 caracteres/);
  assert.match(t, /mayúscula/);
  assert.match(t, /número/);
  assert.ok(!/especial/.test(t), 'no debe pedir lo que está apagado');
  assert.match(t, /últimas 3/);
});

test('sin configuración legible se aplica el mínimo duro, no barra libre', async () => {
  con({});
  assert.equal((await P.validarClave('abc')).ok, false);
  assert.equal((await P.validarClave('abcdef')).ok, true);
});
