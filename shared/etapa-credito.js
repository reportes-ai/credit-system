'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   MOTOR ÚNICO DE ETAPA DEL CRÉDITO  (Máxima 1: un solo motor por magnitud)

   ── El problema que resuelve ───────────────────────────────────────────────
   La etapa de un crédito vive HISTÓRICAMENTE en TRES columnas de `creditos`:
     · `estado`         — la usa la originación propia; además guarda palabras de
                          CARTERA (VIGENTE / EN MORA / VENCIDO / PREPAGADO / CASTIGADO)
     · `estado_credito` — la escribe la carga masiva y la edición manual
     · `estado_eval`    — la escribe la evaluación / carga Trinidad
   Cuando un proceso escribía solo dos de las tres, la operación quedaba con la
   etapa partida y cada consumidor veía una verdad distinta:
     · OP 89343 (AUTEN)   → estado=OTORGADO, las otras dos APROBADO: se veía
       otorgada en el listado pero quedaba fuera de vendedores, fundantes y cartolas.
     · OP 88558 (Salazar) → estado=OTORGADO, las otras dos ANULADO: un crédito
       ANULADO se seguía mostrando como OTORGADO, porque `estado` se lee primero.

   ── La regla ───────────────────────────────────────────────────────────────
   ESCRIBIR la etapa es SIEMPRE por `setEtapa()` / `SET_ETAPA_SQL`, que tocan las
   tres columnas en el mismo UPDATE. Nunca un `SET estado_credito=…` suelto.
   LEER la etapa es SIEMPRE por `ETAPA_SQL(alias)`, la misma expresión canónica
   que usa el listado de créditos, para que nadie invente su propio CASE.

   OJO — no toda fila con las tres columnas distintas está mala: las ~16.000
   solicitudes de la carga masiva diaria de AUTOFIN viven con `estado` VACÍO a
   propósito (nunca fueron de originación propia). Vacío ≠ discrepancia; por eso
   `desalineados()` solo reporta filas con las TRES pobladas y en desacuerdo.
   ───────────────────────────────────────────────────────────────────────────── */

const COLUMNAS = ['estado', 'estado_credito', 'estado_eval'];

/* Palabras que en `estado` describen la CARTERA, no la etapa de originación.
   Un crédito "EN MORA" está, en etapa, OTORGADO. */
const PALABRAS_CARTERA = ['VIGENTE', 'EN MORA', 'VENCIDO', 'PREPAGADO', 'CASTIGADO'];

const norm = v => String(v == null ? '' : v).trim().toUpperCase();

/* Fragmento SET para un UPDATE escrito a mano. Consume UN solo placeholder por
   columna, así que hay que pasar la etapa TRES veces en los valores.
   Uso:  `UPDATE creditos SET ${SET_ETAPA_SQL}, otra=? WHERE id=?`
         [etapa, etapa, etapa, otra, id]   ← o mejor, valoresEtapa(etapa) */
const SET_ETAPA_SQL = 'estado = ?, estado_credito = ?, estado_eval = ?';

/** Los tres valores que consume SET_ETAPA_SQL, en orden. */
const valoresEtapa = etapa => { const e = norm(etapa); return [e, e, e]; };

/* Fragmento SET para procesos que NO fijan una etapa única sino que sincronizan
   desde una fuente externa (carga Trinidad, edición manual), donde
   `estado_credito` y `estado_eval` pueden diferir legítimamente entre sí porque
   la fuente los mapea distinto. Acá solo se acompaña `estado` para que no quede
   contradiciendo a las otras dos, con dos resguardos:
     · si `estado` guarda una palabra de CARTERA de un crédito propio se respeta
       (esa dimensión no es la etapa; pisarla borraría el dato);
     · si el valor entrante es NULL no se toca nada.
   Consume UN placeholder: el valor de la etapa entrante. */
const SET_ESTADO_SQL =
  `estado = CASE WHEN estado IN (${PALABRAS_CARTERA.map(p => `'${p}'`).join(',')})
                 THEN estado ELSE COALESCE(?, estado) END`;

/**
 * Expresión SQL canónica para LEER la etapa. Es la misma que usa el listado de
 * créditos: `estado` manda cuando está poblada (reinterpretando las palabras de
 * cartera), y si no se cae a las otras dos.
 * @param {string} alias alias de la tabla `creditos` en la consulta
 */
function ETAPA_SQL(alias = 'c') {
  const a = alias ? alias + '.' : '';
  return `CASE
      WHEN ${a}estado IN (${PALABRAS_CARTERA.map(p => `'${p}'`).join(',')}) THEN 'OTORGADO'
      WHEN ${a}estado IS NOT NULL AND ${a}estado <> '' THEN ${a}estado
      WHEN ${a}financiera IN ('AUTOFIN','UNIDAD DE CREDITO') AND ${a}estado_eval = 'OTORGADO' THEN 'OTORGADO'
      WHEN ${a}estado_credito = 'OTORGADO' OR ${a}estado_eval = 'OTORGADO' THEN 'OTORGADO'
      WHEN ${a}estado_eval = 'ANULADO' OR ${a}estado_credito = 'ANULADO' THEN 'ANULADO'
      WHEN ${a}estado_eval IN ('RECHAZADO','ANULADO') THEN 'CANCELADO'
      ELSE COALESCE(${a}estado_credito, ${a}estado_eval)
    END`;
}

/** Condición `etapa = 'X'` lista para un WHERE, sin repetir el CASE a mano. */
const ES_ETAPA = (etapa, alias = 'c') => `${ETAPA_SQL(alias)} = '${norm(etapa)}'`;

/**
 * Fija la etapa de uno o varios créditos escribiendo LAS TRES columnas.
 * @param {number|number[]} id  id(s) de `creditos` (PK real: `id`, no `id_credito`)
 * @param {string} etapa        OTORGADO / ANULADO / DESISTIDO / …
 * @param {object} [opts]
 * @param {object} [opts.conn]  conexión/transacción; por defecto el pool compartido
 * @param {string[]} [opts.extraSets] fragmentos `col=?` adicionales del mismo UPDATE
 * @param {any[]}  [opts.extraVals]   valores de esos fragmentos
 * @returns {Promise<number>} filas afectadas
 */
async function setEtapa(id, etapa, opts = {}) {
  const ids = (Array.isArray(id) ? id : [id]).filter(v => v != null && v !== '');
  const e = norm(etapa);
  if (!ids.length || !e) return 0;

  const db = opts.conn || require('./config/database');
  const extraSets = opts.extraSets || [];
  const extraVals = opts.extraVals || [];

  const [r] = await db.query(
    `UPDATE creditos SET ${SET_ETAPA_SQL}${extraSets.length ? ', ' + extraSets.join(', ') : ''}
      WHERE id IN (?)`,
    [...valoresEtapa(e), ...extraVals, ids]);
  return r.affectedRows || 0;
}

/**
 * Créditos cuya etapa quedó partida: las TRES columnas pobladas y en desacuerdo.
 * Es la lista de pendientes del motor — si algo aparece acá, algún proceso
 * escribió la etapa sin pasar por `setEtapa()`.
 */
async function desalineados(limite = 200) {
  const pool = require('./config/database');
  const [rows] = await pool.query(`
    SELECT id, num_op, financiera, automotora, estado, estado_credito, estado_eval, fecha_otorgado
      FROM creditos
     WHERE COALESCE(estado,'') <> ''
       AND (UPPER(COALESCE(estado,'')) <> UPPER(COALESCE(estado_credito,''))
         OR UPPER(COALESCE(estado,'')) <> UPPER(COALESCE(estado_eval,'')))
     ORDER BY fecha_otorgado DESC
     LIMIT ?`, [limite]);
  return rows;
}

module.exports = {
  COLUMNAS, PALABRAS_CARTERA, SET_ETAPA_SQL, SET_ESTADO_SQL,
  valoresEtapa, ETAPA_SQL, ES_ETAPA, setEtapa, desalineados, norm,
};
