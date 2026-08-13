const test = require('node:test');
const assert = require('node:assert');
const { fechaPrimeraCuota } = require('../shared/fecha-primera-cuota');

const CARTA = [
  'Nº Crédito 6282904', 'Fecha Aprobación', '05/08/2026',
  'Fecha curse', '12/08/2026',
  'CUADRO DE PAGO',
  '08/09/2026', '08/10/2026', '08/11/2026', '08/12/2026',
  'DOCUMENTOS', '01/01/2020',
].join('\n');

test('toma la cuota más temprana del cuadro de pago', () => {
  assert.strictEqual(fechaPrimeraCuota(CARTA, '2026-08-12'), '2026-09-08');
});

test('ignora lo que va después de DOCUMENTOS y las fechas del encabezado', () => {
  // 05/08 (aprobación) y 01/01/2020 (pie de página) NO pueden ganar
  assert.notStrictEqual(fechaPrimeraCuota(CARTA, '2026-08-12'), '2026-08-05');
  assert.notStrictEqual(fechaPrimeraCuota(CARTA, '2026-08-12'), '2020-01-01');
});

test('sin cuadro de pago exige fecha de curse y toma la siguiente fecha', () => {
  const plano = '10/01/2026 20/02/2026 15/03/2026';
  assert.strictEqual(fechaPrimeraCuota(plano, '2026-01-15'), '2026-02-20');
  // Sin curse no adivina: una fecha inventada corrompe la mora
  assert.strictEqual(fechaPrimeraCuota(plano, null), null);
});

test('sin candidatas devuelve null', () => {
  assert.strictEqual(fechaPrimeraCuota('carta sin fechas', '2026-08-12'), null);
  assert.strictEqual(fechaPrimeraCuota('', null), null);
  assert.strictEqual(fechaPrimeraCuota(null, null), null);
});

test('descarta fechas anteriores o iguales al curse', () => {
  const t = 'CUADRO DE PAGO\n12/08/2026\n08/09/2026';
  assert.strictEqual(fechaPrimeraCuota(t, '2026-08-12'), '2026-09-08');
});
