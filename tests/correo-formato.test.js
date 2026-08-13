const test = require('node:test');
const assert = require('node:assert');
const { aHTML, esHTML, render } = require('../shared/correo-formato');

/* El bug que originó estas pruebas: el correo de prueba salía con TODO el texto
   pegado en un solo bloque, porque se metía el texto plano crudo dentro del HTML
   y el navegador colapsa los saltos de línea. */
test('una línea en blanco separa párrafos', () => {
  const html = aHTML('Hola:\n\nSegundo párrafo.');
  assert.strictEqual(html.match(/<p /g).length, 2);
  assert.ok(html.includes('Hola:'));
  assert.ok(html.includes('Segundo párrafo.'));
});

test('el salto simple es <br>, no párrafo nuevo', () => {
  const html = aHTML('Comisión: $100\nArriendo: $250\nTotal: $350');
  assert.strictEqual(html.match(/<p /g).length, 1);
  assert.strictEqual(html.match(/<br>/g).length, 2);
});

test('el texto NUNCA sale pegado en un solo bloque', () => {
  const cuerpo = 'Estimados PARQUE:\n\nAdjuntamos la cartola.\n\nComisión: $1\nArriendo: $2\n\nSaludos,\nAutoFácil';
  const html = aHTML(cuerpo);
  // 4 párrafos y ninguna pareja de textos sin etiqueta de separación entre medio
  assert.strictEqual(html.match(/<p /g).length, 4);
  assert.ok(/cartola\.<\/p><p /.test(html), 'cada párrafo cierra antes de que empiece el siguiente');
  assert.ok(/\$1<br>Arriendo/.test(html), 'las líneas del detalle van con salto simple');
});

test('si viene HTML de verdad, se respeta tal cual', () => {
  assert.strictEqual(aHTML('<p>hola</p>'), '<p>hola</p>');
  assert.strictEqual(aHTML('<table><tr><td>x</td></tr></table>'), '<table><tr><td>x</td></tr></table>');
  assert.ok(esHTML('<div>x</div>'));
  assert.ok(!esHTML('texto normal con < y > sueltos'));
});

test('escapa el HTML que venga en el texto plano (no se inyecta)', () => {
  const html = aHTML('Monto < 100 & > 50');
  assert.ok(html.includes('&lt;'));
  assert.ok(html.includes('&amp;'));
  assert.ok(html.includes('&gt;'));
});

test('render acepta variables en mayúscula y minúscula', () => {
  assert.strictEqual(render('{PARQUE} y {dealer}', { PARQUE: 'CARMOONS', dealer: 'AUTEN' }), 'CARMOONS y AUTEN');
  // la plantilla de dealer usa minúscula y los datos pueden venir en mayúscula
  assert.strictEqual(render('{dealer}', { DEALER: 'AUTEN' }), 'AUTEN');
  assert.strictEqual(render('{PARQUE}', { parque: 'MAIPU' }), 'MAIPU');
});

test('una variable sin dato queda vacía, nunca {ASI} a la vista del cliente', () => {
  assert.strictEqual(render('Total: {TOTAL}', {}), 'Total: ');
  assert.strictEqual(render('', {}), '');
  assert.strictEqual(render(null, {}), '');
});
