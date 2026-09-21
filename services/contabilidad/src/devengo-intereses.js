'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   DEVENGO MENSUAL DE INTERESES — cartera propia (AUTOFACIL). Pato, 21-09-2026.

   · Cada mes cerrado se reconoce el interés corriente ganado en ese mes aunque el cliente no
     haya pagado: DEBE 1104120 INTERESES DEVENGADOS POR COBRAR / HABER 3001010 INTERESES POR
     CONTRATOS (regla DEVENGO_INTERESES, editable en Reglas de Centralización).
   · Por cuota, lineal por días: el interés de la cuota N (tabla de desarrollo congelada,
     cuotas_credito.interes) se reparte entre los días de su período (vencimiento N-1 → N; la
     cuota 1 parte en la fecha de otorgamiento). Al mes le toca la parte de sus días.
   · DEVENGO SUSPENDIDO: si al cierre del mes la cuota impaga más antigua tiene más de
     `devengo_dias_suspension` días de mora (90 → desde el día 91), el crédito no devenga ese mes;
     su interés se reconoce recién cuando se cobra. Lo ya devengado queda por cobrar.
   · Nunca dos veces: lo devengado de una cuota se descuenta de lo que se devengue después, y lo
     que ya entró como ingreso al cobrar también. Al cobrar, el interés paga primero lo devengado
     pendiente (HABER 1104120) y solo el resto es ingreso (HABER 3001010) → imputarInteres().
   · Parámetros (ctb_config): devengo_desde (primer mes, AAAA-MM), devengo_dias_suspension.
   · Motor automático `devengo-intereses`: diario; cuando hay un mes terminado sin devengar, lo genera.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../shared/config/database');
const { hoyISO } = require('../../../shared/fecha-chile');

require('../../../shared/migrate').enFila('ctb-devengo-intereses', async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS ctb_devengo_intereses (
    mes CHAR(7) NOT NULL, id_credito INT NOT NULL, num_op VARCHAR(30) NULL, numero_cuota INT NOT NULL,
    dias INT NOT NULL DEFAULT 0, interes DECIMAL(14,0) NOT NULL DEFAULT 0,
    PRIMARY KEY (mes, id_credito, numero_cuota), INDEX idx_cred (id_credito, numero_cuota))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ctb_devengo_meses (
    mes CHAR(7) PRIMARY KEY, total DECIMAL(14,0) NOT NULL DEFAULT 0, creditos INT NOT NULL DEFAULT 0,
    suspendidos INT NOT NULL DEFAULT 0, detalle_suspendidos TEXT NULL, id_comprobante INT NULL,
    creado_por VARCHAR(160) NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  // Cómo se imputó el interés de cada cobro: DEV = pagó interés devengado (1104120), ING = ingreso directo (3001010)
  await pool.query(`CREATE TABLE IF NOT EXISTS ctb_devengo_aplicaciones (
    id INT AUTO_INCREMENT PRIMARY KEY, id_credito INT NOT NULL, numero_cuota INT NOT NULL,
    ref VARCHAR(40) NOT NULL, tipo CHAR(3) NOT NULL, monto DECIMAL(14,0) NOT NULL,
    reversado TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_cc (id_credito, numero_cuota), INDEX idx_ref (ref))`);
  // Parámetros en ctb_config (texto; parametros_credito.valor es numérico y truncaba 'AAAA-MM')
  await pool.query('CREATE TABLE IF NOT EXISTS ctb_config (clave VARCHAR(60) PRIMARY KEY, valor VARCHAR(200) NOT NULL)');
  await pool.query("INSERT IGNORE INTO ctb_config (clave, valor) VALUES ('devengo_desde','2026-09'), ('devengo_dias_suspension','90')");
  await pool.query("DELETE FROM parametros_credito WHERE clave IN ('devengo_desde','devengo_dias_suspension')");
});

const param = async (clave, def) => {
  const [[r]] = await pool.query('SELECT valor FROM ctb_config WHERE clave=?', [clave]);
  return r && r.valor != null && r.valor !== '' ? r.valor : def;
};
const ultimoDia = mes => { const [y, m] = mes.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const dia = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;   // días enteros, sin TZ
const mesAnterior = mes => { const [y, m] = mes.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };

/* Lo ya reconocido de cada cuota: devengado en meses anteriores + ingreso directo al cobrar */
async function reconocidoPorCuota(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const [d] = await pool.query('SELECT id_credito, numero_cuota, SUM(interes) m FROM ctb_devengo_intereses WHERE id_credito IN (?) GROUP BY id_credito, numero_cuota', [ids]);
  const [a] = await pool.query("SELECT id_credito, numero_cuota, SUM(monto) m FROM ctb_devengo_aplicaciones WHERE tipo='ING' AND reversado=0 AND id_credito IN (?) GROUP BY id_credito, numero_cuota", [ids]);
  for (const r of [...d, ...a]) { const k = `${r.id_credito}:${r.numero_cuota}`; out.set(k, (out.get(k) || 0) + Number(r.m)); }
  return out;
}

/* Cálculo del devengo de un mes (sin escribir). */
async function calcular(mes) {
  const desde = await param('devengo_desde', '2026-09');
  const diasSusp = Number(await param('devengo_dias_suspension', '90')) || 90;
  const fin = ultimoDia(mes), ini = `${mes}-01`, iniDesde = `${desde}-01`;
  const [creds] = await pool.query(
    `SELECT id, num_op, DATE_FORMAT(fecha_otorgado,'%Y-%m-%d') fo FROM creditos
      WHERE UPPER(financiera)='AUTOFACIL' AND UPPER(COALESCE(estado_cartera,'')) NOT IN ('PREPAGADO','PAGADO','CASTIGADO','ANULADO')
        AND fecha_otorgado IS NOT NULL AND fecha_otorgado <= ?`, [fin]);
  if (!creds.length) return { mes, fin, total: 0, filas: [], suspendidos: [], creditos: 0 };
  const ids = creds.map(c => c.id);
  const [cuotas] = await pool.query(
    `SELECT id_credito, numero_cuota, DATE_FORMAT(fecha_vencimiento,'%Y-%m-%d') venc, interes, estado_cuota
       FROM cuotas_credito WHERE id_credito IN (?) ORDER BY id_credito, numero_cuota`, [ids]);
  const rec = await reconocidoPorCuota(ids);
  const filas = [], suspendidos = [];
  for (const c of creds) {
    const qs = cuotas.filter(q => q.id_credito === c.id);
    const impaga = qs.find(q => q.estado_cuota !== 'PAGADA' && q.venc && q.venc <= fin);
    const diasMora = impaga ? dia(fin) - dia(impaga.venc) : 0;
    if (diasMora > diasSusp) { suspendidos.push({ num_op: c.num_op, dias_mora: diasMora }); continue; }
    let prev = c.fo;
    for (const q of qs) {
      const pIni = prev; prev = q.venc;
      if (!q.venc || !pIni || !(Number(q.interes) > 0)) continue;
      if (q.estado_cuota === 'PAGADA') continue;                          // pagada: su interés ya se reconoció al cobrarla
      const largo = dia(q.venc) - dia(pIni);
      if (largo <= 0 || q.venc < ini || pIni >= fin) continue;             // período fuera del mes
      // Días del período transcurridos hasta el cierre del mes, contando solo desde `devengo_desde`
      const desdeCuenta = pIni >= iniDesde ? dia(pIni) : dia(iniDesde) - 1;
      const hasta = Math.min(dia(q.venc), dia(fin));
      const diasAcum = Math.max(0, hasta - desdeCuenta);
      const acumulable = Math.round(Number(q.interes) * diasAcum / largo);
      const ya = rec.get(`${c.id}:${q.numero_cuota}`) || 0;
      const monto = Math.max(0, acumulable - ya);
      const diasMes = Math.max(0, hasta - Math.max(dia(pIni), dia(ini) - 1));
      if (monto > 0) filas.push({ id_credito: c.id, num_op: c.num_op, numero_cuota: q.numero_cuota, dias: diasMes, interes: monto });
    }
  }
  return { mes, fin, total: filas.reduce((s, f) => s + f.interes, 0), filas, suspendidos, creditos: new Set(filas.map(f => f.id_credito)).size };
}

/* Genera y contabiliza el devengo de un mes terminado. Idempotente por mes. */
async function generar(mes, usuario = 'Motor devengo-intereses') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes || '')) throw new Error('Mes inválido (AAAA-MM)');
  const desde = await param('devengo_desde', '2026-09');
  if (mes < desde) throw new Error(`El devengo parte en ${desde}`);
  if (mes >= hoyISO().slice(0, 7)) throw new Error('Solo se devengan meses terminados');
  const [[ya]] = await pool.query('SELECT mes FROM ctb_devengo_meses WHERE mes=?', [mes]);
  if (ya) throw new Error(`El devengo de ${mes} ya está generado`);
  const r = await calcular(mes);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [ins] = await conn.query('INSERT IGNORE INTO ctb_devengo_meses (mes, total, creditos, suspendidos, detalle_suspendidos, creado_por) VALUES (?,?,?,?,?,?)',
      [mes, r.total, r.creditos, r.suspendidos.length, r.suspendidos.map(s => `OP ${s.num_op} (${s.dias_mora} días)`).join(', ') || null, usuario]);
    if (!ins.affectedRows) { await conn.rollback(); throw new Error(`El devengo de ${mes} ya está generado`); }
    for (const f of r.filas) await conn.query('INSERT INTO ctb_devengo_intereses (mes, id_credito, num_op, numero_cuota, dias, interes) VALUES (?,?,?,?,?,?)',
      [mes, f.id_credito, f.num_op, f.numero_cuota, f.dias, f.interes]);
    await conn.commit();
  } catch (e) { try { await conn.rollback(); } catch (_) {} throw e; } finally { conn.release(); }
  let id = null;
  if (r.total > 0) {
    id = await require('./motor-asientos').contabilizar({
      evento: 'DEVENGO_INTERESES', fecha: r.fin, ref: `DEV-INT-${mes}`, montos: { total: r.total },
      glosa: `Devengo intereses cartera propia ${mes} — ${r.creditos} crédito(s), ${r.suspendidos.length} en devengo suspendido`,
      detalle: `Devengo ${mes}`,
    });
    await pool.query('UPDATE ctb_devengo_meses SET id_comprobante=? WHERE mes=?', [id, mes]);
  }
  console.log(`[devengo-intereses] ${mes}: $${r.total} en ${r.creditos} crédito(s), ${r.suspendidos.length} suspendido(s), comprobante ${id || '—'}`);
  return { ...r, id_comprobante: id };
}

/* Al cobrar: el interés de cada cuota paga primero lo devengado pendiente (→ 1104120) y el resto
   es ingreso directo (→ 3001010). Registra la imputación (ref del pago) para no devengarlo después
   ni aplicarlo dos veces. filas: [{ numero_cuota, interes }]. Devuelve { devengado, ingreso }. */
async function imputarInteres(id_credito, filas, ref) {
  let devengado = 0, ingreso = 0;
  for (const f of filas) {
    const i = Math.round(Number(f.interes) || 0);
    if (!(i > 0) || !f.numero_cuota) continue;
    const [[d]] = await pool.query('SELECT COALESCE(SUM(interes),0) m FROM ctb_devengo_intereses WHERE id_credito=? AND numero_cuota=?', [id_credito, f.numero_cuota]);
    const [[a]] = await pool.query("SELECT COALESCE(SUM(monto),0) m FROM ctb_devengo_aplicaciones WHERE id_credito=? AND numero_cuota=? AND tipo='DEV' AND reversado=0", [id_credito, f.numero_cuota]);
    const pend = Math.max(0, Number(d.m) - Number(a.m));
    const aDev = Math.min(i, pend), aIng = i - aDev;
    if (aDev) await pool.query("INSERT INTO ctb_devengo_aplicaciones (id_credito, numero_cuota, ref, tipo, monto) VALUES (?,?,?,'DEV',?)", [id_credito, f.numero_cuota, ref, aDev]);
    if (aIng) await pool.query("INSERT INTO ctb_devengo_aplicaciones (id_credito, numero_cuota, ref, tipo, monto) VALUES (?,?,?,'ING',?)", [id_credito, f.numero_cuota, ref, aIng]);
    devengado += aDev; ingreso += aIng;
  }
  return { devengado, ingreso };
}

/* Reversa de un pago: deshace su imputación (por ref + cuota) y dice cuánto era devengado / ingreso. */
async function revertirImputacion(id_credito, numero_cuota, ref) {
  const [rows] = await pool.query('SELECT id, tipo, monto FROM ctb_devengo_aplicaciones WHERE id_credito=? AND numero_cuota=? AND ref=? AND reversado=0', [id_credito, numero_cuota, ref]);
  if (!rows.length) return null;   // pago anterior al devengo: el llamador usa su propio desglose
  await pool.query('UPDATE ctb_devengo_aplicaciones SET reversado=1 WHERE id IN (?)', [rows.map(r => r.id)]);
  return { devengado: rows.filter(r => r.tipo === 'DEV').reduce((s, r) => s + Number(r.monto), 0),
           ingreso: rows.filter(r => r.tipo === 'ING').reduce((s, r) => s + Number(r.monto), 0) };
}

/* Motor automático: cada día revisa si el mes anterior quedó sin devengar */
async function tick() {
  try {
    const mes = mesAnterior(hoyISO().slice(0, 7));
    const desde = await param('devengo_desde', '2026-09');
    if (mes < desde) return;
    const [[ya]] = await pool.query('SELECT mes FROM ctb_devengo_meses WHERE mes=?', [mes]);
    if (!ya) await generar(mes);
  } catch (e) { console.error('[devengo-intereses]', e.message); }
}
require('../../../shared/scheduler.js').programar('devengo-intereses', tick, 24 * 60 * 60 * 1000, { arranqueMs: 5 * 60 * 1000 });

module.exports = { calcular, generar, imputarInteres, revertirImputacion };
