'use strict';
/**
 * rut-core.js — MOTOR ÚNICO de RUT (puro, isomorfo: Node + navegador).
 *
 * Forma CANÓNICA de almacenamiento = "BODY-DV" (con guion, SIN puntos): "12345678-9".
 *   - normalizar(raw): reformatea a canónico. NO recalcula el DV (conserva el último
 *     carácter tal cual). Devuelve null si no parece RUT (placeholder/vacío) → no tocar.
 *   - validar(raw):    sí verifica el DV (módulo 11). true / false / null (no es RUT).
 *   - formatear(raw):  para MOSTRAR, con puntos: "12.345.678-9".
 *
 * Regla de negocio (verificado en BD): el sistema guarda RUT en "BODY-DV". dealers.rut
 * venía sin guion (legacy) y se homologó. De aquí en adelante TODO se guarda con normalizar().
 */
(function (factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AF_RUT = api;
})(function () {
  'use strict';

  // Quita puntos, guiones y espacios; a mayúscula (para la K).
  function _limpiar(raw) {
    return String(raw == null ? '' : raw).replace(/[.\s-]/g, '').toUpperCase();
  }

  // ¿el texto limpio tiene forma de RUT? (cuerpo de dígitos + DV dígito o K)
  function _esRut(clean) {
    return /^[0-9]+[0-9K]$/.test(clean) && clean.length >= 2;
  }

  // Canónico para GUARDAR: "BODY-DV". null si no parece RUT (no se toca).
  function normalizar(raw) {
    const c = _limpiar(raw);
    if (!_esRut(c)) return null;
    return c.slice(0, -1) + '-' + c.slice(-1);
  }

  // Dígito verificador (módulo 11) de un cuerpo de dígitos.
  function calcDV(body) {
    const d = String(body).replace(/\D/g, '');
    if (!d) return null;
    const serie = [2, 3, 4, 5, 6, 7];
    const suma = d.split('').reverse().reduce((a, x, i) => a + parseInt(x) * serie[i % 6], 0);
    const r = 11 - (suma % 11);
    return r === 11 ? '0' : r === 10 ? 'K' : String(r);
  }

  // ¿el DV es correcto? true / false / null (no parece RUT).
  function validar(raw) {
    const c = _limpiar(raw);
    if (!_esRut(c)) return null;
    return calcDV(c.slice(0, -1)) === c.slice(-1);
  }

  // Para MOSTRAR: "12.345.678-9" (con puntos). Si no es RUT, devuelve el original.
  function formatear(raw) {
    const n = normalizar(raw);
    if (!n) return raw == null ? '' : String(raw);
    const i = n.indexOf('-');
    return n.slice(0, i).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + n.slice(i);
  }

  // Cuerpo (número, sin DV) y DV por separado — espejo de las columnas generadas
  // `<col>_cuerpo` (BIGINT, indexado) / `<col>_dv` (CHAR) de las tablas maestras.
  // null si no es RUT. Para joins/lookups por entero usar el cuerpo.
  function cuerpo(raw) {
    const n = normalizar(raw);
    return n ? parseInt(n.slice(0, n.indexOf('-')), 10) : null;
  }
  function dv(raw) {
    const n = normalizar(raw);
    return n ? n.slice(n.indexOf('-') + 1) : null;
  }

  return { normalizar, calcDV, validar, formatear, cuerpo, dv };
});
