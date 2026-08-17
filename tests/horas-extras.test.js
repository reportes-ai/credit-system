'use strict';
/* VALOR DE LA HORA EXTRAORDINARIA — art. 32 del Código del Trabajo.

   Esto se paga en la liquidación de una persona, así que el número tiene que
   ser el que dice la ley: de menos es un sueldo mal pagado, de más es un costo
   que nadie cuadra. La referencia es el factor 0,0077778 de la tabla clásica
   (jornada de 45 h con 50% de recargo), que esta fórmula tiene que reproducir
   exactamente. */
const { test } = require('node:test');
const assert = require('node:assert');
const { valorHoraExtra, montoHorasExtras } = require('../shared/horas-extras');

test('reproduce el factor 0,0077778 de la tabla (45 h, recargo 50%)', () => {
  const v = valorHoraExtra({ sueldoBase: 1000000, jornadaSemanal: 45, recargoPct: 50 });
  assert.equal(v.factor.toFixed(7), '0.0077778');
  assert.equal(v.valor_hora_extra, 7778);   // $1.000.000 × 0,0077778
});

test('la jornada vigente (44 h) encarece la hora respecto de 45 h', () => {
  // Menos horas por el mismo sueldo = cada hora vale más. Si esto se invirtiera,
  // la reducción de jornada estaría pagándose al revés.
  const v44 = valorHoraExtra({ sueldoBase: 1000000, jornadaSemanal: 44 });
  const v45 = valorHoraExtra({ sueldoBase: 1000000, jornadaSemanal: 45 });
  assert.ok(v44.valor_hora_extra > v45.valor_hora_extra);
  assert.equal(v44.valor_hora_extra, 7955);
});

test('el recargo del 50% se aplica sobre la hora ordinaria', () => {
  const v = valorHoraExtra({ sueldoBase: 1200000, jornadaSemanal: 45, recargoPct: 50 });
  assert.equal(v.valor_hora_extra, Math.round(v.valor_hora_ordinaria * 1.5));
});

test('un recargo mayor al mínimo legal se respeta', () => {
  // Se puede pactar más del 50%, nunca menos: el parámetro debe mandar.
  const v = valorHoraExtra({ sueldoBase: 1000000, jornadaSemanal: 45, recargoPct: 100 });
  assert.equal(v.valor_hora_extra, Math.round(v.valor_hora_ordinaria * 2));
});

test('el art. 22 NO genera horas extras, y lo dice', () => {
  // Devolver 0 en silencio se leería como "sale gratis" en vez de "no corresponde".
  const v = valorHoraExtra({ sueldoBase: 3000000, art22: true });
  assert.equal(v.aplica, false);
  assert.match(v.motivo, /art\. 22/);
  assert.equal(v.valor_hora_extra, 0);
});

test('sin sueldo base en la ficha no se inventa un valor', () => {
  const v = valorHoraExtra({ sueldoBase: 0 });
  assert.equal(v.aplica, false);
  assert.match(v.motivo, /sueldo base/i);
});

test('el monto se calcula sobre el valor exacto, no sobre la hora redondeada', () => {
  // Con la hora ya redondeada, 20 horas podían quedar varios pesos lejos de lo
  // que muestra la liquidación. El redondeo va una sola vez, al final.
  const p = { sueldoBase: 1300000, jornadaSemanal: 44, recargoPct: 50 };
  const exacto = Math.round(1300000 * 7 / (30 * 44) * 1.5 * 20);
  assert.equal(montoHorasExtras(20, p).monto, exacto);
});

test('acepta medias horas, calculadas sobre el valor exacto', () => {
  const p = { sueldoBase: 1300000, jornadaSemanal: 44, recargoPct: 50 };
  // Ojo: NO es la mitad del monto de 1 hora ya redondeado ($10.341 ÷ 2 = $5.171).
  // El redondeo va una sola vez, al final, así que media hora son $5.170. Esa
  // diferencia de un peso es la señal de que no se está redondeando dos veces.
  assert.equal(montoHorasExtras(0.5, p).monto, Math.round(1300000 * 7 / (30 * 44) * 1.5 * 0.5));
  assert.equal(montoHorasExtras(0.5, p).monto, 5170);
  assert.equal(montoHorasExtras(1, p).monto, 10341);
});

test('cero, negativo o basura en las horas no paga nada', () => {
  const p = { sueldoBase: 1300000 };
  for (const h of [0, -5, null, undefined, 'muchas']) assert.equal(montoHorasExtras(h, p).monto, 0);
});
