const pool = require('../../../../shared/config/database');

/* ─────────────────────────────────────────────────────────────────────────────
   Motor de ESTADO DE CARTERA (recursos propios / AutoFácil).
   Clasifica cada crédito propio por días de atraso de la cuota impaga más antigua,
   usando el MISMO calendario que Pagar Cuotas (vencimiento cuota N =
   fecha_primera_cuota + (N-1) meses). Estados automáticos: VIGENTE / EN MORA /
   VENCIDO. Cierres por saldo 0: PREPAGADO (antes del plazo) / TERMINADO (al plazo).
   CASTIGADO es manual: el motor NO lo toca.

   ADITIVO Y SEGURO: solo escribe la columna nueva `creditos.estado_cartera`.
   NO toca `creditos.estado` (que hoy mezcla etapa/cartera) — esa reconciliación es
   una fase posterior. Sin enforcement: calcula y muestra, no bloquea nada.
   ───────────────────────────────────────────────────────────────────────────── */

const BROKERAGE = ['AUTOFIN', 'UNIDAD DE CREDITO'];
const DIA = 86400000;

async function getUmbrales() {
  try {
    const [rows] = await pool.query('SELECT clave, valor FROM cartera_parametros');
    const m = {}; rows.forEach(r => { m[r.clave] = parseInt(r.valor, 10); });
    return {
      mora:    Number.isFinite(m.mora_desde)    ? m.mora_desde    : 1,
      vencido: Number.isFinite(m.vencido_desde) ? m.vencido_desde : 91,
    };
  } catch { return { mora: 1, vencido: 91 }; }
}

// mysql2 entrega DATE como Date a medianoche UTC → usar componentes UTC.
function ymdUTC(v) {
  if (v == null) return null;
  if (v instanceof Date) return Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
  const s = String(v).slice(0, 10).split('-');
  if (s.length < 3) return null;
  return Date.UTC(+s[0], (+s[1]) - 1, +s[2]);
}
function addMonthsUTC(baseMs, n) {
  const d = new Date(baseMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate());
}
function hoyUTC() {
  const n = new Date();
  return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate());
}

// Clasifica un crédito propio → { estado, dias } o null si faltan datos.
function clasificar(cred, paidSet, hoy, um) {
  const plazo = parseInt(cred.plazo, 10) || 0;
  const f0 = ymdUTC(cred.fecha_primera_cuota);
  if (!plazo || f0 == null) return null;

  // Cuota impaga más antigua (1..plazo)
  let oldest = 0;
  for (let n = 1; n <= plazo; n++) { if (!paidSet.has(n)) { oldest = n; break; } }

  if (oldest === 0) {                      // todas pagadas → saldo 0
    const lastDue = addMonthsUTC(f0, plazo - 1);
    return { estado: hoy < lastDue ? 'PREPAGADO' : 'TERMINADO', dias: 0 };
  }
  const venc = addMonthsUTC(f0, oldest - 1);
  const dias = Math.max(0, Math.floor((hoy - venc) / DIA));
  let estado = 'VIGENTE';
  if (dias >= um.vencido) estado = 'VENCIDO';
  else if (dias >= um.mora) estado = 'MORA';
  return { estado, dias };
}

/* Recalcula el estado de cartera de todos los créditos propios.
   Devuelve { procesados, cambios, porEstado, umbrales }. */
async function recalcularEstadoCartera() {
  const um = await getUmbrales();
  const hoy = hoyUTC();

  const [creds] = await pool.query(
    `SELECT id_credito, plazo, fecha_primera_cuota, estado_cartera
     FROM creditos
     WHERE (financiera IS NULL OR financiera NOT IN (?, ?))
       AND estado IN ('VIGENTE','OTORGADO')
       AND fecha_primera_cuota IS NOT NULL AND plazo > 0`,
    BROKERAGE);

  if (!creds.length) return { procesados: 0, cambios: 0, porEstado: {}, umbrales: um };

  // Cuotas pagadas de todos los candidatos en una sola consulta (evita N+1).
  const ids = creds.map(c => c.id_credito);
  const paidByCred = {};
  const [pagos] = await pool.query(
    `SELECT id_credito, numero_cuota FROM pagos_credito
     WHERE estado_pago='PAGADO' AND id_credito IN (?)`, [ids]);
  pagos.forEach(p => { (paidByCred[p.id_credito] = paidByCred[p.id_credito] || new Set()).add(parseInt(p.numero_cuota, 10)); });

  let procesados = 0, cambios = 0; const porEstado = {};
  for (const c of creds) {
    // Castigado es manual → el motor no lo mueve.
    if (String(c.estado_cartera || '').toUpperCase() === 'CASTIGADO') {
      porEstado.CASTIGADO = (porEstado.CASTIGADO || 0) + 1;
      continue;
    }
    const r = clasificar(c, paidByCred[c.id_credito] || new Set(), hoy, um);
    if (!r) continue;
    procesados++;
    porEstado[r.estado] = (porEstado[r.estado] || 0) + 1;
    if (String(c.estado_cartera || '') !== r.estado) {
      await pool.query('UPDATE creditos SET estado_cartera=? WHERE id_credito=?', [r.estado, c.id_credito]);
      cambios++;
    }
  }
  return { procesados, cambios, porEstado, umbrales: um };
}

module.exports = { recalcularEstadoCartera, clasificar };
