'use strict';
/* ════════════════════════════════════════════════════════════════════════
   BONO JEFE COMERCIAL — réplica del BSC (Balanced Scorecard) Excel de RRHH.
   El bono del Jefe Comercial se calcula sobre el PROMEDIO del equipo de
   Ejecutivos Comerciales en 3 pilares del mes:
     · CRÉDITOS otorgados    (pond. 45%)  — tramo mínimo/esperado
     · MONTOS aprobados      (pond. 40%)  — umbrales = ops × monto por op
     · NUEVOS DEALERS cursados (pond. 15%)
   El score del equipo (0–100+) entra a una curva exponencial sobre el
   sueldo fijo: premio = fijo × %variable × (e^(k·x)−1)/(e^k−1), con
   x = (score−mínimo)/(máximo−mínimo); bajo el mínimo el premio es 0.
   Variables paramétricas en bono_jefe_config (pestaña restringida).
   ════════════════════════════════════════════════════════════════════════ */
const pool = require('../../../../shared/config/database');
const { auditar } = require('../../../../shared/audit');

/* ── Migración: tabla de config + funcionalidades (card Soporte) ── */
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bono_jefe_config (
        clave      VARCHAR(40) PRIMARY KEY,
        valor      VARCHAR(40) NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )`);
    const defaults = [
      ['creditos_min', '5'], ['creditos_esperado', '12'], ['pond_creditos', '45'],
      ['monto_por_op', '6800000'], ['pond_montos', '40'],
      ['dealers_min', '1'], ['dealers_esperado', '2'], ['pond_dealers', '15'],
      ['score_min', '80'], ['score_max', '100'], ['pct_variable', '55'], ['k', '0.7'],
      ['sueldo_fijo', '1500000'], ['factor_semana', '0.1667'],
    ];
    for (const [k, v] of defaults)
      await pool.query('INSERT IGNORE INTO bono_jefe_config (clave, valor) VALUES (?,?)', [k, v]);

    // Card en Soporte + permiso de acción para la pestaña Variables
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE ruta='/soporte/' LIMIT 1");
    if (mod) {
      await pool.query(`INSERT INTO funcionalidades (id_modulo, codigo, nombre, href, icono)
        SELECT ?, 'bono_jefe', 'Bono Jefe Comercial', '/soporte/bono-jefe/', 'bi-trophy'
        WHERE NOT EXISTS (SELECT 1 FROM funcionalidades WHERE codigo='bono_jefe')`, [mod.id_modulo]);
      await pool.query(`INSERT INTO funcionalidades (id_modulo, codigo, nombre, href, icono)
        SELECT ?, 'bono_jefe_variables', 'Variables Bono Jefe Comercial', NULL, NULL
        WHERE NOT EXISTS (SELECT 1 FROM funcionalidades WHERE codigo='bono_jefe_variables')`, [mod.id_modulo]);
    }
    console.log('✓ bono_jefe_config lista');
  } catch (e) { console.error('[bono-jefe schema]', e.message); }
})();

async function getCfg() {
  const [rows] = await pool.query('SELECT clave, valor FROM bono_jefe_config');
  const c = {}; rows.forEach(r => { c[r.clave] = parseFloat(r.valor); });
  return {
    creditos_min: c.creditos_min ?? 5, creditos_esperado: c.creditos_esperado ?? 12, pond_creditos: (c.pond_creditos ?? 45) / 100,
    monto_por_op: c.monto_por_op ?? 6800000, pond_montos: (c.pond_montos ?? 40) / 100,
    dealers_min: c.dealers_min ?? 1, dealers_esperado: c.dealers_esperado ?? 2, pond_dealers: (c.pond_dealers ?? 15) / 100,
    score_min: c.score_min ?? 80, score_max: c.score_max ?? 100, pct_variable: (c.pct_variable ?? 55) / 100, k: c.k ?? 0.7,
    sueldo_fijo: c.sueldo_fijo ?? 1500000, factor_semana: c.factor_semana ?? 0.1667,
  };
}

/* ── Puntajes por pilar (fórmulas idénticas al Excel) ── */
const ptjTramo = (v, min, esp, pond) => v < min ? 0 : (v > esp ? pond * 100 : (v / esp) * pond * 100);
const ptjDealers = (v, min, esp, pond) => (v < min ? 0 : v / esp) * pond * 100;   // sin tope, como el Excel

/* Curva del premio (hoja "variable"): % adicional sobre el fijo.
   VLOOKUP aproximado del Excel = se busca el puntaje ENTERO (piso). */
function curvaPct(score, cfg) {
  const s = Math.floor(Math.max(0, score));
  if (s <= cfg.score_min) return 0;
  const x = (s - cfg.score_min) / (cfg.score_max - cfg.score_min);
  return cfg.pct_variable * ((Math.exp(cfg.k * x) - 1) / (Math.exp(cfg.k) - 1));
}
function premioDe(score, cfg) {
  const pct = curvaPct(score, cfg);
  const variable = Math.round(cfg.sueldo_fijo * pct);
  const semana = Math.round(variable * cfg.factor_semana);
  return { score_lookup: Math.floor(Math.max(0, score)), pct_adicional: pct, variable, semana_corrida: semana,
           total_variable: variable + semana, renta_total: cfg.sueldo_fijo + variable + semana };
}

/* ── GET /api/bono-jefe/bsc?mes=YYYY-MM ── */
const getBSC = async (req, res) => {
  try {
    const mes = /^\d{4}-\d{2}$/.test(req.query.mes || '') ? req.query.mes
      : new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    const cfg = await getCfg();

    // Equipo: Ejecutivos Comerciales activos (convención: primer nombre + apellido paterno)
    const [ejs] = await pool.query(
      `SELECT TRIM(CONCAT(SUBSTRING_INDEX(TRIM(u.nombre),' ',1),' ',SUBSTRING_INDEX(TRIM(u.apellido),' ',1))) AS ejecutivo
         FROM usuarios u JOIN perfiles p ON p.id_perfil=u.id_perfil
        WHERE p.nombre='Ejecutivo Comercial' AND u.estado='activo' ORDER BY ejecutivo`);

    // Pilar 1: créditos OTORGADOS del mes
    const [ing] = await pool.query(
      `SELECT ejecutivo, COUNT(*) n FROM creditos
        WHERE DATE_FORMAT(mes,'%Y-%m')=? AND estado_credito='OTORGADO'
          AND ejecutivo IS NOT NULL AND ejecutivo<>'' GROUP BY ejecutivo`, [mes]);
    // Pilar 2: MONTOS aprobados del mes (aprobado u otorgado)
    const [apr] = await pool.query(
      `SELECT ejecutivo, COALESCE(SUM(monto_financiado),0) monto FROM creditos
        WHERE DATE_FORMAT(mes,'%Y-%m')=? AND estado_credito IN ('APROBADO','OTORGADO')
          AND ejecutivo IS NOT NULL AND ejecutivo<>'' GROUP BY ejecutivo`, [mes]);
    // Pilar 3: NUEVOS dealers — fichas de incorporación de dealers APROBADAS en el mes
    // (fecha_revision = cuando se aprobó), atribuidas al ejecutivo que ingresó la ficha
    const [nvd] = await pool.query(
      `SELECT ejecutivo_nombre AS ejecutivo, COUNT(*) n
         FROM dealer_fichas
        WHERE estado='APROBADA' AND DATE_FORMAT(COALESCE(fecha_revision, updated_at),'%Y-%m')=?
        GROUP BY ejecutivo_nombre`, [mes]);

    const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
    const keyEj = s => norm(s).split(' ').filter(Boolean).sort().join(' ');
    const mIng = new Map(ing.map(r => [keyEj(r.ejecutivo), Number(r.n)]));
    const mApr = new Map(apr.map(r => [keyEj(r.ejecutivo), Number(r.monto)]));
    const mNvd = new Map(nvd.map(r => [keyEj(r.ejecutivo), Number(r.n)]));

    const minM = cfg.creditos_min * cfg.monto_por_op, espM = cfg.creditos_esperado * cfg.monto_por_op;
    const filas = ejs.map(e => {
      const k = keyEj(e.ejecutivo);
      const E = mIng.get(k) || 0, H = mApr.get(k) || 0, J = mNvd.get(k) || 0;
      return {
        ejecutivo: e.ejecutivo, otorgados: E,
        ptj_creditos: ptjTramo(E, cfg.creditos_min, cfg.creditos_esperado, cfg.pond_creditos),
        monto_aprobado: H,
        ptj_montos: ptjTramo(H, minM, espM, cfg.pond_montos),
        dealers_nuevos: J,
        ptj_dealers: ptjDealers(J, cfg.dealers_min, cfg.dealers_esperado, cfg.pond_dealers),
      };
    }).map(f => ({ ...f, score: f.ptj_creditos + f.ptj_montos + f.ptj_dealers }));

    // Fila PROMEDIO del equipo (como la fila 25 del Excel): promedio de las MÉTRICAS,
    // y sobre ese promedio se recalculan los puntajes
    const n = filas.length || 1;
    const avg = {
      otorgados: filas.reduce((a, f) => a + f.otorgados, 0) / n,
      monto_aprobado: filas.reduce((a, f) => a + f.monto_aprobado, 0) / n,
      dealers_nuevos: filas.reduce((a, f) => a + f.dealers_nuevos, 0) / n,
    };
    avg.ptj_creditos = ptjTramo(avg.otorgados, cfg.creditos_min, cfg.creditos_esperado, cfg.pond_creditos);
    avg.ptj_montos = ptjTramo(avg.monto_aprobado, minM, espM, cfg.pond_montos);
    avg.ptj_dealers = ptjDealers(avg.dealers_nuevos, cfg.dealers_min, cfg.dealers_esperado, cfg.pond_dealers);
    avg.score = avg.ptj_creditos + avg.ptj_montos + avg.ptj_dealers;
    const premio = premioDe(avg.score, cfg);

    // Informe paso a paso (mismo espíritu que el informe de comisiones de ejecutivos)
    const clp = v => '$' + Math.round(v).toLocaleString('es-CL');
    const n2 = v => Number(v).toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const pasos = [
      { titulo: 'Equipo evaluado', detalle: `${filas.length} Ejecutivos Comerciales activos en ${mes}. El bono del Jefe Comercial se calcula sobre el PROMEDIO del equipo, no sobre un ejecutivo individual.` },
      { titulo: `Pilar 1 — Créditos otorgados (pondera ${Math.round(cfg.pond_creditos * 100)}%)`, detalle: `Promedio del equipo: ${n2(avg.otorgados)} créditos otorgados en el mes. Regla: bajo el mínimo (${cfg.creditos_min}) el puntaje es 0; sobre lo esperado (${cfg.creditos_esperado}) se alcanza el máximo del pilar (${n2(cfg.pond_creditos * 100)} pts); entre medio es proporcional → (${n2(avg.otorgados)} ÷ ${cfg.creditos_esperado}) × ${Math.round(cfg.pond_creditos * 100)} = ${n2(avg.ptj_creditos)} pts.` },
      { titulo: `Pilar 2 — Montos aprobados (pondera ${Math.round(cfg.pond_montos * 100)}%)`, detalle: `Promedio del equipo: ${clp(avg.monto_aprobado)} aprobados en el mes. Umbrales: mínimo ${clp(minM)} (${cfg.creditos_min} ops × ${clp(cfg.monto_por_op)}), esperado ${clp(espM)} (${cfg.creditos_esperado} ops × ${clp(cfg.monto_por_op)}). Puntaje: ${n2(avg.ptj_montos)} pts.` },
      { titulo: `Pilar 3 — Nuevos dealers cursados (pondera ${Math.round(cfg.pond_dealers * 100)}%)`, detalle: `Promedio del equipo: ${n2(avg.dealers_nuevos)} dealers nuevos (fichas de incorporación de dealers ingresadas por el ejecutivo y APROBADAS durante ${mes}). Regla: bajo el mínimo (${cfg.dealers_min}) es 0; si no, (valor ÷ ${cfg.dealers_esperado}) × ${Math.round(cfg.pond_dealers * 100)} = ${n2(avg.ptj_dealers)} pts (este pilar no tiene tope).` },
      { titulo: 'Score final del equipo', detalle: `${n2(avg.ptj_creditos)} + ${n2(avg.ptj_montos)} + ${n2(avg.ptj_dealers)} = ${n2(avg.score)} puntos.` },
      { titulo: 'Curva del premio', detalle: premio.pct_adicional === 0
          ? `El score (${n2(avg.score)}, se busca el entero ${premio.score_lookup}) no supera el mínimo de ${cfg.score_min} puntos → el premio del mes es $0. La curva parte a pagar sobre ${cfg.score_min} pts.`
          : `Con score entero ${premio.score_lookup} (mínimo ${cfg.score_min}, máximo ${cfg.score_max}): % adicional = ${Math.round(cfg.pct_variable * 100)}% × (e^(${cfg.k}·x)−1)/(e^${cfg.k}−1) con x=(${premio.score_lookup}−${cfg.score_min})/(${cfg.score_max}−${cfg.score_min}) → ${n2(premio.pct_adicional * 100)}% del sueldo fijo.` },
      { titulo: 'Premio del mes', detalle: `${clp(cfg.sueldo_fijo)} (fijo) × ${n2(premio.pct_adicional * 100)}% = ${clp(premio.variable)} de premio variable. Semana corrida: ${clp(premio.variable)} × ${n2(cfg.factor_semana * 100)}% = ${clp(premio.semana_corrida)}. Total variable: ${clp(premio.total_variable)} → Renta total del mes: ${clp(premio.renta_total)}.` },
    ];

    res.json({ success: true, data: { mes, params: { ...cfg, min_montos: minM, esperado_montos: espM }, ejecutivos: filas, promedio: avg, premio, pasos }, error: null });
  } catch (e) { console.error('[bono-jefe bsc]', e); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET/PUT /api/bono-jefe/variables (restringido) ── */
const getVariables = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT clave, valor, updated_at FROM bono_jefe_config ORDER BY clave');
    res.json({ success: true, data: rows, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};
const setVariables = async (req, res) => {
  try {
    const vars = req.body && req.body.variables;
    if (!vars || typeof vars !== 'object') return res.status(400).json({ success: false, data: null, error: 'variables requeridas' });
    const PERMITIDAS = new Set(['creditos_min','creditos_esperado','pond_creditos','monto_por_op','pond_montos',
      'dealers_min','dealers_esperado','pond_dealers','score_min','score_max','pct_variable','k','sueldo_fijo','factor_semana']);
    const cambios = [];
    for (const [k, v] of Object.entries(vars)) {
      if (!PERMITIDAS.has(k)) continue;
      const num = parseFloat(v);
      if (!Number.isFinite(num) || num < 0) return res.status(400).json({ success: false, data: null, error: `Valor inválido para ${k}` });
      await pool.query('UPDATE bono_jefe_config SET valor=? WHERE clave=?', [String(num), k]);
      cambios.push(`${k}=${num}`);
    }
    auditar({ req, accion: 'EDITAR', modulo: 'bono-jefe', entidad: 'variables', entidad_id: 1, detalle: `Variables BSC Jefe Comercial: ${cambios.join(', ')}` });
    res.json({ success: true, data: { cambios }, error: null });
  } catch (e) { console.error('[bono-jefe vars]', e); res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

/* ── GET /api/bono-jefe/curva — tabla score→premio para la vista Variables ── */
const getCurva = async (req, res) => {
  try {
    const cfg = await getCfg();
    const filas = [];
    for (let s = cfg.score_min - 5; s <= cfg.score_max + 10; s++) filas.push({ score: s, ...premioDe(s, cfg) });
    res.json({ success: true, data: { cfg, filas }, error: null });
  } catch (e) { res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' }); }
};

module.exports = { getBSC, getVariables, setVariables, getCurva };
