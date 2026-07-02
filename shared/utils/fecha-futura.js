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

/* ── Helpers canónicos de fecha/hora CHILE (MOTOR ÚNICO de timezone) ──────────
   Cualquier "hoy/ahora/mes" de negocio debe salir de aquí — nunca de new Date()
   directo (el servidor corre en UTC) ni de copias locales por módulo. */

// 'YYYY-MM' del mes actual en Chile
function mesChile() {
  return hoyChile().slice(0, 7);
}

// 'HH:MM' (24h) hora actual de Chile
function horaChile() {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
}

// Componentes de ahora en Chile: { fecha:'YYYY-MM-DD', hhmm:'HH:MM', year, month(1-12), day, dow(0=Dom) }
function ahoraChile() {
  const fecha = hoyChile();
  const [y, m, d] = fecha.split('-').map(Number);
  return { fecha, hhmm: horaChile(), year: y, month: m, day: d, dow: new Date(fecha + 'T12:00:00Z').getUTCDay() };
}

module.exports = { esFechaFutura, hoyChile, hoyChileDMY, mesChile, horaChile, ahoraChile };
