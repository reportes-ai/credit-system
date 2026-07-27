/* ─────────────────────────────────────────────────────────────────────────────
   SEMANA CORRIDA (art. 45 Código del Trabajo) — MOTOR ÚNICO

   No es una constante. La ley paga los domingos y festivos con el promedio de lo
   devengado en los días efectivamente trabajados, de modo que el factor cambia
   todos los meses:

       incremento = (domingos + festivos del mes) / días efectivamente trabajados
       factor     = 1 + incremento

   La jornada pactada de los ejecutivos comerciales es LUNES A SÁBADO, así que el
   divisor son los días lunes-sábado del mes que no sean feriado. Un feriado que
   cae domingo se cuenta UNA sola vez (no es domingo + festivo).

   Consumidores: comisiones de ejecutivos y Bono Jefe Comercial. Cualquier otro
   cálculo de semana corrida debe usar este módulo, no una constante propia.
   ───────────────────────────────────────────────────────────────────────────── */
const { esFeriado, cargarFeriados } = require('./feriados');

/* Días del mes separados en trabajados vs domingos/festivos.
   jornada: 6 = lunes a sábado (default) · 5 = lunes a viernes */
function diasDelMes(mes, jornada = 6) {
  const [y, m] = String(mes || '').split('-').map(Number);
  if (!y || !m) return null;
  const ultimo = new Date(y, m, 0).getDate();
  let trabajados = 0, dom_festivos = 0;
  for (let d = 1; d <= ultimo; d++) {
    const f = new Date(y, m - 1, d), dow = f.getDay();
    if (dow === 0 || esFeriado(f)) dom_festivos++;      // domingos y festivos
    else if (dow >= 1 && dow <= jornada) trabajados++;  // días de la jornada
  }
  return { dias_mes: ultimo, trabajados, dom_festivos };
}

/* Incremento legal del mes (0,1923 = +19,23%). Devuelve null si no se puede calcular. */
function incrementoMes(mes, jornada = 6) {
  const d = diasDelMes(mes, jornada);
  if (!d || !d.trabajados) return null;
  return d.dom_festivos / d.trabajados;
}

/* Multiplicador del mes (1,1923). fallback se usa si el mes es inválido. */
function factorMes(mes, jornada = 6, fallback = 1) {
  const inc = incrementoMes(mes, jornada);
  return inc == null ? fallback : 1 + inc;
}

/* Los feriados viven en BD y se cargan al bootear. Llamar a esto antes de
   calcular evita depender de que el seed haya alcanzado a correr. */
async function asegurarFeriados() {
  try { await cargarFeriados(); } catch (e) { /* se sigue con lo que haya en memoria */ }
}

module.exports = { diasDelMes, incrementoMes, factorMes, asegurarFeriados };
