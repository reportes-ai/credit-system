'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Reportería Cobranzas — agregaciones para los informes de /cobranza/reporteria
   Fuente de datos: cobranza_gestiones (gestiones) + MORA_SQL (stock moroso vivo).
   Todo read-only; no altera datos. Reusa el motor de mora del controller principal.
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');
const cob  = require('./cobranza.controller');
const MORA_SQL          = cob._motor.MORA_SQL;
const getCobranzaConfig = cob._motor.getCobranzaConfig;

const ok   = (res, data) => res.json({ success: true, data, error: null });
const fail = (res, e, c = 500) => res.status(c).json({ success: false, data: null, error: e });

// Rango de fechas por defecto: últimos 6 meses
function rango(req) {
  const hasta = (req.query.hasta && /^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta)) ? req.query.hasta : null;
  const desde = (req.query.desde && /^\d{4}-\d{2}-\d{2}$/.test(req.query.desde)) ? req.query.desde : null;
  const h = hasta || new Date().toISOString().slice(0, 10);
  let d = desde;
  if (!d) { const x = new Date(h); x.setMonth(x.getMonth() - 6); d = x.toISOString().slice(0, 10); }
  return { desde: d, hasta: h };
}

// Tramos de provisión paramétricos (mantenedor Parámetros Cobranza)
async function tramos() {
  const cfg = await getCobranzaConfig();
  let tp = [];
  try { tp = JSON.parse(cfg.tramos_provision); } catch (_) {}
  if (!Array.isArray(tp) || !tp.length)
    tp = [{ hasta_dias: 15, pct: 1 }, { hasta_dias: 30, pct: 5 }, { hasta_dias: 60, pct: 20 },
          { hasta_dias: 90, pct: 40 }, { hasta_dias: 180, pct: 80 }, { hasta_dias: null, pct: 100 }];
  let prev = 0;
  return tp.map(t => {
    const max = (t.hasta_dias == null || t.hasta_dias === '') ? Infinity : Number(t.hasta_dias);
    const r = { label: max === Infinity ? `${prev + 1}+` : `${prev + 1}-${max}`, min: prev + 1, max, pct: Number(t.pct) || 0 };
    prev = max;
    return r;
  });
}

/* ── GET /reportes/ejecutivos ─ lista para filtros ──────────────────────────── */
exports.ejecutivos = async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT DISTINCT nombre_usuario FROM cobranza_gestiones WHERE nombre_usuario IS NOT NULL AND nombre_usuario<>'' ORDER BY nombre_usuario");
    ok(res, rows.map(r => r.nombre_usuario));
  } catch (e) { fail(res, e.message); }
};

/* ── Funciones de datos (reusables por la IA — un solo motor por informe) ───── */
async function datosRendimiento(desde, hasta) {
  const [rows] = await pool.query(`
      SELECT nombre_usuario AS ejecutivo,
             COUNT(*)                                                       AS gestiones,
             SUM(canal IN ('TELEFONICA','PRESENCIAL'))                      AS telefonicas,
             SUM(canal = 'REMOTA')                                         AS remotas,
             SUM(resultado IN ('CONTACTADO','PROMESA_PAGO'))                AS contactos,
             SUM(resultado = 'PROMESA_PAGO')                                AS promesas,
             COALESCE(SUM(CASE WHEN resultado='PROMESA_PAGO' THEN monto_promesa END),0) AS monto_promesas,
             SUM(confirmado)                                                AS confirmadas
      FROM cobranza_gestiones
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY nombre_usuario
      ORDER BY gestiones DESC`, [desde, hasta]);
  rows.forEach(r => {
    r.gestiones = Number(r.gestiones); r.contactos = Number(r.contactos);
    r.tasa_contacto = r.gestiones ? +(r.contactos / r.gestiones * 100).toFixed(1) : 0;
    ['telefonicas','remotas','promesas','confirmadas','monto_promesas'].forEach(k => r[k] = Number(r[k]));
  });
  return { desde, hasta, ejecutivos: rows };
}

/* ── GET /reportes/rendimiento?desde&hasta ─ por ejecutivo ──────────────────── */
exports.rendimiento = async (req, res) => {
  try { const { desde, hasta } = rango(req); ok(res, await datosRendimiento(desde, hasta)); }
  catch (e) { fail(res, e.message); }
};

/* ── GET /reportes/gestiones?desde&hasta&ejecutivo&resultado&limit ──────────── */
exports.gestiones = async (req, res) => {
  try {
    const { desde, hasta } = rango(req);
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const wh = ['DATE(g.created_at) BETWEEN ? AND ?']; const args = [desde, hasta];
    if (req.query.ejecutivo) { wh.push('g.nombre_usuario = ?'); args.push(req.query.ejecutivo); }
    if (req.query.resultado) { wh.push('g.resultado = ?');      args.push(req.query.resultado); }
    if (req.query.canal)     { wh.push('g.canal = ?');          args.push(req.query.canal); }
    const [rows] = await pool.query(`
      SELECT g.created_at, g.nombre_usuario, g.numero_credito, g.nombre_cliente, g.rut_cliente,
             g.tipo_gestion, g.canal, g.resultado, g.dias_mora, g.monto_mora,
             g.fecha_promesa, g.monto_promesa, g.confirmado
      FROM cobranza_gestiones g
      WHERE ${wh.join(' AND ')}
      ORDER BY g.created_at DESC LIMIT ?`, [...args, limit]);
    // series por día y por resultado / canal para los gráficos
    const [serie] = await pool.query(`
      SELECT DATE(created_at) f, COUNT(*) n
      FROM cobranza_gestiones WHERE DATE(created_at) BETWEEN ? AND ?
      ${req.query.ejecutivo ? 'AND nombre_usuario=?' : ''}
      GROUP BY DATE(created_at) ORDER BY f`,
      req.query.ejecutivo ? [desde, hasta, req.query.ejecutivo] : [desde, hasta]);
    const porResultado = {}, porCanal = {};
    rows.forEach(r => { porResultado[r.resultado] = (porResultado[r.resultado]||0)+1; porCanal[r.canal] = (porCanal[r.canal]||0)+1; });
    ok(res, { desde, hasta, total: rows.length, gestiones: rows,
      serie: serie.map(s => ({ fecha: s.f, n: Number(s.n) })), porResultado, porCanal });
  } catch (e) { fail(res, e.message); }
};

async function datosRecuperacion(desde, hasta) {
  const [rows] = await pool.query(`
      SELECT DATE_FORMAT(created_at,'%Y-%m')                                            AS mes,
             SUM(resultado='PROMESA_PAGO')                                              AS promesas,
             COALESCE(SUM(CASE WHEN resultado='PROMESA_PAGO' THEN monto_promesa END),0) AS monto_prometido,
             SUM(confirmado)                                                            AS gestiones_confirmadas,
             COALESCE(SUM(CASE WHEN resultado='PROMESA_PAGO' AND confirmado=1 THEN monto_promesa END),0) AS monto_confirmado
      FROM cobranza_gestiones
      WHERE DATE(created_at) BETWEEN ? AND ?
      GROUP BY mes ORDER BY mes`, [desde, hasta]);
  rows.forEach(r => ['promesas','monto_prometido','gestiones_confirmadas','monto_confirmado'].forEach(k => r[k] = Number(r[k])));
  const tot = rows.reduce((a, r) => ({ promesas: a.promesas + r.promesas, monto_prometido: a.monto_prometido + r.monto_prometido,
    confirmadas: a.confirmadas + r.gestiones_confirmadas, monto_confirmado: a.monto_confirmado + r.monto_confirmado }),
    { promesas: 0, monto_prometido: 0, confirmadas: 0, monto_confirmado: 0 });
  return { desde, hasta, serie: rows, total: tot };
}

/* ── GET /reportes/recuperacion?desde&hasta ─ promesas y cumplimiento por mes ─ */
exports.recuperacion = async (req, res) => {
  try { const { desde, hasta } = rango(req); ok(res, await datosRecuperacion(desde, hasta)); }
  catch (e) { fail(res, e.message); }
};

async function datosMoraStock() {
  const [rows] = await pool.query(
    `SELECT dias_mora, monto_mora, saldo_insoluto FROM ( ${MORA_SQL()} ) _m`);
  const T = await tramos();
  const buckets = T.map(t => ({ tramo: t.label, pct: t.pct, casos: 0, monto_mora: 0, capital: 0, provision: 0 }));
  let totCasos = 0, totMonto = 0, totCapital = 0, totProv = 0;
  let prejudicial = { casos: 0, monto: 0 }, judicial = { casos: 0, monto: 0 };
  for (const r of rows) {
    const d = Number(r.dias_mora), mm = Number(r.monto_mora) || 0, cap = Number(r.saldo_insoluto) || 0;
    const i = T.findIndex(t => d >= t.min && d <= t.max);
    if (i >= 0) {
      buckets[i].casos++; buckets[i].monto_mora += mm; buckets[i].capital += cap;
      buckets[i].provision += cap * T[i].pct / 100;
    }
    totCasos++; totMonto += mm; totCapital += cap; totProv += (i >= 0 ? cap * T[i].pct / 100 : 0);
    if (d <= 90) { prejudicial.casos++; prejudicial.monto += mm; } else { judicial.casos++; judicial.monto += mm; }
  }
  buckets.forEach(b => { b.monto_mora = Math.round(b.monto_mora); b.capital = Math.round(b.capital); b.provision = Math.round(b.provision); });
  return {
    tramos: buckets,
    total: { casos: totCasos, monto_mora: Math.round(totMonto), capital: Math.round(totCapital), provision: Math.round(totProv) },
    prejudicial: { casos: prejudicial.casos, monto: Math.round(prejudicial.monto) },
    judicial:    { casos: judicial.casos,    monto: Math.round(judicial.monto) }
  };
}

/* ── GET /reportes/mora-stock ─ stock moroso vivo por tramo y por cartera ────── */
exports.moraStock = async (_req, res) => {
  try { ok(res, await datosMoraStock()); } catch (e) { fail(res, e.message); }
};

async function datosCartera({ tipo, tramo, limit } = {}) {
  const having = [];
  if (tipo === 'prejudicial') having.push('dias_mora BETWEEN 1 AND 90');
  else if (tipo === 'judicial') having.push('dias_mora > 90');
  const map = { '1-15': 'dias_mora BETWEEN 1 AND 15', '16-30': 'dias_mora BETWEEN 16 AND 30',
    '31-60': 'dias_mora BETWEEN 31 AND 60', '61-90': 'dias_mora BETWEEN 61 AND 90', '91+': 'dias_mora > 90' };
  if (map[tramo]) having.push(map[tramo]);
  const havingExtra = having.length ? 'AND ' + having.join(' AND ') : '';
  const lim = Math.min(Number(limit) || 3000, 3000);
  const [rows] = await pool.query(`
    SELECT numero_credito, rut_cliente, nombre_cliente, cuotas_mora, dias_mora,
           ROUND(monto_mora) AS monto_mora, ROUND(saldo_insoluto) AS saldo_insoluto
    FROM ( ${MORA_SQL('', havingExtra)} ) _m
    ORDER BY dias_mora DESC LIMIT ?`, [lim]);
  return { total: rows.length, rows };
}

/* ── GET /reportes/cartera?tipo&tramo ─ listado de créditos en mora ──────────── */
exports.cartera = async (req, res) => {
  try { ok(res, await datosCartera({ tipo: req.query.tipo, tramo: req.query.tramo })); }
  catch (e) { fail(res, e.message); }
};

// Motor de datos expuesto para otros consumidores (ej. IA "Pregúntale a AutoFácil")
exports._datos = { datosRendimiento, datosRecuperacion, datosMoraStock, datosCartera };
