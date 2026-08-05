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
 * Siguiente correlativo AutoFácil (AAMM####).
 *
 * MAX()+1 no es atómico (auditoría 03-08-2026, A-8): dos otorgamientos
 * simultáneos leían el mismo máximo y el segundo chocaba contra `uq_num_op`,
 * devolviéndole un error 500 al usuario en mitad de otorgar un crédito. Ahora
 * la función solo PROPONE el número; quien inserta debe usar `conNumOpAF()`,
 * que reintenta ante el duplicado hasta encontrar el hueco.
 *
 * @param {object} [conn] conexión/transacción; por defecto el pool compartido
 * @param {number} [saltar=0] cuántos números avanzar sobre el máximo (reintentos)
 */
async function siguienteNumOpAF(conn, saltar = 0) {
  const db = conn || require('./config/database');
  const base = Number(prefijoMes()) * 10000;          // 26080000
  const [[r]] = await db.query(
    'SELECT COALESCE(MAX(num_op), ?) mx FROM creditos WHERE num_op BETWEEN ? AND ?',
    [base, base + 1, base + 9999]);
  return Number(r.mx) + 1 + Number(saltar || 0);      // primer número del mes: AAMM0001
}

/**
 * Ejecuta `fn(num_op)` con un correlativo libre, reintentando si otro proceso
 * ganó la carrera. `fn` debe hacer el INSERT que consume el número: si choca
 * contra el índice único, se pide el siguiente y se vuelve a intentar.
 *
 *   const id = await conNumOpAF(conn, async (num) => insertarCredito(num));
 *
 * @param {object} conn conexión/transacción (o null para el pool)
 * @param {(num:number)=>Promise<any>} fn operación que consume el número
 * @param {number} [intentos=8]
 */
async function conNumOpAF(conn, fn, intentos = 8) {
  let ultimoError = null;
  for (let i = 0; i < intentos; i++) {
    const num = await siguienteNumOpAF(conn, i);
    try {
      return await fn(num);
    } catch (e) {
      const dup = e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062 ||
                        /duplicate entry/i.test(e.message || ''));
      if (!dup) throw e;                              // otro error: no es carrera
      ultimoError = e;
      await new Promise(r => setTimeout(r, 40 * (i + 1)));   // backoff corto
    }
  }
  throw ultimoError || new Error('No se pudo obtener un número de operación libre');
}

/** ¿Este num_op es un ID de financiera (Trinidad) y no un correlativo nuestro?
    Trinidad va en ~6,2 millones; nuestra serie AAMM#### parte en 20+ millones. */
const esIdFinanciera = n => Number(n) >= 1000000 && Number(n) < 20000000;

/**
 * NÚMERO DE CRÉDITO DE LA CARTA (YYMM### — tres dígitos).
 *
 * Motor único (Máxima 1). Vivía copiado en CUATRO lugares —cartas, créditos,
 * operaciones y `next-op`— y las copias no eran equivalentes:
 *
 *   · Tres resolvían la secuencia con `ORDER BY id DESC LIMIT 1`, o sea el
 *     ÚLTIMO INSERTADO y no el número MAYOR. Tras una restauración el último
 *     id no es el número más alto, y se generaban números repetidos que hacían
 *     fallar el INSERT. Cartas ya lo había corregido a MAX() numérico; las
 *     otras tres seguían con el bug. Acá manda la versión corregida.
 *   · Ninguna usaba la hora de Chile: en el servidor (UTC) desde las 20:00 del
 *     último día del mes el prefijo saltaba al mes siguiente.
 *
 * Ojo con lo que este número NO es: la llave de negocio es `num_op`
 * (`siguienteNumOpAF`). Este nace en la carta y sobrevive como dato de los
 * documentos ya emitidos.
 *
 * @param {string|Date} [mesISO] mes de la operación ('YYYY-MM' o fecha); por
 *                               defecto el mes en curso en hora de Chile
 * @param {object} [conn] conexión/transacción; por defecto el pool compartido
 */
async function numeroCreditoCarta(mesISO, conn) {
  const db = conn || require('./config/database');
  let prefix;
  if (mesISO) {
    const m = String(mesISO).match(/^(\d{4})-(\d{2})/);
    if (m) prefix = m[1].slice(-2) + m[2];
    else {
      const d = new Date(mesISO);
      prefix = String(d.getFullYear()).slice(-2) + String(d.getMonth() + 1).padStart(2, '0');
    }
  } else prefix = prefijoMes();

  // El mayor del mes mirando numero_credito Y num_op: los dos consumen la serie.
  const [[row]] = await db.query(
    `SELECT GREATEST(
        COALESCE((SELECT MAX(CAST(numero_credito AS UNSIGNED)) FROM creditos
                   WHERE numero_credito REGEXP '^[0-9]+$' AND numero_credito LIKE ?), 0),
        COALESCE((SELECT MAX(num_op) FROM creditos WHERE num_op BETWEEN ? AND ?), 0)
      ) mx`,
    [prefix + '%', Number(prefix) * 1000, Number(prefix) * 1000 + 999]);

  const mx = Number(row.mx) || 0;
  const seq = mx > 0 ? (mx % 1000) + 1 : 1;
  return prefix + String(seq).padStart(3, '0');
}

module.exports = { siguienteNumOpAF, conNumOpAF, esIdFinanciera, prefijoMes, numeroCreditoCarta };
