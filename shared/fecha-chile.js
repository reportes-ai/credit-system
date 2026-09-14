'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   MOTOR ÚNICO de "qué día es" en hora de Chile.

   El error que viene a matar: `new Date().toISOString().slice(0, 10)`. Parece
   inofensivo y está en medio repo, pero toISOString() SIEMPRE entrega UTC, así
   que entre las 20:00 y la medianoche devuelve el día SIGUIENTE. Consecuencias
   reales encontradas: rangos "hasta hoy" que ya incluían mañana, el primer día
   de una serie corrido un día hacia atrás, y un mes por defecto que cambiaba
   solo la última noche del mes.

   Igual de traicionero: `new Date('2026-08-16')` (fecha suelta, sin hora) se
   parsea como MEDIANOCHE UTC, que en Chile son las 20:00 del día ANTERIOR. Por
   eso desdeISO() ancla al mediodía: ahí ningún huso ni horario de verano cruza
   la frontera del día.

   Reglas de uso:
   - ¿Necesitas el día de hoy para una consulta o un filtro? → hoyISO()
   - ¿Tienes un Date (o algo que vino de la base) y quieres su día? → isoDe()
   - ¿Tienes un 'YYYY-MM-DD' y necesitas hacerle aritmética (± días/meses)?
     → desdeISO(), opera, y vuelve con isoDe()
   - Dentro de SQL, sigue siendo preferible DATE_FORMAT()/CURDATE(): no salen
     de la base y no hay conversión que equivocar.
   ───────────────────────────────────────────────────────────────────────────── */

const TZ = 'America/Santiago';

/* Día de un Date en hora de Chile, como 'YYYY-MM-DD'. 'en-CA' da justo ese
   formato, y con timeZone explícito no depende de cómo esté configurado el
   proceso ni el servidor. */
function isoDe(d) {
  if (d == null || d === '') return null;
  const f = (d instanceof Date) ? d : new Date(d);
  if (isNaN(f)) return null;
  return f.toLocaleDateString('en-CA', { timeZone: TZ });
}

/* ── EL MES, VENGA COMO VENGA ────────────────────────────────────────────────
   'YYYY-MM' de un mes que puede llegar como Date (columna DATE leída por mysql2)
   o como texto. Nace de un fallo mudo: las columnas de mes son DATE, así que
   `String(mes).slice(0,7)` daba **"Sat Aug"**, isMesCerrado no reconocía el
   formato y NINGÚN mes resultaba cerrado — el candado que protege los meses
   liquidados llevaba tiempo abierto sin que nada lo acusara.

   Un Date se convierte con isoDe (zona de Chile) y no con toISOString(): la
   marca de un mes es su día 1 a las 00:00 de Chile, que en UTC ya es otro día y,
   en el borde, otro mes. Un texto que ya viene bien se recorta y punto: pasar
   '2026-08' por `new Date()` lo leería como UTC y en Chile daría julio. */
function mesDe(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    // Un Date acá SIEMPRE viene de la base (columna DATE): se deshace el offset de mysql2,
    // no el de la zona (ver isoDeBD: el borde del cambio de hora corría el mes).
    const iso = isoDeBD(v);
    return iso ? iso.slice(0, 7) : null;
  }
  const m = String(v).match(/^(\d{4}-\d{2})/);
  return m ? m[1] : null;
}

// Hoy en Chile.
const hoyISO = () => isoDe(new Date());

// Mes de hoy en Chile, 'YYYY-MM'.
const mesActualISO = () => hoyISO().slice(0, 7);

/* 'YYYY-MM-DD' → Date anclado al MEDIODÍA local, seguro para sumar o restar
   días y meses sin que el resultado se caiga al día vecino. */
function desdeISO(s) {
  const t = String(s || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  return new Date(`${t}T12:00:00`);
}

// Suma (o resta, con n negativo) días a un 'YYYY-MM-DD'. Devuelve 'YYYY-MM-DD'.
function sumarDias(iso, n) {
  const d = desdeISO(iso); if (!d) return null;
  d.setDate(d.getDate() + (Number(n) || 0));
  return isoDe(d);
}

// Suma (o resta) meses a un 'YYYY-MM-DD'. El 31 de un mes largo cae donde JS lo deje.
function sumarMeses(iso, n) {
  const d = desdeISO(iso); if (!d) return null;
  d.setMonth(d.getMonth() + (Number(n) || 0));
  return isoDe(d);
}

// Primer día del mes de un 'YYYY-MM-DD' (o de hoy si no se pasa nada).
function primerDiaMes(iso) {
  const t = String(iso || hoyISO()).slice(0, 7);
  return `${t}-01`;
}

/* Cota superior para comparar contra una columna CON HORA: sin esto, un
   "<= 2026-07-31" se come el día 31 completo, porque compara contra su
   medianoche. */
const finDelDia = iso => `${String(iso).slice(0, 10)} 23:59:59.999999`;

/* ── FECHA LEÍDA DE LA BASE (DATE / DATETIME vía mysql2) ────────────────────
   mysql2 interpreta lo que viene de la base con UN offset fijo para toda la corrida
   (pool.offsetBD(), -03:00 en verano / -04:00 en invierno). Una DATE '2026-09-01' leída
   en verano es 2026-09-01T03:00Z; pero el 1 de septiembre Chile aún estaba en -04:00, así
   que isoDe() (zona de Chile) la muestra como 31 de agosto 23:00 → "2026-08-31". Con ese
   valor la cola de Digitación Faltantes precargó Mes = agosto en 9 ops cursadas en
   septiembre (14-09-2026). La única reconstrucción exacta es deshacer el MISMO offset con
   que mysql2 la interpretó: así vuelve la hora de pared tal cual se guardó, en cualquier
   fecha del año. Úsala para todo Date que venga de la base. */
function isoDeBD(d) {
  if (d == null || d === '') return null;
  if (!(d instanceof Date)) return isoDe(d);
  if (isNaN(d)) return null;
  let off = '-04:00';
  try { off = require('./config/database').offsetBD() || off; } catch (_) {}
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(off);
  const ms = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000 : -4 * 3600000;
  return new Date(d.getTime() + ms).toISOString().slice(0, 10);
}

module.exports = { TZ, isoDe, isoDeBD, mesDe, hoyISO, mesActualISO, desdeISO, sumarDias, sumarMeses, primerDiaMes, finDelDia };
