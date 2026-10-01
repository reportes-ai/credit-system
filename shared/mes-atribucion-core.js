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
 * Sentencia que deja `mes` coherente con `fecha_otorgado`: desde el corte, el mes
 * contable de una op cursada es el mes de su fecha de curse; antes del corte `mes` se
 * respeta tal cual (ajustes históricos). Nació el 07-09-2026: 7 ops cursadas el 03/04-09
 * quedaron con mes agosto (el dashboard y las cartolas cuentan por `mes`) y agosto pasó
 * de 104 a 111 después del cierre.
 *
 * Es una sentencia APARTE, que se ejecuta DESPUÉS del UPDATE que escribe la fecha
 * (alinearMes() en mes-atribucion.js). Hasta el 01-10-2026 era un fragmento dentro del
 * mismo SET (`fecha_otorgado = …, mes = CASE WHEN fecha_otorgado …`) que confiaba en que
 * el motor evalúa el SET de izquierda a derecha. MySQL lo hace; **TiDB no**: cada
 * expresión ve el valor ANTERIOR de la fila. En producción el mes quedaba calculado con
 * la fecha vieja (vacía al otorgar una carta) y el crédito salía del dashboard hasta que
 * el vigía lo corregía (26 veces en 24 días; op 26091585). Peor: con `mes = ?` en el
 * mismo SET, el `ELSE mes` devolvía el mes viejo y la edición manual se perdía callada.
 * En una sentencia aparte no hay orden que adivinar: sirve igual en TiDB y en MySQL.
 * @param {string} where condición de las filas recién escritas (con sus `?`)
 * @returns {string} UPDATE con un `?` final para el corte ('YYYY-MM-01')
 */
function ALINEAR_MES_SQL(where) {
  return `UPDATE creditos SET mes = DATE_FORMAT(fecha_otorgado, '%Y-%m-01'), updated_at = NOW()
           WHERE (${where}) AND fecha_otorgado IS NOT NULL AND fecha_otorgado >= ?
             AND (mes IS NULL OR DATE_FORMAT(mes, '%Y-%m') <> DATE_FORMAT(fecha_otorgado, '%Y-%m'))`;
}

module.exports = { MES_SQL, ALINEAR_MES_SQL, DEFAULT_CORTE };
