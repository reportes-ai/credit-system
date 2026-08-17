'use strict';
const pool = require('../config/database');
/* El mes, venga como venga (Date de la base o texto), lo normaliza el motor de
   fechas — que es puro y no arrastra la conexión. Acá se reexporta como `aMes`
   porque es donde lo buscan los controladores que ya cuidaban meses cerrados. */
const { mesDe: aMes } = require('../fecha-chile');

/**
 * Verifica si un mes está cerrado.
 * @param {string|Date} mesOrFecha  YYYY-MM  o  fecha completa (se trunca a YYYY-MM)
 * @returns {Promise<boolean>}
 */
async function isMesCerrado(mesOrFecha) {
  if (!mesOrFecha) return false;
  const mes = aMes(mesOrFecha);
  if (!mes) return false;
  const [rows] = await pool.query(
    'SELECT cerrado FROM meses_cerrados WHERE mes = ? LIMIT 1', [mes]
  );
  return rows.length ? !!rows[0].cerrado : false;
}

/**
 * Obtiene el mes YYYY-MM de una operación por su id.
 * Retorna null si no existe.
 */
async function getMesDeOp(id) {
  const [rows] = await pool.query("SELECT DATE_FORMAT(mes,'%Y-%m') AS mes FROM creditos WHERE id = ? LIMIT 1", [id]);
  if (!rows.length || !rows[0].mes) return null;
  return aMes(rows[0].mes);
}

/**
 * Obtiene el mes YYYY-MM de una operación por su num_op.
 */
async function getMesDeNumOp(numOp) {
  const [rows] = await pool.query("SELECT DATE_FORMAT(mes,'%Y-%m') AS mes FROM creditos WHERE num_op = ? LIMIT 1", [numOp]);
  if (!rows.length || !rows[0].mes) return null;
  return aMes(rows[0].mes);
}

module.exports = { isMesCerrado, getMesDeOp, getMesDeNumOp, aMes };
