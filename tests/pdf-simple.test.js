const test = require('node:test');
const assert = require('node:assert');
const PDF = require('../api-gateway/public/js/pdf-simple');

/* Un PDF mal armado no "falla": se abre en blanco o el visor lo rechaza, y eso
   ya le llegó a un parque (13-08-2026). Estas pruebas verifican la ESTRUCTURA
   del archivo — que es lo que decide si un visor puede leerlo — sin depender de
   ninguna librería: cada offset del xref tiene que caer exactamente sobre su
   objeto, y el /Length declarado tiene que ser el largo real del stream. */

const pdfDe = doc => doc.salida().toString('binary');

test('el archivo tiene cabecera, xref y cierre', () => {
  const doc = PDF.crear();
  doc.texto(14, 20, 'Hola', { size: 10 });
  const s = pdfDe(doc);
  assert.ok(s.startsWith('%PDF-1.'), 'debe empezar con la cabecera PDF');
  assert.ok(s.trimEnd().endsWith('%%EOF'), 'debe cerrar con %%EOF');
  assert.ok(s.includes('/Root 1 0 R'), 'el trailer debe apuntar al catálogo');
  assert.ok(/\/ID \[<[0-9A-F]{32}> <[0-9A-F]{32}>\]/.test(s), 'el trailer lleva /ID');
});

test('cada offset del xref cae exactamente sobre su objeto', () => {
  const doc = PDF.crear();
  doc.rect(10, 10, 50, 8, [1, 65, 162]);
  doc.texto(14, 20, 'Cartola de prueba', { size: 11, bold: true });
  doc.linea(10, 30, 200, 30, [200, 200, 200]);
  const s = pdfDe(doc);

  const inicio = parseInt(s.slice(s.lastIndexOf('startxref') + 9), 10);
  const cab = s.slice(inicio).match(/^xref\n0 (\d+)\n/);
  assert.ok(cab, 'la tabla xref debe empezar con "xref" y el rango');
  const total = Number(cab[1]);
  const tabla = s.slice(inicio + cab[0].length);

  for (let i = 1; i < total; i++) {
    const entrada = tabla.slice(i * 20, (i + 1) * 20);
    assert.strictEqual(entrada.length, 20, `la entrada ${i} debe ocupar 20 bytes exactos`);
    const off = parseInt(entrada.slice(0, 10), 10);
    assert.ok(s.startsWith(`${i} 0 obj`, off),
      `el offset de la entrada ${i} apunta a "${s.slice(off, off + 12)}" y debería apuntar a "${i} 0 obj"`);
  }
});

test('el /Length del stream es el largo real del contenido', () => {
  const doc = PDF.crear();
  doc.texto(14, 20, 'Contenido de largo variable con tildes: comisión y año', { size: 9 });
  const s = pdfDe(doc);
  const m = s.match(/\/Length (\d+) >>\nstream\n/);
  assert.ok(m, 'el stream declara su largo');
  const ini = s.indexOf('stream\n', s.indexOf('/Length')) + 7;
  const fin = s.indexOf('\nendstream', ini);
  assert.strictEqual(fin - ini, Number(m[1]), 'el /Length declarado debe ser el largo real');
});

test('el archivo es ASCII: las tildes y el signo peso van escapados', () => {
  const doc = PDF.crear();
  doc.texto(14, 20, 'Comisión $1.234.567 — año 2026', { size: 10 });
  const s = pdfDe(doc);
  assert.ok([...s].every(c => c.charCodeAt(0) < 128),
    'ningún byte sobre 127: si los hubiera, los offsets del xref se correrían');
  assert.ok(s.includes('\\363') || s.includes('\\363'), 'la ó va como código octal');
});

test('varias páginas quedan declaradas en el catálogo', () => {
  const doc = PDF.crear();
  doc.texto(14, 20, 'Página 1', { size: 10 });
  doc.paginaNueva();
  doc.texto(14, 20, 'Página 2', { size: 10 });
  const s = pdfDe(doc);
  assert.ok(s.includes('/Count 2'), 'el árbol de páginas debe declarar 2');
  assert.strictEqual((s.match(/\/Type \/Page[^s]/g) || []).length, 2);
});

test('el texto alineado a la derecha no se sale de la hoja', () => {
  const doc = PDF.crear();
  const ancho = doc.ancho('$1.234.567', 8);
  assert.ok(ancho > 0 && ancho < 40, 'la medida del texto debe ser razonable en mm');
});
