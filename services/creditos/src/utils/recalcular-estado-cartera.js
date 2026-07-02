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

const AF_MORA = require('../../../../api-gateway/public/js/mora-core');   // MOTOR ÚNICO de mora

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
// Adapter sobre el MOTOR ÚNICO (mora-core): calendario francés sintético + pagos.
function clasificar(cred, paidSet, hoy, um) {
  const r = AF_MORA.estadoMora({
    plazo: cred.plazo, fecha_primera_cuota: cred.fecha_primera_cuota,
    cuota: cred.cuota, pagadas: paidSet, hoy: new Date(hoy), umbrales: um,
  });
  if (!r) return null;
  return { estado: r.estado, dias: r.dias };
}

/* Recalcula el estado de cartera de todos los créditos propios.
   Devuelve { procesados, cambios, porEstado, umbrales }. */
async function recalcularEstadoCartera() {
  const um = await getUmbrales();
  const hoy = hoyUTC();

  const [creds] = await pool.query(
    `SELECT id AS id_credito, plazo, fecha_primera_cuota, estado_cartera
     FROM creditos
     WHERE (financiera IS NULL OR financiera NOT IN (?, ?))
       AND estado IN ('VIGENTE','OTORGADO')
       AND fecha_primera_cuota IS NOT NULL AND plazo > 0`,
    BROKERAGE);

  if (!creds.length) return { procesados: 0, cambios: 0, porEstado: {}, umbrales: um };

  // Cuotas pagadas = pagos en app ∪ calendario congelado (cartera migrada trae su
  // historial en cuotas_credito.estado_cuota='PAGADA'). Una consulta, sin N+1.
  const ids = creds.map(c => c.id_credito);
  const paidByCred = {};
  const [pagos] = await pool.query(
    `SELECT id_credito, numero_cuota FROM pagos_credito
     WHERE estado_pago='PAGADO' AND id_credito IN (?)
     UNION
     SELECT id_credito, numero_cuota FROM cuotas_credito
     WHERE estado_cuota='PAGADA' AND id_credito IN (?)`, [ids, ids]);
  pagos.forEach(p => { (paidByCred[p.id_credito] = paidByCred[p.id_credito] || new Set()).add(parseInt(p.numero_cuota, 10)); });

  // Calendario congelado: vencimiento REAL de la cuota impaga más antigua (manda
  // sobre el derivado fecha_primera_cuota + N meses cuando el crédito lo tiene).
  const vencRealByCred = {};
  const [vreal] = await pool.query(
    `SELECT id_credito, MIN(fecha_vencimiento) venc FROM cuotas_credito
     WHERE estado_cuota<>'PAGADA' AND id_credito IN (?) GROUP BY id_credito`, [ids]);
  vreal.forEach(v => { vencRealByCred[v.id_credito] = ymdUTC(v.venc); });

  let procesados = 0, cambios = 0; const porEstado = {};
  for (const c of creds) {
    // Castigado es manual → el motor no lo mueve.
    if (String(c.estado_cartera || '').toUpperCase() === 'CASTIGADO') {
      porEstado.CASTIGADO = (porEstado.CASTIGADO || 0) + 1;
      continue;
    }
    const r = clasificar(c, paidByCred[c.id_credito] || new Set(), hoy, um);
    if (!r) continue;
    // Si hay calendario real y el crédito tiene impagas, los días salen del venc real
    const vr = vencRealByCred[c.id_credito];
    if (vr != null && r.estado !== 'PREPAGADO' && r.estado !== 'TERMINADO') {
      const dias = Math.max(0, Math.floor((hoy - vr) / DIA));
      r.dias = dias;
      r.estado = AF_MORA.clasificarPorDias(dias, um);   // umbrales: motor único
    }
    procesados++;
    porEstado[r.estado] = (porEstado[r.estado] || 0) + 1;
    if (String(c.estado_cartera || '') !== r.estado) {
      await pool.query('UPDATE creditos SET estado_cartera=? WHERE id=?', [r.estado, c.id_credito]);
      cambios++;
    }
  }
  return { procesados, cambios, porEstado, umbrales: um };
}

module.exports = { recalcularEstadoCartera, clasificar };
