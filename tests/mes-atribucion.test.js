'use strict';
/* Motor: shared/mes-atribucion.js — desde el corte, el mes contable de una op
   cursada es el mes de su fecha de curse. El 07-09-2026 siete ops cursadas en
   septiembre quedaron con mes agosto y agosto pasó de 104 a 111 después del
   cierre. Estas pruebas fijan la forma del fragmento que lo impide. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
// Se importa la parte PURA: mes-atribucion.js arrastra el pool y las pruebas corren sin base.
const { SET_MES_SQL, MES_SQL, DEFAULT_CORTE } = require('../shared/mes-atribucion-core');

test('SET_MES_SQL: desde el corte, mes = mes de fecha_otorgado; antes se respeta mes', () => {
  const sql = SET_MES_SQL('2026-08');
  assert.ok(sql.startsWith('mes = CASE'), 'debe escribir la columna mes');
  assert.ok(sql.includes("fecha_otorgado >= '2026-08-01'"), 'el corte entra como primer día del mes');
  assert.ok(sql.includes("DATE_FORMAT(fecha_otorgado, '%Y-%m-01')"), 'el mes se deriva de la fecha de curse');
  assert.ok(/ELSE mes END/.test(sql), 'antes del corte no se toca mes');
  assert.ok(!sql.includes('?'), 'sin placeholders: se concatena a cualquier SET sin desordenar los valores');
});

test('MES_SQL: mes evaluado >= corte manda fecha_otorgado; antes manda mes', () => {
  assert.ok(MES_SQL('2026-09', DEFAULT_CORTE).includes('fecha_otorgado'));
  assert.ok(!MES_SQL('2026-07', DEFAULT_CORTE).includes('fecha_otorgado'));
});
