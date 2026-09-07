'use strict';
/* Parte PURA del motor de mes de atribución (sin pool): las expresiones SQL.
   Vive aparte para que las pruebas corran sin base (mes-atribucion.js arrastra el
   pool y encola una migración al cargarse). mes-atribucion.js las re-exporta. */

const DEFAULT_CORTE = '2026-08';

/**
 * Expresión SQL del mes de atribución ('YYYY-MM') para el MES EVALUADO dado.
 * No es un CASE por fila: la convención depende del mes que se está calculando,
 * así que basta elegir la columna una vez.
 * @param {string} mesEvaluado 'YYYY-MM' del cálculo
 * @param {string} corte       'YYYY-MM' (de mesCorte())
 * @param {string} alias       alias de la tabla creditos
 */
function MES_SQL(mesEvaluado, corte, alias = 'c') {
  const a = alias ? alias + '.' : '';
  return mesEvaluado >= corte
    ? `DATE_FORMAT(COALESCE(${a}fecha_otorgado, ${a}mes), '%Y-%m')`
    : `DATE_FORMAT(${a}mes, '%Y-%m')`;
}

/**
 * Fragmento para un SET que ESCRIBE `mes` coherente con `fecha_otorgado`: desde el
 * corte, el mes contable de una op cursada es el mes de su fecha de curse; antes del
 * corte `mes` se respeta tal cual (ajustes históricos). Va DESPUÉS de `fecha_otorgado`
 * en el SET: MySQL evalúa de izquierda a derecha y así ve la fecha ya definitiva.
 * Nació el 07-09-2026: 7 ops cursadas el 03/04-09 quedaron con mes agosto (el dashboard
 * y las cartolas cuentan por `mes`) y agosto pasó de 104 a 111 después del cierre.
 * @param {string} corte 'YYYY-MM' (de mesCorte())
 */
function SET_MES_SQL(corte) {
  return `mes = CASE WHEN fecha_otorgado IS NOT NULL AND fecha_otorgado >= '${corte}-01'
                     THEN DATE_FORMAT(fecha_otorgado, '%Y-%m-01') ELSE mes END`;
}

module.exports = { MES_SQL, SET_MES_SQL, DEFAULT_CORTE };
