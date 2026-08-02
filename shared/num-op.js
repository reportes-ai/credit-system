'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   NÚMERO DE OPERACIÓN AUTOFÁCIL — motor único del correlativo (Máxima 1)

   Regla (Pato, 01-08-2026): TODA operación lleva número de operación NUESTRO
   desde que nace — no solo las otorgadas. El ID que le puso la financiera vive
   en `id_financiera`; `num_op` es la llave de negocio de AutoFácil.

   La serie: correlativo único que hoy va en ~89.36x. Se deja crecer más allá
   de 99.999 hacia el rango 100.000–518.999, que está COMPLETAMENTE libre
   (~430.000 números ≈ décadas al ritmo actual). El techo 518.999 existe porque
   en 519.xxx vive la serie migrada de INDEXA y sobre 1.000.000 los IDs de
   Trinidad — jamás deben chocar.

   Julio 2026 y hacia atrás quedó con los números con que cerró (Trinidad/INDEXA
   en las filas históricas): esta regla rige para lo que nace desde agosto.
   ───────────────────────────────────────────────────────────────────────────── */
const PISO  = 80000;
const TECHO = 518999;   // exclusivo de la serie INDEXA (519xxx) hacia arriba

/**
 * Siguiente correlativo AutoFácil. Se apoya en MAX() dentro de la serie, así
 * que debe llamarse en flujos secuenciales (cargas fila a fila, otorgar).
 * @param {object} [conn] conexión/transacción; por defecto el pool compartido
 */
async function siguienteNumOpAF(conn) {
  const db = conn || require('./config/database');
  const [[r]] = await db.query(
    'SELECT COALESCE(MAX(num_op), ?) mx FROM creditos WHERE num_op BETWEEN ? AND ?',
    [PISO, PISO, TECHO]);
  return Number(r.mx) + 1;
}

/** ¿Este num_op es un ID de financiera (Trinidad) y no un correlativo nuestro? */
const esIdFinanciera = n => Number(n) >= 1000000;

module.exports = { siguienteNumOpAF, esIdFinanciera, PISO, TECHO };
