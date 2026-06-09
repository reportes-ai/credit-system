'use strict';
const pool = require('../config/database');

/**
 * Verifica si un mes está cerrado.
 * @param {string|Date} mesOrFecha  YYYY-MM  o  fecha completa (se trunca a YYYY-MM)
 * @returns {Promise<boolean>}
 */
async function isMesCerrado(mesOrFecha) {
  if (!mesOrFecha) return false;
  const mes = String(mesOrFecha).slice(0, 7); // YYYY-MM
  if (!/^\d{4}-\d{2}$/.test(mes)) return false;
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
  const [rows] = await pool.query('SELECT mes FROM creditos WHERE id = ? LIMIT 1', [id]);
  if (!rows.length || !rows[0].mes) return null;
  return String(rows[0].mes).slice(0, 7);
}

/**
 * Obtiene el mes YYYY-MM de una operación por su num_op.
 */
async function getMesDeNumOp(numOp) {
  const [rows] = await pool.query('SELECT mes FROM creditos WHERE num_op = ? LIMIT 1', [numOp]);
  if (!rows.length || !rows[0].mes) return null;
  return String(rows[0].mes).slice(0, 7);
}

module.exports = { isMesCerrado, getMesDeOp, getMesDeNumOp };
