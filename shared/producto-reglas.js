'use strict';
/* Reglas propias de productos (AUTOFIN PREFERENTE, etc.) — lado servidor.
   Carga desde productos_financiera (reglas_propias = 1, activo = 1) con caché de 60 s y
   expone las funciones puras del motor único api-gateway/public/js/producto-reglas-core.js.
   Consumidores: cartas (validación del checkbox PREFERENTE), calcular-operacion,
   recalcular-mes, comisión de ejecutivos. (Pato, 24-09-2026) */
const pool = require('./config/database');
const core = require('../api-gateway/public/js/producto-reglas-core');

let _cache = null, _exp = 0;
const norm = s => String(s || '').trim().toUpperCase();

async function cargar() {
  if (_cache && _exp > Date.now()) return _cache;
  let rows = [];
  try {
    [rows] = await pool.query('SELECT * FROM productos_financiera WHERE reglas_propias = 1 AND activo = 1');
    rows.forEach(r => { r.dealer_tramos = core.parseTramos(r.dealer_tramos); });
  } catch (e) { console.error('[producto-reglas]', e.message); rows = _cache || []; }
  _cache = rows; _exp = Date.now() + 60 * 1000;
  return rows;
}

/* Reglas del producto de un crédito/carta, o null si ese producto no tiene reglas propias. */
async function reglasDe(producto, financiera) {
  if (!producto) return null;
  const rows = await cargar(), p = norm(producto);
  return rows.find(r => norm(r.producto) === p && (!financiera || norm(r.financiera) === norm(financiera)))
      || rows.find(r => norm(r.producto) === p) || null;
}

/* El producto PREFERENTE de una financiera (el que activa el checkbox de la carta). */
async function preferenteDe(financiera = 'AUTOFIN') {
  const rows = await cargar(), f = norm(financiera);
  return rows.find(r => norm(r.financiera) === f && core.esPreferente(r))
      || rows.find(r => norm(r.financiera) === f) || null;
}

/* { 'AUTOFIN PREFERENTE': 0.01, … } → % ejecutivo por producto (fracción), para el motor de comisiones. */
async function mapaEjecutivoPct() {
  const rows = await cargar(), m = {};
  rows.forEach(r => { const p = core.ejecutivoPct(r); if (p != null) m[norm(r.producto)] = p; });
  return m;
}

module.exports = { cargar, reglasDe, preferenteDe, mapaEjecutivoPct, invalidar: () => { _exp = 0; }, ...core };
