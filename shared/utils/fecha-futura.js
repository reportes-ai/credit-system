'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Restricción de negocio: NO se permiten créditos con fecha (de otorgamiento o
   mes de operación) futura. "Hoy" se calcula en zona horaria de Chile para no
   rechazar/aceptar por desfase UTC.
   Usado por: creación individual, edición y carga masiva de créditos.
   ───────────────────────────────────────────────────────────────────────────── */

// 'en-CA' → 'YYYY-MM-DD'
function hoyChile() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
}

// 'DD/MM/YYYY' para mensajes al usuario
function hoyChileDMY() {
  const [y, m, d] = hoyChile().split('-');
  return `${d}/${m}/${y}`;
}

// true si la fecha (solo parte fecha) es ESTRICTAMENTE posterior a hoy (Chile).
// Acepta string 'YYYY-MM-DD...', Date o vacío. null/undefined/'' → false (no es futura).
function esFechaFutura(v) {
  if (v === null || v === undefined || v === '') return false;
  let s;
  if (v instanceof Date) {
    if (isNaN(v)) return false;
    s = v.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
  } else {
    const m = String(v).trim().match(/(\d{4}-\d{2}-\d{2})/);
    if (!m) return false;
    s = m[1];
  }
  return s > hoyChile();   // comparación lexicográfica YYYY-MM-DD == cronológica
}

module.exports = { esFechaFutura, hoyChile, hoyChileDMY };
