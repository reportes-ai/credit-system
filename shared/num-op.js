'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   NÚMERO DE OPERACIÓN AUTOFÁCIL — motor único del correlativo (Máxima 1)

   Regla (Pato, 01-08-2026): TODA operación lleva número de operación NUESTRO
   desde que nace — no solo las otorgadas. El ID que le puso la financiera vive
   en `id_financiera`; `num_op` es la llave de negocio de AutoFácil.

   FORMATO (definido por Pato): AAMM#### — año+mes + secuencia de CUATRO
   dígitos, reiniciada cada mes. Agosto 2026 parte en 26080001. Cuatro dígitos
   porque tres (999/mes) quedaban cortos: entran hasta ~350 solicitudes por día.

   Por qué no choca con nada:
     · Serie nueva ≥ 20.000.000 siempre (26.08xxxx, 27.01xxxx, …).
     · IDs de Trinidad: ~6.2 millones (crecen lento; techo 20M les da años).
     · Serie histórica AutoFácil 80000–99999 e INDEXA 519xxx: muy por debajo.
     · numero_credito de cartas (YYMM###, 7 dígitos) queda como N° INTERNO del
       crédito de carta; la OP es esta serie.

   Julio 2026 y hacia atrás quedó con los números con que cerró: esta regla
   rige para lo que nace desde agosto.
   ───────────────────────────────────────────────────────────────────────────── */

/** Prefijo AAMM del mes actual en hora de Chile (ej. '2608'). */
function prefijoMes() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: '2-digit', month: '2-digit' })
    .format(new Date()).split('-');
  return p[0] + p[1];
}

/**
 * Siguiente correlativo AutoFácil (AAMM####). Se apoya en MAX() dentro del mes,
 * así que debe llamarse en flujos secuenciales (cargas fila a fila, otorgar).
 * @param {object} [conn] conexión/transacción; por defecto el pool compartido
 */
async function siguienteNumOpAF(conn) {
  const db = conn || require('./config/database');
  const base = Number(prefijoMes()) * 10000;          // 26080000
  const [[r]] = await db.query(
    'SELECT COALESCE(MAX(num_op), ?) mx FROM creditos WHERE num_op BETWEEN ? AND ?',
    [base, base + 1, base + 9999]);
  return Number(r.mx) + 1;                            // primer número del mes: AAMM0001
}

/** ¿Este num_op es un ID de financiera (Trinidad) y no un correlativo nuestro?
    Trinidad va en ~6,2 millones; nuestra serie AAMM#### parte en 20+ millones. */
const esIdFinanciera = n => Number(n) >= 1000000 && Number(n) < 20000000;

module.exports = { siguienteNumOpAF, esIdFinanciera, prefijoMes };
