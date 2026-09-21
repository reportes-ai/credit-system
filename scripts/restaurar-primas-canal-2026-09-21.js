/* Restaura las primas de seguro que el Informe Canal del 21-09-2026 pisó con $1.
 *
 * Qué pasó: la carga de Ademir (sesión 1680001, TRISolicitudWWExport-29.xlsx +
 * Informe_Canal_AFA_20260920.xlsx, 10:47) trajo las primas como 1 ("tiene seguro") y
 * aplicarCanal las aplicó sobre 195 operaciones AUTOFIN de jul-sep. Ese camino no
 * anotaba el valor anterior, así que se recupera de un dump previo.
 *
 * Uso:
 *   node scripts/restaurar-primas-canal-2026-09-21.js <primas.json>          (dry-run: solo muestra)
 *   node scripts/restaurar-primas-canal-2026-09-21.js <primas.json> --aplicar
 * <primas.json> = { "<num_op>": { seguro_rdh, seguro_cesantia, seguro_rep_menor }, ... } sacado
 * de un dump anterior a la carga (D:\RESPALDO_AUTOFACIL\2026-09-18 o el artefacto nocturno del 21-09).
 *
 * Regla: solo se restaura una columna cuya prima ACTUAL está bajo el piso (0 < x < prima_minima_valida)
 * y cuyo valor en el dump es un monto válido (>= piso) o 0 (no contratado). Nada más se toca.
 * Antes de escribir guarda los valores actuales en scripts/respaldo-primas-canal-<ts>.json.
 * Correr con MOTORES=off.
 */
const fs = require('fs');
const path = require('path');
const pool = require('../shared/config/database');

(async () => {
  const [archivo, flag] = process.argv.slice(2);
  if (!archivo) { console.log('Falta el archivo de primas'); process.exit(1); }
  const aplicar = flag === '--aplicar';
  const antes = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  const [[p]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='prima_minima_valida' LIMIT 1");
  const piso = Number(p && p.valor) >= 0 ? Number(p.valor) : 10000;
  const COLS = ['seguro_rdh', 'seguro_cesantia', 'seguro_rep_menor'];

  const [rows] = await pool.query(
    `SELECT c.id, c.num_op, DATE_FORMAT(c.mes,'%Y-%m') mes, ${COLS.join(', ')}
       FROM creditos c
      WHERE c.financiera = 'AUTOFIN' AND c.mes >= '2026-07-01'
        AND NOT EXISTS (SELECT 1 FROM meses_cerrados mc WHERE mc.mes = DATE_FORMAT(c.mes,'%Y-%m') AND mc.cerrado = 1)
        AND (${COLS.map(k => `(${k} > 0 AND ${k} < ${piso})`).join(' OR ')})`);

  const plan = [], sinRespaldo = [];
  for (const r of rows) {
    const a = antes[String(r.num_op)];
    if (!a) { sinRespaldo.push(r.num_op); continue; }
    const set = {};
    for (const k of COLS) {
      const actual = Number(r[k]), viejo = a[k] == null || a[k] === 'NULL' ? null : Number(a[k]);
      if (actual > 0 && actual < piso && viejo != null && (viejo === 0 || viejo >= piso)) set[k] = viejo;
    }
    if (Object.keys(set).length) plan.push({ id: r.id, num_op: r.num_op, mes: r.mes, actual: Object.fromEntries(COLS.map(k => [k, r[k]])), nuevo: set });
  }

  console.log(`Piso: $${piso} · operaciones con prima bajo el piso: ${rows.length}`);
  console.log(`A restaurar: ${plan.length} · sin dato en el respaldo (digitar o recargar el Canal corregido): ${sinRespaldo.length}`);
  plan.slice(0, 10).forEach(x => console.log(' ', x.num_op, x.mes, JSON.stringify(x.nuevo)));
  if (sinRespaldo.length) console.log('Sin respaldo:', sinRespaldo.join(', '));

  if (!aplicar) { console.log('\nDRY-RUN. Agrega --aplicar para escribir.'); process.exit(0); }

  const bk = path.join(__dirname, `respaldo-primas-canal-${Date.now()}.json`);
  fs.writeFileSync(bk, JSON.stringify(plan, null, 1));
  let ok = 0;
  for (const x of plan) {
    const ks = Object.keys(x.nuevo);
    const [r] = await pool.query(`UPDATE creditos SET ${ks.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...ks.map(k => x.nuevo[k]), x.id]);
    if (r.affectedRows === 1) ok++; else console.log('⚠ sin efecto', x.num_op);
  }
  // Mismo recálculo que la digitación de faltantes (motor único): ingresos x seguros y rentabilidad del mes
  const { recalcularPorOps } = require('../services/creditos/src/utils/recalcular-mes');
  const rc = await recalcularPorOps(plan.map(x => x.id));
  console.log(`Restauradas ${ok}/${plan.length}. Recalculados: ${rc.actualizados}. Valores previos en ${bk}.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
