'use strict';
/**
 * recalcular-mes.js
 * Recalcula TODOS los campos financieros de las operaciones de uno o varios meses:
 *   - monto_comision_fin  (Ing x Colocaciones)
 *   - comdea_real         (Comisión Dealer)
 *   - com_parque          (Comisión Parque)
 *   - arriendo_parque     (Arriendo Parque)
 *   - com_rdh / com_cesantia / com_reparaciones  (Ing x Seguros)
 *   - ingreso_neto_total
 *
 * Para UNIDAD/UAC aplica la lógica de tiers por mes y recalcula TODAS las ops
 * del mes si el tier cambia al agregar nuevas operaciones.
 *
 * Uso:
 *   const { recalcularMeses } = require('../utils/recalcular-mes');
 *   await recalcularMeses(['2026-06']);   // array de strings YYYY-MM
 */

const pool = require('../../../../shared/config/database');
const { cargarPenTramos, calcularPenetracionMes, comisionesSeguro } = require('./penetracion');
const { comisionDealer } = require('../../../../api-gateway/public/js/comision-dealer');
const core = require('../../../../api-gateway/public/js/rentabilidad-core');
const { getUF } = require('../../../../shared/uf');

// Campos calculados que el usuario puede dejar "forzados" (negociación puntual).
// El recálculo los respeta: conserva el valor guardado y solo recalcula los demás.
function forzadosSet(raw) {
  if (!raw) return new Set();
  try { const a = Array.isArray(raw) ? raw : JSON.parse(raw); return new Set(Array.isArray(a) ? a : []); }
  catch (_) { return new Set(); }
}

/* ── Parámetros configurables ───────────────────────────────────────── */
async function cargarParams() {
  const [rows] = await pool.query('SELECT clave, valor FROM parametros_credito');
  const p = {};
  rows.forEach(r => { p[r.clave] = parseFloat(r.valor); });
  return p;
}

/* ── Tasas históricas completas ─────────────────────────────────────── */
async function cargarTasas() {
  const [rows] = await pool.query(`
    SELECT fecha_desde, fecha_hasta,
           tasa_mensual_menor, tasa_mensual_mayor,
           spread_menor, spread_mayor
    FROM tasas ORDER BY fecha_desde
  `);
  return rows;
}

/* ── Normalizar fecha a string YYYY-MM-DD ───────────────────────────── */
function toDateStr(fecha) {
  if (!fecha) return null;
  return (fecha instanceof Date ? fecha.toISOString() : fecha.toString()).slice(0, 10);
}

/* ── Buscar tasa vigente para una fecha ─────────────────────────────── */
function getTasaByFecha(fecha, tasas) {
  if (!fecha || !tasas.length) return null;
  const f = toDateStr(fecha);
  const t = tasas.find(r =>
    toDateStr(r.fecha_desde) <= f &&
    toDateStr(r.fecha_hasta) >= f
  );
  // Si no hay registro exacto, usar el más reciente anterior
  if (!t) {
    const pasados = tasas.filter(r => toDateStr(r.fecha_hasta) < f);
    return pasados.length ? pasados[pasados.length - 1] : tasas[0];
  }
  return t;
}

/* getUF (UF vigente a una fecha) vive en ../../../../shared/uf.js (motor único). */

/* La comisión dealer/parque (pizarra + tabla del dealer) vive en ./comision-dealer.js (motor único). */

/* getPenComision, cargarPenTramos y la penetración mensual viven en ./penetracion.js (motor único). */

/* ── Comisión parque desde tabla parques_comisiones ─────────────────── */
async function cargarParques() {
  const [rows] = await pool.query(
    'SELECT nombre, arriendo, comision_pct FROM parques_comisiones WHERE activo = 1'
  );
  const map = {};
  rows.forEach(r => { map[r.nombre.toUpperCase().trim()] = r; });
  return map;
}

/* ── Tabla de comisión por dealer (su pactada; manda sobre la pizarra) ─── */
const normRutD = r => String(r || '').replace(/[.\-\s]/g, '').toUpperCase();
async function cargarDealers() {
  const map = {};
  try {
    let rows;
    try {
      // Dealers AMBOS traen una 2ª tabla PARQUE (com_parque_*). Lectura defensiva por si aún no existen.
      [rows] = await pool.query('SELECT rut, com_6_12, com_13_24, com_25_36, com_37, com_parque_6_12, com_parque_13_24, com_parque_25_36, com_parque_37 FROM dealers WHERE rut IS NOT NULL');
    } catch (e) {
      [rows] = await pool.query('SELECT rut, com_6_12, com_13_24, com_25_36, com_37 FROM dealers WHERE rut IS NOT NULL');
    }
    rows.forEach(d => { map[normRutD(d.rut)] = d; });
  } catch (e) { /* sin tabla/columnas → todo cae a la pizarra */ }
  return map;
}
// dealerTablePct vive en ./comision-dealer.js (motor único).

/* ── Tier UNIDAD — motor único uac-tier.js (modelo 1 o 2 según uac_modelo) ── */
const { pctUACMes, aplicarCortePlazoUAC } = require('./uac-tier');
const getTierUAC = (cnt, p) => pctUACMes(cnt, p);


/* ═══════════════════════════════════════════════════════════════════════
   recalcularMeses(meses, opciones)
   meses   : array de strings 'YYYY-MM'
   opciones: { soloFinancieras: ['AUTOFIN','UNIDAD DE CREDITO'] }
   ═══════════════════════════════════════════════════════════════════════ */
/* ── Cálculo por operación (Ing x Colocaciones, Comisión Dealer y Parque) ───
   Misma fórmula que usa el recálculo, aislada para reusarla en la detección
   de campos forzados. p=params, parqMap=parques, todasTasas. */
async function calcularValoresOp(op, p, parqMap, todasTasas, dealerMap, pctUAC) {
  const parqKey  = (op.parque || '').toUpperCase().trim();
  const esParque = parqKey.includes('PARQUE');
  const fin      = (op.financiera || '').toUpperCase();
  const esUAC    = fin.includes('UNIDAD') || fin.includes('UAC');
  const saldo    = parseFloat(op.saldo_precio)       || 0;
  const montoFin = parseFloat(op.monto_financiado)   || 0;
  const montoCap = parseFloat(op.monto_capitalizado) || montoFin;
  const plazo    = parseInt(op.plazo)                || 0;

  let monto_comision_fin = 0;
  if (esUAC) {
    // UAC: % del saldo precio según el tier DINÁMICO del mes (proyecta el cierre).
    // Modelo 2: la op con plazo >= corte no recibe el tier alto (tope uac2_pct_largo).
    // El snapshot de la decisión se congela aparte en la carta (cartas_aprobacion.tier_uac_*).
    monto_comision_fin = core.ingresoColocacionUAC({ saldo, pctUAC: aplicarCortePlazoUAC(pctUAC, plazo, p, op.mes || op.fecha_otorgado) });
  } else if (plazo > 0 && montoCap > 0) {
    const tasa = getTasaByFecha(op.fecha_otorgado, todasTasas);
    if (tasa) {
      const uf    = await getUF(op.fecha_otorgado);
      const mayor = core.esMayor200({ montoCap, uf, umbralUf: p.umbral_uf_tramo });
      const mantTasa   = mayor ? parseFloat(tasa.tasa_mensual_mayor) : parseFloat(tasa.tasa_mensual_menor); // %
      const mantSpread = mayor ? parseFloat(tasa.spread_mayor)       : parseFloat(tasa.spread_menor);        // %
      const costoFondo = (mantTasa - mantSpread) / 100;        // costo de fondo del mantenedor a la fecha
      // Tasa cliente (cuota): la real de la op (tascli_real, % mensual normalizado) MANDA;
      // por defecto la del mantenedor a la fecha de otorgamiento.
      // Regla de negocio: tasa cliente JAMÁS bajo el costo de fondo (dato inválido
      // → cae al mantenedor). Incluye normalización fracción→% (motor único).
      const tasaCli = core.tasaClienteValida(op.tascli_real, mantTasa, costoFondo) / 100;
      monto_comision_fin = core.ingresoColocacionAutoFin({ montoCap, plazo, tasaCli, costoFondo });
    }
  }

  // Comisión dealer y parque — motor único comision-dealer.js (tabla del dealer manda).
  const { comdea_real, com_parque, arriendo } = comisionDealer(
    { saldo, plazo, esParque },
    { dealerTabla: (dealerMap || {})[normRutD(op.rut_dealer)], parqData: parqMap[parqKey], pizarra: p }
  );
  return { monto_comision_fin, comdea_real, com_parque, arriendo };
}

/* ── Detectar y marcar campos forzados ──────────────────────────────────────
   Compara el valor GUARDADO de los campos calculados con el que daría la
   fórmula; si difieren (más que la tolerancia), marca el campo como forzado
   (negociación puntual). Si coinciden, lo desmarca. Solo evalúa `campos` (los
   recién ingresados/editados). Úsese al guardar en edición, digitación o carta. */
async function marcarForzadosCalculo(opIds, opts = {}) {
  const ids = (Array.isArray(opIds) ? opIds : [opIds]).map(Number).filter(Boolean);
  if (!ids.length) return;
  const CAMPOS = ['monto_comision_fin', 'comdea_real', 'com_parque'];
  const campos = (opts.campos || CAMPOS).filter(c => CAMPOS.includes(c));
  if (!campos.length) return;
  const tol = opts.tol != null ? opts.tol : 1; // $ de tolerancia por redondeo
  const [p, parqMap, todasTasas, dealerMap] = await Promise.all([cargarParams(), cargarParques(), cargarTasas(), cargarDealers()]);
  const [ops] = await pool.query(
    `SELECT id, financiera, parque, rut_dealer, saldo_precio, monto_financiado, monto_capitalizado, plazo, fecha_otorgado, tascli_real,
            monto_comision_fin, comdea_real, com_parque, campos_forzados
     FROM creditos WHERE id IN (?)`, [ids]);
  for (const op of ops) {
    const fin   = (op.financiera || '').toUpperCase();
    const esUAC = fin.includes('UNIDAD') || fin.includes('UAC');
    // pctUAC se omite a propósito: el único campo que lo usaría (monto_comision_fin
    // de UAC) se salta abajo, así que su valor aquí nunca se compara.
    const calc  = await calcularValoresOp(op, p, parqMap, todasTasas, dealerMap);
    const forz  = forzadosSet(op.campos_forzados);
    for (const campo of campos) {
      // UAC: monto_comision_fin es dinámico (tier del mes), nunca se marca forzado.
      if (campo === 'monto_comision_fin' && esUAC) { forz.delete(campo); continue; }
      const dif = Math.abs((parseFloat(op[campo]) || 0) - (parseFloat(calc[campo]) || 0)) > tol;
      if (dif) forz.add(campo); else forz.delete(campo);
    }
    await pool.query('UPDATE creditos SET campos_forzados = ? WHERE id = ?',
      [forz.size ? JSON.stringify([...forz]) : null, op.id]);
  }
}

async function recalcularMeses(meses, opciones = {}) {
  if (!meses || !meses.length) return { actualizados: 0, log: [] };

  // Filtro opcional por financiera (brokerage). Sin él, recalcula TODAS las ops del mes
  // (incluida la cartera propia AUTOFACIL/INDEXA). Con él, solo las financieras dadas.
  const soloFin = (Array.isArray(opciones.soloFinancieras) && opciones.soloFinancieras.length)
    ? opciones.soloFinancieras.map(f => String(f).toUpperCase()) : null;

  const [p, parqMap, todasTasas, dealerMap] = await Promise.all([
    cargarParams(),
    cargarParques(),
    cargarTasas(),
    cargarDealers(),
  ]);

  let actualizados = 0;
  const log = [];

  for (const mesStr of meses) {
    // ── Saltar meses cerrados ────────────────────────────────────────
    const [mc] = await pool.query(
      'SELECT cerrado FROM meses_cerrados WHERE mes = ? LIMIT 1', [mesStr]
    );
    if (mc.length && mc[0].cerrado) {
      log.push(`⏭ ${mesStr}: mes cerrado — omitido`);
      continue;
    }

    // ── Traer todas las ops del mes (estados activos) ────────────────
    const [ops] = await pool.query(`
      SELECT id, num_op, financiera, parque, rut_dealer, estado, estado_credito,
             saldo_precio, monto_financiado, monto_capitalizado,
             plazo, fecha_otorgado, mes,
             seguro_rdh, seguro_cesantia, seguro_rep_menor,
             com_rdh, com_cesantia, com_reparaciones,
             pen_rdh, pen_cesantia, pen_reparaciones,
             tascli_real,
             campos_forzados, monto_comision_fin, comdea_real, com_parque
      FROM creditos
      WHERE DATE_FORMAT(mes, '%Y-%m') = ?
        AND estado_eval NOT IN ('RECHAZADO','ANULADO')
        ${soloFin ? 'AND UPPER(financiera) IN (?)' : ''}
    `, soloFin ? [mesStr, soloFin] : [mesStr]);

    if (!ops.length) continue;

    // ── Conteo UAC (penetración de seguros no se recalcula aquí) ────
    // Las comisiones de seguros (com_rdh/cesantia/rep) vienen del Excel
    // y se leen desde BD sin modificarse.

    // ── Conteo UAC del mes ──────────────────────────────────────────
    const cntUAC = ops.filter(r =>
      (r.financiera || '').toUpperCase().includes('UNIDAD') ||
      (r.financiera || '').toUpperCase().includes('UAC')
    ).length;
    const pctUAC = getTierUAC(cntUAC, p);

    // Penetración de seguros del mes (AUTOFIN) — motor único penetracion.js.
    // Solo corre en meses abiertos (los cerrados ya se saltaron arriba).
    const penTramos = await cargarPenTramos();
    const penMes    = await calcularPenetracionMes(mesStr);
    log.push(`Mes ${mesStr}: ${ops.length} ops | UAC=${cntUAC} (${(pctUAC*100).toFixed(0)}%) | pen RDH ${penMes.pen_rdh.toFixed(0)}% Ces ${penMes.pen_cesantia.toFixed(0)}% Rep ${penMes.pen_reparaciones.toFixed(0)}%`);

    // ── Arriendo de parque: FIJO mensual por parque, PRORRATEADO entre las
    //    otorgadas del mes de ese parque (regla Pato: mide qué tan rentables
    //    son las ops de cada parque; 1 sola op carga todo el arriendo).
    //    Con 0 otorgadas, una op no cursada proyecta el arriendo completo.
    const esOtorgada = o => (String(o.estado || '').trim() || String(o.estado_credito || '').trim()).toUpperCase() === 'OTORGADO';
    const otorgadasPorParque = {};
    for (const o of ops) {
      const k = (o.parque || '').toUpperCase().trim();
      if (k.includes('PARQUE') && esOtorgada(o)) otorgadasPorParque[k] = (otorgadasPorParque[k] || 0) + 1;
    }

    // ── Paso 3: recalcular cada op ───────────────────────────────────
    for (const op of ops) {
      // 1-3. Valores calculados por fórmula (Ing x Colocaciones, Comisión Dealer, Parque)
      const calc = await calcularValoresOp(op, p, parqMap, todasTasas, dealerMap, pctUAC);
      const monto_comision_fin = calc.monto_comision_fin;
      const com_parque_val     = calc.com_parque;
      const comdea_real        = calc.comdea_real;
      let arriendo_val         = calc.arriendo; // arriendo FIJO del parque
      if (arriendo_val > 0) {
        const nOtorg = otorgadasPorParque[(op.parque || '').toUpperCase().trim()] || 0;
        arriendo_val = Math.round(arriendo_val / Math.max(nOtorg, 1));
      }

      // Comisiones de seguros — para AUTOFIN se recalculan con la penetración del mes
      // (motor penetracion.js); para el resto se conservan los valores guardados.
      const esAutofinOp = (op.financiera || '').toUpperCase().includes('AUTOFIN');
      let com_rdh, com_cesantia, com_reparaciones, pen_rdh, pen_cesantia, pen_reparaciones;
      if (esAutofinOp) {
        const cs = comisionesSeguro(op, penMes, penTramos);
        com_rdh = cs.com_rdh; com_cesantia = cs.com_cesantia; com_reparaciones = cs.com_reparaciones;
        pen_rdh = penMes.pen_rdh; pen_cesantia = penMes.pen_cesantia; pen_reparaciones = penMes.pen_reparaciones;
      } else {
        com_rdh = parseFloat(op.com_rdh) || 0;
        com_cesantia = parseFloat(op.com_cesantia) || 0;
        com_reparaciones = parseFloat(op.com_reparaciones) || 0;
        pen_rdh = op.pen_rdh; pen_cesantia = op.pen_cesantia; pen_reparaciones = op.pen_reparaciones;
      }

      // 4. Respetar campos forzados ───────────────────────────────────
      // Si un campo calculado fue digitado a mano (forzado), se conserva el
      // valor guardado; solo se recalculan los no forzados. ingreso_neto_total
      // se recalcula siempre con los valores EFECTIVOS (forzado o calculado).
      const forz   = forzadosSet(op.campos_forzados);
      const eff_mcf = forz.has('monto_comision_fin') ? (parseFloat(op.monto_comision_fin) || 0) : monto_comision_fin;
      const eff_cdr = forz.has('comdea_real')        ? (parseFloat(op.comdea_real)        || 0) : comdea_real;
      const eff_cpq = forz.has('com_parque')         ? (parseFloat(op.com_parque)         || 0) : com_parque_val;

      // 5. Ingreso neto total ─────────────────────────────────────────
      const com_seguros_total  = com_rdh + com_cesantia + com_reparaciones;
      const ingreso_neto_total = core.ingresoNetoTotal({
        comFin: eff_mcf, seguros: com_seguros_total,
        comDealer: eff_cdr, comParque: eff_cpq, arriendo: arriendo_val,
      });

      // 6. UPDATE (los forzados se reescriben con su propio valor guardado) ──
      await pool.query(`
        UPDATE creditos SET
          monto_comision_fin  = ?,
          comdea_real         = ?,
          com_parque          = ?,
          arriendo_parque     = ?,
          com_rdh             = ?,
          com_cesantia        = ?,
          com_reparaciones    = ?,
          pen_rdh             = ?,
          pen_cesantia        = ?,
          pen_reparaciones    = ?,
          ingreso_neto_total  = ?,
          updated_at          = NOW()
        WHERE id = ?
      `, [
        eff_mcf,
        eff_cdr,
        eff_cpq,
        arriendo_val,
        com_rdh,
        com_cesantia,
        com_reparaciones,
        pen_rdh,
        pen_cesantia,
        pen_reparaciones,
        ingreso_neto_total,
        op.id,
      ]);

      actualizados++;
    }

    // ── Normalizar ejecutivos del mes según tabla trinidad_ejecutivos ──
    await normalizarEjecutivosMes(mesStr, log);
  }

  return { actualizados, log };
}

/* ── Normaliza el campo ejecutivo usando la tabla trinidad_ejecutivos ─── */
async function normalizarEjecutivosMes(mesStr, log = []) {
  const [mapRows] = await pool.query(
    'SELECT nombre_trinidad, nombre_autofacil FROM trinidad_ejecutivos'
  );
  if (!mapRows.length) return;

  // Mapa: nombre_trinidad.toUpperCase().trim() → nombre_autofacil
  const mapa = {};
  for (const r of mapRows) {
    mapa[r.nombre_trinidad.toUpperCase().trim()] = r.nombre_autofacil;
  }

  // Traer ejecutivos distintos del mes que necesiten normalización
  const [ejRows] = await pool.query(
    `SELECT DISTINCT ejecutivo FROM creditos
     WHERE DATE_FORMAT(mes, '%Y-%m') = ? AND ejecutivo IS NOT NULL AND ejecutivo != ''`,
    [mesStr]
  );

  let normalizados = 0;
  for (const row of ejRows) {
    const raw = (row.ejecutivo || '').toUpperCase().trim();
    const norm = mapa[raw];
    if (norm && norm !== row.ejecutivo) {
      const [r] = await pool.query(
        `UPDATE creditos SET ejecutivo = ?, updated_at = NOW()
         WHERE DATE_FORMAT(mes, '%Y-%m') = ? AND ejecutivo = ?`,
        [norm, mesStr, row.ejecutivo]
      );
      if (r.affectedRows > 0) {
        normalizados += r.affectedRows;
        log.push(`👤 ${row.ejecutivo} → ${norm} (${r.affectedRows} ops)`);
      }
    }
  }
  if (normalizados > 0) log.push(`Ejecutivos normalizados: ${normalizados}`);
}

/* ── Recalcular TODOS los meses abiertos (no cerrados) ──────────────────
   Se usa cuando cambia un parámetro global que afecta el cálculo (tasas,
   % dealer/parque, umbrales, parques): el cambio impacta todas las ops. */
async function recalcularMesesAbiertos() {
  const [rows] = await pool.query(`
    SELECT DISTINCT DATE_FORMAT(c.mes, '%Y-%m') AS mes
    FROM creditos c
    WHERE c.mes IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM meses_cerrados mc
        WHERE mc.mes = DATE_FORMAT(c.mes, '%Y-%m') AND mc.cerrado = 1
      )`);
  const meses = rows.map(r => r.mes).filter(Boolean);
  if (!meses.length) return { actualizados: 0, log: [] };
  return recalcularMeses(meses);
}

/* ── Recalcular el/los mes(es) de operaciones dadas (por id de crédito) ──
   Úsese tras CUALQUIER edición/creación/digitación para que comisiones,
   ingresos y comisión dealer/parque queden al día automáticamente. Respeta
   campos forzados y meses cerrados (los salta). Pensado para fire-and-forget. */
async function recalcularPorOps(opIds) {
  const ids = (Array.isArray(opIds) ? opIds : [opIds]).map(Number).filter(Boolean);
  if (!ids.length) return { actualizados: 0, log: [] };
  const [rows] = await pool.query(
    `SELECT DISTINCT DATE_FORMAT(mes, '%Y-%m') AS m FROM creditos WHERE id IN (?) AND mes IS NOT NULL`, [ids]);
  const meses = rows.map(r => r.m).filter(Boolean);
  if (!meses.length) return { actualizados: 0, log: [] };
  return recalcularMeses(meses);
}

/* ── Extraer meses únicos de una lista de ops ───────────────────────── */
function extraerMeses(ops) {
  const set = new Set();
  for (const op of ops) {
    const mes = op.mes || op.fecha_otorgado;
    if (mes) set.add(String(mes).slice(0, 7));
  }
  return [...set];
}

module.exports = { recalcularMeses, recalcularMesesAbiertos, recalcularPorOps, marcarForzadosCalculo, extraerMeses, normalizarEjecutivosMes, cargarTasas, getTasaByFecha };
