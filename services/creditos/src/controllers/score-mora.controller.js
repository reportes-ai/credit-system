'use strict';
/* ───────────────────────────────────────────────────────────────────────────
 * SCORE DE MORA — v1 (motor histórico de cartera propia)
 *
 * Con el historial de pagos real (cuotas_credito de las carteras migradas AFA/
 * INDEXA) calcula la tasa de mora por segmento: ubicación (parque/calle), tramo
 * de monto, tramo de plazo y tramo de pie. Sirve de referencia para cuando se
 * vuelva a colocar cartera AutoFácil y para valorizar ventas de cartera.
 *
 * PARAMÉTRICO (mantenedor): qué carteras considerar (cartera_original) y desde
 * cuándo (fecha de vencimiento de las cuotas). Definición de mora: cuota pagada
 * con atraso > X días o impaga vencida hace > X días (X configurable).
 * ─────────────────────────────────────────────────────────────────────────── */
const pool = require('../../../../shared/config/database');

require('../../../../shared/migrate').enFila('score-mora', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS score_mora_config (
      id INT PRIMARY KEY,
      carteras JSON NULL,          -- lista de cartera_original a considerar (vacío = todas)
      desde DATE NULL,             -- solo cuotas con vencimiento >= desde
      dias_mora INT DEFAULT 30,    -- atraso que cuenta como mora
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`);
    await pool.query("INSERT IGNORE INTO score_mora_config (id, carteras, desde, dias_mora) VALUES (1, NULL, NULL, 30)");
    const [[ex]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='score_mora' LIMIT 1");
    if (!ex) {
      await pool.query(
        "INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (390001,'Score de Mora (histórico)','score_mora','/score-mora/','bi-speedometer2')");
      const [[nf]] = await pool.query("SELECT id_funcionalidad FROM funcionalidades WHERE codigo='score_mora' LIMIT 1");
      await pool.query(`INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado)
                        SELECT id_perfil, ?, 1 FROM perfiles WHERE nombre='Administrador'`, [nf.id_funcionalidad]);
    }
  } catch (e) { console.error('[score-mora migration]', e.message); }
});

const errSrv = (res, e, tag) => { console.error(`[${tag}]`, e.message); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); };

async function getConfig() {
  const [[c]] = await pool.query('SELECT carteras, desde, dias_mora FROM score_mora_config WHERE id=1');
  let carteras = c && c.carteras; if (typeof carteras === 'string') { try { carteras = JSON.parse(carteras); } catch { carteras = null; } }
  return { carteras: Array.isArray(carteras) && carteras.length ? carteras : null,
           desde: c && c.desde ? String(c.desde).slice(0, 10) : null,
           dias_mora: (c && +c.dias_mora) || 30 };
}

/* ── GET /api/score-mora/config · PUT /api/score-mora/config ─────────────── */
exports.getConfigHttp = async (req, res) => {
  try {
    const cfg = await getConfig();
    const [cart] = await pool.query("SELECT cartera_original v, COUNT(*) n FROM creditos WHERE cartera_original IS NOT NULL AND cartera_original<>'' GROUP BY 1 ORDER BY n DESC");
    res.json({ success: true, data: { ...cfg, carteras_disponibles: cart }, error: null });
  } catch (e) { errSrv(res, e, 'score-mora config'); }
};
exports.setConfig = async (req, res) => {
  try {
    const b = req.body || {};
    const carteras = Array.isArray(b.carteras) ? b.carteras.filter(Boolean) : [];
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(b.desde)) ? b.desde : null;
    const dias = Math.max(1, parseInt(b.dias_mora) || 30);
    await pool.query('UPDATE score_mora_config SET carteras=?, desde=?, dias_mora=? WHERE id=1',
      [carteras.length ? JSON.stringify(carteras) : null, desde, dias]);
    res.json({ success: true, data: { ok: true }, error: null });
  } catch (e) { errSrv(res, e, 'score-mora setConfig'); }
};

/* Mora por operación según la config (base del motor) */
async function opsConMora(cfg) {
  const conds = ['cc.fecha_vencimiento <= NOW()'];
  const params = [cfg.dias_mora, cfg.dias_mora];
  if (cfg.desde) { conds.push('cc.fecha_vencimiento >= ?'); params.push(cfg.desde); }
  let joinCond = '';
  if (cfg.carteras) { joinCond = ' AND c.cartera_original IN (?)'; params.push(cfg.carteras); }
  const [rows] = await pool.query(`
    SELECT c.num_op,
           MAX(CASE WHEN (cc.fecha_pago IS NOT NULL AND DATEDIFF(cc.fecha_pago, cc.fecha_vencimiento) > ?)
                      OR (cc.fecha_pago IS NULL AND DATEDIFF(NOW(), cc.fecha_vencimiento) > ?) THEN 1 ELSE 0 END) mora,
           MAX(c.parque) parque, MAX(c.tipo_ubicacion) tipo_ubicacion, MAX(c.monto_financiado) monto_financiado,
           MAX(c.plazo) plazo, MAX(c.pie) pie, MAX(c.valor_vehiculo) valor_vehiculo, MAX(c.cartera_original) cartera_original
    FROM cuotas_credito cc
    JOIN creditos c ON c.num_op = cc.num_op
    WHERE ${conds.join(' AND ')}${joinCond}
    GROUP BY c.num_op`, params);
  return rows;
}

const tramoMonto = m => { m = +m || 0; return m <= 0 ? 'sin dato' : m < 3e6 ? '< $3M' : m < 6e6 ? '$3M–$6M' : m < 10e6 ? '$6M–$10M' : '≥ $10M'; };
const tramoPlazo = p => { p = +p || 0; return p <= 0 ? 'sin dato' : p <= 24 ? '≤ 24' : p <= 36 ? '25–36' : '37+'; };
const tramoPie = (pie, precio) => { const pct = (+precio > 0) ? 100 * (+pie || 0) / +precio : null;
  return pct == null ? 'sin dato' : pct < 20 ? '< 20%' : pct < 30 ? '20–30%' : pct < 40 ? '30–40%' : '≥ 40%'; };
const ubic = o => { const u = String(o.tipo_ubicacion || '').toUpperCase();
  if (u === 'PARQUE' || u === 'CALLE') return u;
  return String(o.parque || '').toUpperCase().includes('PARQUE') ? 'PARQUE' : 'CALLE'; };

/* ── GET /api/score-mora/segmentos — tasa de mora por segmento ────────────── */
exports.segmentos = async (req, res) => {
  try {
    const cfg = await getConfig();
    const ops = await opsConMora(cfg);
    const dims = {
      ubicacion:  o => ubic(o),
      monto:      o => tramoMonto(o.monto_financiado),
      plazo:      o => tramoPlazo(o.plazo),
      pie:        o => tramoPie(o.pie, o.valor_vehiculo),
      cartera:    o => o.cartera_original || 'sin cartera',
    };
    const total = ops.length, totalMora = ops.filter(o => +o.mora).length;
    const base = total ? totalMora / total : 0;
    const out = {};
    for (const [dim, fn] of Object.entries(dims)) {
      const g = {};
      for (const o of ops) { const k = fn(o); g[k] = g[k] || { n: 0, mora: 0 }; g[k].n++; if (+o.mora) g[k].mora++; }
      out[dim] = Object.entries(g).map(([seg, v]) => ({
        segmento: seg, ops: v.n, mora: v.mora,
        pct_mora: Math.round(1000 * v.mora / v.n) / 10,
        indice: base > 0 ? Math.round(100 * (v.mora / v.n) / base) / 100 : null,   // 1 = promedio; 2 = el doble de mora
      })).sort((a, b) => b.ops - a.ops);
    }
    res.json({ success: true, data: { config: cfg, total_ops: total, total_mora: totalMora,
      pct_mora_global: Math.round(1000 * base) / 10, dimensiones: out }, error: null });
  } catch (e) { errSrv(res, e, 'score-mora segmentos'); }
};

/* ── GET /api/score-mora/evaluar?monto=&plazo=&pie=&precio=&ubicacion= ─────
   Score relativo de un perfil nuevo = producto de los índices de sus segmentos.
   > 1 = más riesgoso que el promedio histórico; < 1 = menos. */
exports.evaluar = async (req, res) => {
  try {
    const cfg = await getConfig();
    const ops = await opsConMora(cfg);
    const total = ops.length; if (!total) return res.json({ success: true, data: { score: null, detalle: [], nota: 'Sin historial con la configuración actual' }, error: null });
    const base = ops.filter(o => +o.mora).length / total;
    const perfil = {
      ubicacion: String(req.query.ubicacion || '').toUpperCase() === 'PARQUE' ? 'PARQUE' : 'CALLE',
      monto: tramoMonto(req.query.monto),
      plazo: tramoPlazo(req.query.plazo),
      pie: tramoPie(req.query.pie, req.query.precio),
    };
    const fns = { ubicacion: o => ubic(o), monto: o => tramoMonto(o.monto_financiado),
                  plazo: o => tramoPlazo(o.plazo), pie: o => tramoPie(o.pie, o.valor_vehiculo) };
    const detalle = []; let score = 1;
    for (const [dim, seg] of Object.entries(perfil)) {
      const del = ops.filter(o => fns[dim](o) === seg);
      if (del.length < 10) { detalle.push({ dim, segmento: seg, indice: null, nota: 'muestra insuficiente (' + del.length + ')' }); continue; }
      const idx = (del.filter(o => +o.mora).length / del.length) / base;
      detalle.push({ dim, segmento: seg, indice: Math.round(100 * idx) / 100, ops: del.length });
      score *= idx;
    }
    res.json({ success: true, data: { score: Math.round(100 * score) / 100, pct_mora_global: Math.round(1000 * base) / 10, detalle }, error: null });
  } catch (e) { errSrv(res, e, 'score-mora evaluar'); }
};
