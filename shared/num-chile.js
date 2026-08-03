'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   NÚMERO CHILENO — motor único de lectura de montos en texto (Máxima 1).

   En Chile el punto es separador de MILES y la coma el decimal: "1.109.286,50".
   `parseFloat` hace exactamente lo contrario y lo hace en silencio:
       parseFloat("307.000")    →  307        (no 307.000)
       parseFloat("1.109.286")  →  1          (no 1.109.286)

   Ese detalle costó dinero real: la carga del Informe Canal escribió primas de
   seguro divididas por mil o peor, 22 operaciones quedaron con primas de $1 a
   $500, y como eran > 0 el sistema las daba por completas — nadie las volvió a
   mirar durante semanas (incidente 02-08-2026).

   Todo texto que venga de un Excel, un PDF o un formulario y represente un monto
   pasa por acá. No inventar una variante local.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Convierte un valor a número respetando el formato chileno.
 * Devuelve `null` si no hay número que leer (nunca NaN).
 *
 *   numeroCL("1.109.286")    → 1109286
 *   numeroCL("307.000")      → 307000
 *   numeroCL("1.234,56")     → 1234.56
 *   numeroCL("$ 892.129")    → 892129
 *   numeroCL(892129)         → 892129   (ya es número: se respeta)
 *   numeroCL("")             → null
 */
function numeroCL(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;      // Excel ya lo entregó numérico
  let t = String(v).trim();
  if (!t) return null;
  t = t.replace(/[^0-9.,\-]/g, '');                            // fuera $, espacios, letras
  if (!t || t === '-') return null;
  t = t.replace(/\./g, '')                                     // el punto es MILES → se elimina
       .replace(',', '.');                                     // la coma es DECIMAL → punto
  const n = parseFloat(t);
  return isNaN(n) ? null : n;
}

/**
 * Igual que `numeroCL` pero redondeado a entero — para montos en pesos, que es
 * como se guardan en la base (BIGINT).
 *
 *   enteroCL("320.118")  → 320118
 *   enteroCL("1.234,56") → 1235
 */
function enteroCL(v) {
  const n = numeroCL(v);
  return n === null ? null : Math.round(n);
}

module.exports = { numeroCL, enteroCL };
if (typeof window !== 'undefined') window.AF_NUM_CL = { numeroCL, enteroCL };
