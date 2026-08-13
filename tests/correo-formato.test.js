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
  const html = aHTML('Primera línea\nSegunda línea\nTercera línea');
  assert.strictEqual(html.match(/<p /g).length, 1);
  assert.strictEqual(html.match(/<br>/g).length, 2);
});

test('el texto NUNCA sale pegado en un solo bloque', () => {
  const cuerpo = 'Estimados PARQUE:\n\nAdjuntamos la cartola.\n\nComisión: $1\nArriendo: $2\n\nSaludos,\nAutoFácil';
  const html = aHTML(cuerpo);
  // 3 párrafos + el bloque de montos, que se va como tabla
  assert.strictEqual(html.match(/<p /g).length, 3);
  assert.ok(html.includes('<table'));
  assert.ok(/cartola\.<\/p>/.test(html), 'cada párrafo cierra antes de que empiece el siguiente');
  assert.ok(/Saludos,<br>AutoFácil/.test(html), 'dentro de un párrafo el salto simple es <br>');
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

/* Dos o más líneas de monto seguidas se leen mejor como tabla que como texto
   corrido — es lo que pidió Pato mirando el correo real (13-08-2026). */
test('un bloque de montos se convierte en tabla', () => {
  const html = aHTML('Comisión por créditos (4 operaciones): $547.250\nArriendo mensual: $250.000');
  assert.ok(html.includes('<table'));
  assert.strictEqual(html.match(/<tr>/g).length, 3);   // encabezado + 2 filas
  assert.ok(html.includes('Comisión por créditos (4 operaciones)'));
  assert.ok(html.includes('$547.250'));
});

test('una línea de monto suelta NO arma tabla', () => {
  const html = aHTML('Total pagado: $100');
  assert.ok(!html.includes('<table'));
  assert.ok(html.includes('<p '));
});

test('un texto que termina en dos puntos no se confunde con un monto', () => {
  const html = aHTML('Favor emitir la(s) factura(s) a:\nAUTOFACIL SPA — RUT 76.545.638-K');
  assert.ok(!html.includes('<table'), 'sin signo $ no es una línea de monto');
  assert.ok(/<p[^>]*>Favor emitir/.test(html));
});

test('la fila TOTAL se destaca', () => {
  const html = aHTML('Arriendo mensual: $250.000\nTOTAL A PAGAR: $1.000.000');
  assert.ok(html.includes('<table'));
  assert.ok(/font-weight:700[^"]*"[^>]*>TOTAL A PAGAR/.test(html), 'la fila de total va en negrita');
});
