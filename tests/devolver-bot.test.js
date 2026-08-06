'use strict';
/* Devolución automática de conversaciones al bot — services/whatsapp/src/devolver-bot.js
   MOTORES=off antes del require: así el módulo no programa su temporizador y la
   prueba termina sola (el scheduler no registra nada con ese interruptor). */
process.env.MOTORES = 'off';

const test = require('node:test');
const assert = require('node:assert');
const { normalizarHoras } = require('../services/whatsapp/src/devolver-bot');

test('0 y los valores vacíos significan "nunca devolver"', () => {
  assert.strictEqual(normalizarHoras(0), 0);
  assert.strictEqual(normalizarHoras(null), 0);
  assert.strictEqual(normalizarHoras(undefined), 0);
  assert.strictEqual(normalizarHoras(''), 0);
  assert.strictEqual(normalizarHoras('abc'), 0);
});

test('un negativo no se convierte en un INTERVAL al revés', () => {
  assert.strictEqual(normalizarHoras(-5), 0);
});

test('el valor normal pasa tal cual', () => {
  assert.strictEqual(normalizarHoras(24), 24);
  assert.strictEqual(normalizarHoras('48'), 48);
});

test('el tope son 30 días', () => {
  assert.strictEqual(normalizarHoras(720), 720);
  assert.strictEqual(normalizarHoras(99999), 720);
});
