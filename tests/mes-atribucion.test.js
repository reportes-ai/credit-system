'use strict';
/* Motor: shared/mes-atribucion.js — desde el corte, el mes contable de una op
   cursada es el mes de su fecha de curse. El 07-09-2026 siete ops cursadas en
   septiembre quedaron con mes agosto y agosto pasó de 104 a 111 después del
   cierre. Estas pruebas fijan la forma del fragmento que lo impide. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
// Se importa la parte PURA: mes-atribucion.js arrastra el pool y las pruebas corren sin base.
const core = require('../shared/mes-atribucion-core');
const { ALINEAR_MES_SQL, MES_SQL, DEFAULT_CORTE } = core;
const fs = require('node:fs');
const path = require('node:path');

test('ALINEAR_MES_SQL: sentencia aparte que deja mes = mes de fecha_otorgado desde el corte', () => {
  const sql = ALINEAR_MES_SQL('id = ?');
  assert.ok(/^UPDATE creditos SET mes = DATE_FORMAT\(fecha_otorgado, '%Y-%m-01'\)/.test(sql), 'el mes se deriva de la fecha de curse ya guardada');
  assert.ok(sql.includes('WHERE (id = ?)'), 'la condición de quien llama va entre paréntesis (puede traer OR)');
  assert.ok(sql.includes('fecha_otorgado >= ?'), 'antes del corte no se toca mes; el corte es el último parámetro');
  assert.ok(sql.includes("DATE_FORMAT(mes, '%Y-%m') <> DATE_FORMAT(fecha_otorgado, '%Y-%m')"), 'solo escribe si el mes difiere');
  assert.equal((sql.match(/\?/g) || []).length, 2, 'un ? de la condición y uno del corte');
});

/* 01-10-2026: el fragmento `fecha_otorgado = …, mes = CASE WHEN fecha_otorgado …` dentro de un mismo SET
   no funciona en TiDB (cada expresión ve el valor ANTERIOR de la fila): la op 26091585 se otorgó en
   octubre y quedó en septiembre. Que nadie lo vuelva a escribir, y que cada escritor alinee después. */
test('ningún escritor calcula el mes dentro del mismo SET; todos llaman a alinearMes', () => {
  assert.equal(core.SET_MES_SQL, undefined, 'SET_MES_SQL no debe volver: en TiDB calcula el mes con la fecha vieja');
  const ESCRITORES = [
    'services/cartas/src/controllers/cartas.controller.js',
    'services/creditos/src/controllers/carga-trinidad.controller.js',
    'services/creditos/src/controllers/carga-diferencias.controller.js',
    'services/creditos/src/controllers/creditos.controller.js',
    'services/creditos/src/controllers/operaciones.controller.js',
    'services/creditos/src/controllers/edicion.controller.js',
    'services/creditos/src/controllers/digitacion-faltantes.controller.js',
    'services/mantenedores/src/controllers/bd-operaciones.controller.js',
  ];
  for (const f of ESCRITORES) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(src.includes('alinearMes('), `${f} escribe fecha_otorgado o mes y debe llamar a alinearMes`);
    assert.ok(!src.includes('SET_MES_SQL'), `${f} no debe usar SET_MES_SQL`);
    assert.ok(!/mes\s*=\s*CASE\s+WHEN\s+fecha_otorgado/i.test(src), `${f} no debe calcular el mes dentro del mismo SET`);
  }
});

test('MES_SQL: mes evaluado >= corte manda fecha_otorgado; antes manda mes', () => {
  assert.ok(MES_SQL('2026-09', DEFAULT_CORTE).includes('fecha_otorgado'));
  assert.ok(!MES_SQL('2026-07', DEFAULT_CORTE).includes('fecha_otorgado'));
});
