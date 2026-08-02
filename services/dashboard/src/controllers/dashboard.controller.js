const pool = require('../../../../shared/config/database');

const CONFIG_KEY = 'dashboard_tab_permisos';

// ── Inicializar tabla config si no existe ─────────────────────────────────────
require('../../../../shared/migrate').enFila('dashboard', async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dashboard_config (
        config_key   VARCHAR(80)  NOT NULL PRIMARY KEY,
        config_value MEDIUMTEXT   NOT NULL,
        updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      )
    `);
  } catch (e) {
    console.error('[dashboard] CREATE TABLE dashboard_config:', e.message);
  }
});

// ── Labels de meses ──────────────────────────────────────────────────────────
const MESES_LABELS = {
  '2024-01':'Ene 24','2024-02':'Feb 24','2024-03':'Mar 24','2024-04':'Abr 24',
  '2024-05':'May 24','2024-06':'Jun 24','2024-07':'Jul 24','2024-08':'Ago 24',
  '2024-09':'Sep 24','2024-10':'Oct 24','2024-11':'Nov 24','2024-12':'Dic 24',
  '2025-01':'Ene 25','2025-02':'Feb 25','2025-03':'Mar 25','2025-04':'Abr 25',
  '2025-05':'May 25','2025-06':'Jun 25','2025-07':'Jul 25','2025-08':'Ago 25',
  '2025-09':'Sep 25','2025-10':'Oct 25','2025-11':'Nov 25','2025-12':'Dic 25',
  '2026-01':'Ene 26','2026-02':'Feb 26','2026-03':'Mar 26','2026-04':'Abr 26',
  '2026-05':'May 26','2026-06':'Jun 26','2026-07':'Jul 26','2026-08':'Ago 26',
  '2026-09':'Sep 26','2026-10':'Oct 26','2026-11':'Nov 26','2026-12':'Dic 26',
};

function n(v) { return parseFloat(v) || 0; }
function s(v) { return v ? String(v).trim() : ''; }

function derInstitucion(financiera, producto) {
  const f = (financiera || '').toUpperCase().trim();
  const p = (producto   || '').toUpperCase().trim();
  // UNIDAD tiene prioridad
  if (f.includes('UNIDAD') || p.startsWith('UNIDAD')) return 'UNIDAD DE CREDITO';
  // AUTOFIN por campo financiera o producto
  if (f.includes('AUTOFIN') || f.includes('AUTOFACIL') ||
      p.startsWith('AUTOFIN') || p.startsWith('AUTOFACIL')) return 'AUTOFIN';
  // Si tiene financiera válida (banco externo) pero tiene producto AutoFácil
  if (p && p !== 'NO APLICA' && p !== '') return 'AUTOFIN';
  // Default: cualquier op cargada es AUTOFIN
  if (f && f !== 'NO APLICA') return 'AUTOFIN';
  return 'AUTOFIN'; // todas las ops son del negocio AutoFácil
}

// ── Procesamiento igual al original Vercel ────────────────────────────────────
function procesarDatos(rows) {
  const mesesKeys = [...new Set(rows.map(r => r.mes))].sort();
  const last12    = mesesKeys.slice(-12);
  const last6     = mesesKeys.slice(-6);
  const last3     = mesesKeys.slice(-3);

  // Tendencia mensual
  const tendencia = mesesKeys.map(m => {
    const mrs   = rows.filter(r => r.mes === m);
    const conFin = mrs.filter(r => r.institucion === 'AUTOFIN' || r.institucion === 'UNIDAD DE CREDITO');
    const ot    = conFin.filter(r => r.estado_eval === 'OTORGADO');
    return {
      mes:            MESES_LABELS[m] || m,
      mes_key:        m,
      total_ops:      mrs.length,
      otorgados:      ot.length,
      rechazados:     mrs.filter(r => r.estado_eval === 'RECHAZADO').length,
      saldo_ot:       ot.reduce((a, r) => a + n(r.saldo_precio), 0),
      com_dealer:     ot.reduce((a, r) => a + n(r.com_dealer), 0),
      rentab_afa:     ot.reduce((a, r) => a + n(r.rentab_afa), 0),
      com_seguros:    ot.reduce((a, r) => a + n(r.com_seguros), 0),
      tasa_conversion: mrs.length ? +(ot.length / mrs.length * 100).toFixed(1) : 0,
    };
  });

  // Desempeño por ejecutivo
  const ejMap = {};
  rows.forEach(r => {
    if (!r.ejecutivo) return;
    if (!ejMap[r.ejecutivo]) ejMap[r.ejecutivo] = {};
    if (!ejMap[r.ejecutivo][r.mes]) ejMap[r.ejecutivo][r.mes] = { ing:0,apro:0,ot:0,rec:0,monto_ot:0 };
    const d = ejMap[r.ejecutivo][r.mes];
    d.ing++;
    if (!['RECHAZADO','ANULADO'].includes(r.estado_eval)) d.apro++;
    if (r.estado_eval === 'OTORGADO') { d.ot++; d.monto_ot += n(r.saldo_precio); }
    if (r.estado_eval === 'RECHAZADO') d.rec++;
  });

  const ejecutivos = Object.keys(ejMap).sort((a, b) =>
    mesesKeys.reduce((s, m) => s + (ejMap[b][m]?.ot || 0), 0) -
    mesesKeys.reduce((s, m) => s + (ejMap[a][m]?.ot || 0), 0)
  );

  const ejPerf = ejecutivos.map(ej => {
    const row = { nombre: ej, meses: {} };
    mesesKeys.forEach(m => {
      const d = ejMap[ej][m] || {};
      row.meses[m] = {
        ing: d.ing||0, apro: d.apro||0, ot: d.ot||0, rec: d.rec||0,
        tc:  d.apro ? +((d.ot||0) / d.apro * 100).toFixed(1) : 0,
        ta:  d.ing  ? +((d.apro||0) / d.ing  * 100).toFixed(1) : 0,
        prom: d.ot  ? +((d.monto_ot||0) / d.ot / 1e6).toFixed(2) : 0,
      };
    });
    [['p12', last12], ['p6', last6], ['p3', last3]].forEach(([tag, win]) => {
      const ti = win.reduce((s, m) => s + (ejMap[ej][m]?.ing  || 0), 0);
      const ta = win.reduce((s, m) => s + (ejMap[ej][m]?.apro || 0), 0);
      const to = win.reduce((s, m) => s + (ejMap[ej][m]?.ot   || 0), 0);
      const tr = win.reduce((s, m) => s + (ejMap[ej][m]?.rec  || 0), 0);
      const tm = win.reduce((s, m) => s + (ejMap[ej][m]?.monto_ot || 0), 0);
      row[tag] = {
        ing:  +(ti / win.length).toFixed(1),
        apro: +(ta / win.length).toFixed(1),
        ot:   +(to / win.length).toFixed(1),
        rec:  +(tr / win.length).toFixed(1),
        tc:   ta ? +(to / ta * 100).toFixed(1) : 0,
        ta:   ti ? +(ta / ti * 100).toFixed(1) : 0,
        prom: to ? +(tm / to / 1e6).toFixed(2) : 0,
      };
    });
    return row;
  });

  return { tendencia, ej_perf: { meses: mesesKeys, meses_labels: MESES_LABELS, ejecutivos: ejPerf } };
}

// ── Presupuesto (antes hardcodeado en app.js desde PRESUPUESTO.xlsx) ──────────
const PPTO_KEY = 'presupuesto';
const PPTO_DEFAULT = [
  { mes:'2026-01', ops:91,  monto:618.8 },
  { mes:'2026-02', ops:91,  monto:618.8 },
  { mes:'2026-03', ops:109, monto:741.2 },
  { mes:'2026-04', ops:133, monto:904.4 },
  { mes:'2026-05', ops:161, monto:1094.8 },
  { mes:'2026-06', ops:169, monto:1149.2 },
  { mes:'2026-07', ops:177, monto:1203.6 },
  { mes:'2026-08', ops:181, monto:1230.8 },
  { mes:'2026-09', ops:181, monto:1230.8 },
  { mes:'2026-10', ops:181, monto:1230.8 },
  { mes:'2026-11', ops:181, monto:1230.8 },
  { mes:'2026-12', ops:181, monto:1230.8 },
];

exports.getPresupuesto = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT config_value FROM dashboard_config WHERE config_key = ?', [PPTO_KEY]);
    if (rows.length) {
      let data; try { data = JSON.parse(rows[0].config_value); } catch { data = PPTO_DEFAULT; }
      return res.json({ success: true, data, error: null });
    }
    // Primera vez: sembrar el default en BD para que sea editable sin tocar código
    await pool.query(
      'INSERT IGNORE INTO dashboard_config (config_key, config_value) VALUES (?, ?)',
      [PPTO_KEY, JSON.stringify(PPTO_DEFAULT)]);
    return res.json({ success: true, data: PPTO_DEFAULT, error: null });
  } catch (err) {
    console.error('[dashboard] getPresupuesto:', err);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

exports.savePresupuesto = async (req, res) => {
  try {
    const { presupuesto } = req.body;
    if (!Array.isArray(presupuesto))
      return res.status(400).json({ success: false, data: null, error: 'presupuesto debe ser un arreglo' });
    await pool.query(`
      INSERT INTO dashboard_config (config_key, config_value)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = NOW()
    `, [PPTO_KEY, JSON.stringify(presupuesto)]);
    return res.json({ success: true, data: { filas: presupuesto.length }, error: null });
  } catch (err) {
    console.error('[dashboard] savePresupuesto:', err);
    return res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

// ── Permisos de pestañas ──────────────────────────────────────────────────────
exports.getPermisos = async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT config_value FROM dashboard_config WHERE config_key = ?', [CONFIG_KEY]
    );
    const permisos = rows.length ? JSON.parse(rows[0].config_value) : {};
    return res.json({ success: true, permisos });
  } catch (err) {
    console.error('[dashboard] getPermisos:', err);
    return (console.error('[error]', err), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

exports.savePermisos = async (req, res) => {
  try {
    const { permisos } = req.body;
    if (!permisos || typeof permisos !== 'object') {
      return res.status(400).json({ success: false, error: 'Permisos inválidos' });
    }
    const json = JSON.stringify(permisos);
    await pool.query(`
      INSERT INTO dashboard_config (config_key, config_value)
      VALUES (?, ?)
      ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = NOW()
    `, [CONFIG_KEY, json]);
    return res.json({ success: true });
  } catch (err) {
    console.error('[dashboard] savePermisos:', err);
    return (console.error('[error]', err), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

// ── Controller ────────────────────────────────────────────────────────────────
exports.getDatos = async (req, res) => {
  try {
    // Umbral del tramo UF (editable en Tasas → Modificar Umbrales)
    const [[umbralRow]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='umbral_uf_tramo'");
    const umbralUF = umbralRow ? parseFloat(umbralRow.valor) || 200 : 200;
    // Cargar tabla UF completa (pequeña, ~400 filas) para lookup en JS
    const [ufRows] = await pool.query('SELECT DATE_FORMAT(fecha,"%Y-%m-%d") AS fecha, valor FROM uf ORDER BY fecha ASC');
    // Índice fecha→valor para búsqueda rápida (UF <= fecha dada)
    const ufList = ufRows.map(r => ({ fecha: r.fecha, valor: parseFloat(r.valor)||38000 }));
    const getUF = (fechaStr) => {
      if (!fechaStr) return ufList[ufList.length - 1]?.valor || 38000;
      let val = ufList[0]?.valor || 38000;
      for (const u of ufList) { if (u.fecha <= fechaStr) val = u.valor; else break; }
      return val;
    };

    // Deduplicar por operación, quedándose con el registro de mayor id.
    // OJO: PARTITION BY num_op solo agrupa todos los num_op NULL en UNA partición
    // (botaría todos menos uno). Por eso se deduplica por num_op y, si falta, por
    // numero_credito; y si ambos faltan, por el id (único → nunca se descarta).
    const [rows] = await pool.query(`
      SELECT
        COALESCE(NULLIF(num_op,''), numero_credito)             AS op,
        DATE_FORMAT(mes, '%Y-%m')                              AS mes,
        COALESCE(ejecutivo, '')                                AS ejecutivo,
        COALESCE(financiera, '')                               AS financiera,
        -- FUENTE ÚNICA de nombres de dealers: tabla dealers (via id_dealer);
        -- el texto libre de creditos.automotora es solo fallback
        COALESCE(NULLIF(dl.nombre_razon,''), NULLIF(dl.nombre_indexa,''), automotora, '') AS automotora,
        COALESCE(nombre_local, '')                             AS nombre_local,
        COALESCE(estado_eval, '')                              AS estado_eval,
        COALESCE(estado_credito, '')                           AS estado_credito,
        COALESCE(producto, '')                                 AS producto,
        COALESCE(saldo_precio, 0)                             AS saldo_precio,
        COALESCE(monto_financiado, 0)                         AS monto_financiado,
        COALESCE(tascli_real, 0)                              AS tasa_cli,
        COALESCE(comdea_real, 0)                              AS com_dealer,
        COALESCE(monto_comision_fin, 0)                       AS rentab_afa,
        COALESCE(com_rdh, 0) + COALESCE(com_cesantia, 0)
          + COALESCE(com_reparaciones, 0)                     AS com_seguros,
        COALESCE(com_parque, 0)                               AS com_parque,
        COALESCE(arriendo_parque, 0)                          AS arriendo_parque,
        COALESCE(ingreso_neto_total, 0)                       AS ingreso_neto_total,
        COALESCE(plazo, 0)                                    AS plazo,
        COALESCE(mayor_menor, '')                             AS mayor_menor,
        COALESCE(mayor_mm30, 0)                               AS mayor_mm30,
        DATE_FORMAT(fecha_estado, '%Y-%m-%d')                 AS fecha_estado,
        DATE_FORMAT(fecha_otorgado, '%Y-%m-%d')              AS fecha_otorgado,
        COALESCE(parque, '')                                  AS parque,
        COALESCE(estado_sp, '')                               AS estado_sp,
        COALESCE(status_comaf, '')                            AS status_comaf,
        COALESCE(resultado_negocio, '')                       AS resultado_negocio,
        COALESCE(cl.rut, '')                                  AS rut_cliente,
        COALESCE(cl.nombre_completo, '')                      AS nombre_cliente,
        COALESCE(ob.rut_dealer, '')                           AS rut_dealer,
        COALESCE(ob.id_financiera, '')                        AS id_financiera
      FROM (
        SELECT *, ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(NULLIF(num_op,''), NULLIF(numero_credito,''), CONCAT('__id', id))
                 ORDER BY id DESC) AS _rn
        FROM creditos WHERE mes IS NOT NULL
          -- Dashboard de ventas: SOLO cartera desde enero 2025 (definición Pato).
          -- Deja fuera la cartera migrada (AFA 2016-2022 y XLSX 2024) y meses viejos.
          AND mes >= '2025-01-01'
          AND COALESCE(origen,'') <> 'CARTERA_AFA'
      ) ob
      LEFT JOIN dealers dl ON dl.id_dealer = ob.id_dealer
      LEFT JOIN clientes cl ON cl.id_cliente = ob.id_cliente
      WHERE ob._rn = 1
      ORDER BY ob.mes ASC, ob.num_op ASC
    `);

    // Agregar institucion derivada + castear decimales a número
    // (MySQL2/TiDB devuelve columnas DECIMAL como strings)
    const raw = rows.map(r => {
      const saldo = +(r.saldo_precio) || 0;
      // UF de la fecha de otorgamiento (o fecha_estado si no tiene otorgamiento)
      const fechaRef = r.fecha_otorgado || r.fecha_estado || null;
      const ufOt = getUF(fechaRef);
      return {
        ...r,
        institucion:        derInstitucion(r.financiera, r.producto),
        saldo_precio:       saldo,
        monto_financiado:   +(r.monto_financiado)   || 0,
        tasa_cli:           +(r.tasa_cli)            || 0,
        com_dealer:         +(r.com_dealer)          || 0,
        rentab_afa:         +(r.rentab_afa)          || 0,
        com_seguros:        +(r.com_seguros)         || 0,
        com_parque:         +(r.com_parque)          || 0,
        arriendo_parque:    +(r.arriendo_parque)     || 0,
        ingreso_neto_total: +(r.ingreso_neto_total)  || 0,
        plazo:              +(r.plazo)               || 0,
        mayor_mm30:         +(r.mayor_mm30)          || 0,
        // MAYOR/MENOR recalculado con la UF de la fecha de otorgamiento
        mayor_menor:        saldo > umbralUF * ufOt ? 'MAYOR 200UF' : 'MENOR 200UF',
      };
    });

    const { tendencia, ej_perf } = procesarDatos(raw);

    return res.json({
      success:         true,
      generado_en:     new Date().toISOString(),
      total_registros: raw.length,
      raw,
      tendencia,
      ej_perf,
    });
  } catch (err) {
    console.error('[dashboard] getDatos error:', err);
    return (console.error('[error]', err), res.status(500).json({success:false,data:null,error:'Error interno del servidor'}));
  }
};

/* ── GET /api/dashboard/seguros-historico ─────────────────────────────────────
   Histórico mensual de cumplimiento de seguros AUTOFIN (modelo 2026-07):
   penetración por seguro sobre CURSADAS, % de comisión del mes (tramo del
   seguro más débil, tabla comisiones_seguro_penetracion) e ingreso por seguro
   según la tabla nueva (prima × % del mes). */
exports.getSegurosHistorico = async (req, res) => {
  try {
    const { getPenComision } = require('../../../creditos/src/utils/penetracion');
    const [tramos] = await pool.query(
      'SELECT tipo, pen_min, pct_comision FROM comisiones_seguro_penetracion WHERE estado="activo" ORDER BY tipo, pen_min');
    // % informados por AutoFin (mandan sobre el calculado: su cierre puede diferir de nuestra BD)
    let overrides = {};
    try {
      const [ov] = await pool.query('SELECT mes, pct FROM comisiones_seguro_pct_mes');
      ov.forEach(o => { overrides[String(o.mes).slice(0, 7)] = parseFloat(o.pct) / 100; });
    } catch (e) { /* tabla puede no existir */ }
    const [rows] = await pool.query(`
      SELECT DATE_FORMAT(mes,'%Y-%m') m,
             SUM(NOT (seguro_rdh IS NULL AND seguro_cesantia IS NULL AND seguro_rep_menor IS NULL)) n,
             SUM(seguro_rdh IS NULL AND seguro_cesantia IS NULL AND seguro_rep_menor IS NULL) sin_info,
             SUM(seguro_rdh>0) nrdh, SUM(seguro_cesantia>0) nces, SUM(seguro_rep_menor>0) nrep,
             SUM(COALESCE(seguro_rdh,0)) prdh, SUM(COALESCE(seguro_cesantia,0)) pces, SUM(COALESCE(seguro_rep_menor,0)) prep
      FROM creditos
      WHERE UPPER(COALESCE(financiera,'')) LIKE '%AUTOFIN%' AND mes IS NOT NULL
        AND COALESCE(NULLIF(estado,''), estado_credito) = 'OTORGADO'
        -- universo NCNU: sin CORFO (mismo criterio que el motor penetracion.js)
        AND UPPER(COALESCE(producto,'')) NOT LIKE '%CORFO%'
      GROUP BY 1 ORDER BY 1 DESC LIMIT 24`);
    const data = rows.map(r => {
      const pen = {
        rdh: r.n ? 100 * r.nrdh / r.n : 0,
        ces: r.n ? 100 * r.nces / r.n : 0,
        rep: r.n ? 100 * r.nrep / r.n : 0,
      };
      const informado = overrides[r.m] != null;
      const pct = informado ? overrides[r.m] : Math.min(
        getPenComision('rdh', pen.rdh, tramos),
        getPenComision('cesantia', pen.ces, tramos),
        getPenComision('reparacion', pen.rep, tramos));
      return {
        mes: r.m, ops: +r.n, sin_info: +r.sin_info,
        pen_rdh: Math.round(pen.rdh * 10) / 10, pen_cesantia: Math.round(pen.ces * 10) / 10, pen_reparaciones: Math.round(pen.rep * 10) / 10,
        pct_comision: Math.round(pct * 10000) / 100,
        pct_fuente: informado ? 'INFORMADO' : 'CALCULADO',
        prima_rdh: +r.prdh, prima_cesantia: +r.pces, prima_reparaciones: +r.prep,
        ing_rdh: Math.round(r.prdh * pct), ing_cesantia: Math.round(r.pces * pct), ing_reparaciones: Math.round(r.prep * pct),
      };
    });
    res.json({ success: true, data, error: null });
  } catch (e) {
    console.error('[dashboard seguros-historico]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al calcular el histórico de seguros' });
  }
};

/* ═════════ CLIMA Y FERIADOS vs COLOCACIÓN (Proyección Pro) ═════════
   Correlaciona los otorgamientos diarios (fecha_otorgado) con lluvia y
   temperatura de Santiago (Open-Meteo, histórico gratuito, cacheado en
   clima_diario) y con los feriados chilenos (shared/feriados.js).      */
require('../../../../shared/migrate').enFila('clima-diario', async () => {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS clima_diario (
      fecha DATE PRIMARY KEY, pp DECIMAL(6,1) NULL, tmax DECIMAL(5,1) NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  } catch (e) { console.error('[clima migration]', e.message); }
});

async function climaRango(desde, hasta) {
  const [ya] = await pool.query('SELECT fecha, pp, tmax FROM clima_diario WHERE fecha BETWEEN ? AND ?', [desde, hasta]);
  const map = new Map(ya.map(r => [String(r.fecha).slice(0, 10) === 'Invalid D' ? r.fecha : new Date(r.fecha).toISOString().slice(0, 10), { pp: Number(r.pp), tmax: Number(r.tmax) }]));
  // fechas faltantes → Open-Meteo (archive llega hasta ~anteayer)
  const faltan = [];
  for (let d = new Date(desde + 'T12:00:00'); d <= new Date(hasta + 'T12:00:00'); d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (!map.has(iso)) faltan.push(iso);
  }
  if (faltan.length) {
    try {
      const url = `https://archive-api.open-meteo.com/v1/archive?latitude=-33.45&longitude=-70.66&start_date=${faltan[0]}&end_date=${faltan[faltan.length - 1]}&daily=precipitation_sum,temperature_2m_max&timezone=America%2FSantiago`;
      const j = await (await fetch(url)).json();
      const t = (j.daily && j.daily.time) || [];
      for (let i = 0; i < t.length; i++) {
        const pp = j.daily.precipitation_sum[i], tm = j.daily.temperature_2m_max[i];
        if (pp == null && tm == null) continue;
        map.set(t[i], { pp: Number(pp) || 0, tmax: tm == null ? null : Number(tm) });
        await pool.query('INSERT IGNORE INTO clima_diario (fecha, pp, tmax) VALUES (?,?,?)', [t[i], pp ?? null, tm ?? null]).catch(() => {});
      }
    } catch (e) { console.error('[clima open-meteo]', e.message); }
  }
  return map;
}

exports.getClimaCorrelacion = async (req, res) => {
  try {
    const meses = Math.min(24, Math.max(3, parseInt(req.query.meses) || 12));
    const hoy = new Date();
    const desde = new Date(hoy.getFullYear(), hoy.getMonth() - meses, 1).toISOString().slice(0, 10);
    const hasta = new Date(hoy.getTime() - 2 * 86400000).toISOString().slice(0, 10);   // archive llega hasta ~anteayer
    const [ops] = await pool.query(
      `SELECT DATE(fecha_otorgado) f, COUNT(*) q, SUM(COALESCE(monto_financiado,0)) m
       FROM creditos WHERE estado_eval='OTORGADO' AND fecha_otorgado BETWEEN ? AND ?
       GROUP BY 1`, [desde, hasta]);
    const qPorDia = new Map(ops.map(r => [new Date(r.f).toISOString().slice(0, 10), { q: Number(r.q), m: Number(r.m) }]));
    const clima = await climaRango(desde, hasta);
    const { esFeriado, cargarFeriados } = require('../../../../shared/feriados');
    await cargarFeriados();   // asegurar el set en frío (carga async al boot)

    // Serie de TODOS los días: en este negocio el SÁBADO es el mejor día de venta
    // (3,7 ops/día) y el domingo también cursa — no se excluyen fines de semana.
    const serie = [];
    for (let d = new Date(desde + 'T12:00:00'); d <= new Date(hasta + 'T12:00:00'); d.setDate(d.getDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      const dow = d.getDay();
      const fer = esFeriado(d);   // esFeriado espera Date (motor único shared/feriados)
      const c = clima.get(iso) || {};
      serie.push({ f: iso, dow, q: (qPorDia.get(iso) || {}).q || 0, m: (qPorDia.get(iso) || {}).m || 0,
        pp: c.pp ?? null, tmax: c.tmax ?? null, feriado: fer,
        vispera: !fer && esFeriado(new Date(d.getTime() + 86400000)),
        post: !fer && esFeriado(new Date(d.getTime() - 86400000)) });
    }
    const habiles = serie.filter(s => !s.feriado && s.dow >= 1 && s.dow <= 5);   // L-V para clima/feriados
    const media = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
    const grupos = {
      // Hallazgo del negocio: la lluvia normal NO baja la venta (3,4-4,7 ops/día vs
      // 2,9 en seco) — lo que la colapsa es el TEMPORAL ≥30mm (0,33 ops/día; el
      // 16-17 jul 2026 cayeron 31+68mm y hubo 0 ops ambos días).
      seco:     habiles.filter(s => s.pp != null && s.pp < 1),
      lluvia:   habiles.filter(s => s.pp != null && s.pp >= 1 && s.pp < 30),
      temporal: habiles.filter(s => s.pp != null && s.pp >= 30),
      vispera:  habiles.filter(s => s.vispera),
      post:     habiles.filter(s => s.post),
      normal:   habiles.filter(s => !s.vispera && !s.post),
      feriados: serie.filter(s => s.feriado),
      sabado:   serie.filter(s => !s.feriado && s.dow === 6),
      domingo:  serie.filter(s => !s.feriado && s.dow === 0),
    };
    const stats = {};
    for (const [k, v] of Object.entries(grupos)) stats[k] = { n: v.length, q_prom: +media(v.map(s => s.q)).toFixed(2), m_prom: Math.round(media(v.map(s => s.m))) };
    // correlación de Pearson Q vs lluvia y Q vs t° máx (solo hábiles con clima)
    const pearson = (xs, ys) => {
      const n = xs.length; if (n < 3) return null;
      const mx = media(xs), my = media(ys);
      let num = 0, dx = 0, dy = 0;
      for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
      return (dx && dy) ? +(num / Math.sqrt(dx * dy)).toFixed(3) : null;
    };
    const conClima = habiles.filter(s => s.pp != null);
    const conTemp = habiles.filter(s => s.tmax != null);

    // ── PROYECCIÓN RESTO DEL MES con pronóstico (Open-Meteo forecast, mismos modelos
    //    ECMWF/GFS de Windy) + feriados: a cada día hábil restante se le asigna el
    //    rendimiento histórico de su condición (feriado/víspera/post/lluvia/seco).
    let proyeccion = null;
    try {
      const fc = await (await fetch('https://api.open-meteo.com/v1/forecast?latitude=-33.45&longitude=-70.66&daily=precipitation_sum,temperature_2m_max&timezone=America%2FSantiago&forecast_days=16')).json();
      const ppFc = new Map((fc.daily?.time || []).map((t, i) => [t, Number(fc.daily.precipitation_sum[i]) || 0]));
      const finMesD = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0);
      const dias = []; let qRest = 0, mRest = 0;
      for (let d = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate(), 12); d <= finMesD; d.setDate(d.getDate() + 1)) {
        const dow = d.getDay();   // sáb/dom ENTRAN: sábado es el mejor día de venta
        const iso = d.toISOString().slice(0, 10);
        const esHoy = d.getDate() === hoy.getDate() && d.getMonth() === hoy.getMonth();
        const fer = esFeriado(d);
        const visp = !fer && esFeriado(new Date(d.getTime() + 86400000));
        const post = !fer && esFeriado(new Date(d.getTime() - 86400000));
        const pp = ppFc.has(iso) ? ppFc.get(iso) : null;
        const grupo = fer ? 'feriados' : dow === 6 ? 'sabado' : dow === 0 ? 'domingo'
          : visp ? 'vispera' : post ? 'post' : (pp != null ? (pp >= 30 ? 'temporal' : pp >= 1 ? 'lluvia' : 'seco') : 'normal');
        let qEst = (stats[grupo] && stats[grupo].n ? stats[grupo].q_prom : stats.normal.q_prom);
        let mEst = (stats[grupo] && stats[grupo].n ? stats[grupo].m_prom : stats.normal.m_prom);
        // HOY cuenta por lo que le QUEDA: fracción del día hábil aún por transcurrir (9-18h)
        if (esHoy) {
          const hCh = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', hour: 'numeric', hour12: false }).format(new Date()));
          const frac = Math.max(0, Math.min(1, (18 - hCh) / 9));
          qEst = qEst * frac; mEst = mEst * frac;
          if (qEst < 0.05) continue;
        }
        qRest += qEst; mRest += mEst;
        dias.push({ f: iso, grupo: (esHoy ? 'hoy_' : '') + grupo, pp, q_est: +qEst.toFixed(2) });
      }
      proyeccion = { dias, q_restante: Math.round(qRest), q_restante_exacto: +qRest.toFixed(2), m_restante: Math.round(mRest) };
    } catch (e) { console.error('[clima forecast]', e.message); }

    res.json({ success: true, data: {
      proyeccion,
      desde, hasta, dias: serie.length, stats,
      corr_lluvia: pearson(conClima.map(s => s.pp), conClima.map(s => s.q)),
      corr_temp: pearson(conTemp.map(s => s.tmax), conTemp.map(s => s.q)),
      serie: serie.slice(-90),   // últimos ~90 hábiles para el gráfico
    }, error: null });
  } catch (e) {
    console.error('[dashboard clima]', e.message);
    res.status(500).json({ success: false, data: null, error: 'Error al calcular la correlación clima/feriados' });
  }
};

/* ─── Parámetros del Dashboard (mantenedor, v170) ──────────────────────────────
   Umbrales de negocio que vivían HARDCODEADOS en el JS del dashboard (meta de
   prospección, rojos de alerta, semáforo de rentabilidad): el Administrador no
   podía verlos ni cambiarlos. Ahora viven en dashboard_config (clave 'parametros')
   y se editan en /mantenedores/dashboard-parametros/. Filosofía paramétrica. */
const PARAMS_KEY = 'parametros';
const PARAMS_DEFAULT = {
  meta_ing_dia:        { valor: 2,        label: 'Meta de prospección: ingresos por ejecutivo por día hábil' },
  alerta_fin_ejecutivo:{ valor: 40000000, label: 'Rojo en Total Financiado del ejecutivo si queda bajo este monto ($/mes)' },
  alerta_fin_mes:      { valor: 30000000, label: 'Rojo en Total Financiado del mes anterior si queda bajo este monto ($)' },
  rentab_verde:        { valor: 25,       label: 'Semáforo de rentabilidad: verde desde este % de margen' },
  rentab_amarillo:     { valor: 15,       label: 'Semáforo de rentabilidad: amarillo desde este %' },
  rentab_naranjo:      { valor: 8,        label: 'Semáforo de rentabilidad: naranjo desde este % (bajo eso, rojo)' },
};

exports.getParametros = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT config_value FROM dashboard_config WHERE config_key = ?', [PARAMS_KEY]);
    let data = PARAMS_DEFAULT;
    if (rows.length) {
      try {
        const saved = JSON.parse(rows[0].config_value);
        // merge: claves nuevas del código aparecen solas; valores guardados mandan
        data = Object.fromEntries(Object.entries(PARAMS_DEFAULT).map(([k, d]) =>
          [k, { ...d, valor: (saved[k] && Number.isFinite(Number(saved[k].valor ?? saved[k]))) ? Number(saved[k].valor ?? saved[k]) : d.valor }]));
      } catch { /* JSON corrupto: defaults */ }
    }
    res.json({ success: true, data, error: null });
  } catch (err) {
    console.error('[dashboard] getParametros:', err);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

exports.saveParametros = async (req, res) => {
  try {
    const b = req.body || {};
    const out = {};
    for (const [k, d] of Object.entries(PARAMS_DEFAULT)) {
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < 0)
        return res.status(400).json({ success: false, data: null, error: `Valor inválido para ${d.label}` });
      out[k] = { valor: n };
    }
    if (!(out.rentab_verde.valor >= out.rentab_amarillo.valor && out.rentab_amarillo.valor >= out.rentab_naranjo.valor))
      return res.status(400).json({ success: false, data: null, error: 'El semáforo debe cumplir verde ≥ amarillo ≥ naranjo' });
    await pool.query(`INSERT INTO dashboard_config (config_key, config_value) VALUES (?, ?)
      ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_at = NOW()`,
      [PARAMS_KEY, JSON.stringify(out)]);
    try { require('../../../../shared/audit').auditar({ req, accion: 'EDITAR', modulo: 'dashboard', entidad: 'parametros', entidad_id: PARAMS_KEY,
      detalle: 'Actualizó los Parámetros del Dashboard: ' + Object.entries(out).map(([k, v]) => `${k}=${v.valor}`).join(', ') }); } catch (_) {}
    res.json({ success: true, data: out, error: null });
  } catch (err) {
    console.error('[dashboard] saveParametros:', err);
    res.status(500).json({ success: false, data: null, error: 'Error interno del servidor' });
  }
};

/* Card en Mantenedores + permiso (anti-hardcode) */
require('../../../../shared/migrate').enFila('dashboard-parametros', async () => {
  try {
    const [[mod]] = await pool.query("SELECT id_modulo FROM modulos WHERE nombre='Mantenedores' AND estado='activo' LIMIT 1");
    if (!mod) return;
    const f = { codigo: 'mant_dashboard_param', nombre: 'Parámetros del Dashboard',
                href: '/mantenedores/dashboard-parametros/', icono: 'bi-sliders' };
    const [[ex]] = await pool.query('SELECT id_funcionalidad FROM funcionalidades WHERE codigo=? LIMIT 1', [f.codigo]);
    let idF = ex && ex.id_funcionalidad;
    if (!idF) {
      const [r] = await pool.query('INSERT INTO funcionalidades (id_modulo, nombre, codigo, href, icono) VALUES (?,?,?,?,?)',
        [mod.id_modulo, f.nombre, f.codigo, f.href, f.icono]);
      idF = r.insertId;
    }
    await pool.query('INSERT IGNORE INTO permisos_perfil (id_perfil, id_funcionalidad, habilitado) VALUES (1,?,1)', [idF]);
    console.log('[dashboard-parametros] mantenedor listo');
  } catch (e) { console.error('[dashboard-parametros migration]', e.message); }
});
