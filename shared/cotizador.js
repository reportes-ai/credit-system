'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Cotizador — cuota "con gastos y todo" (motor del módulo de cotizaciones).
   Réplica server-side del cálculo del simulador (/cotizaciones), lado cliente:
     saldoPrecio = valor vehículo − pie
     + gastos operacionales (parametros_credito: prenda, retiro_gestion,
       limitacion_dominio, gastos_admin, inscripcion, gps_24meses, reparaciones_menores)
     + seguros (tabla SEG_RATES por tramo de plazo; paquete completo D+RDH+Cesantía,
       el default del simulador)
     cuota = PMT francesa sobre el monto financiado, tasa del mantenedor Tasas
       (tramo 200 UF sobre el monto financiado).
   Fuente de la lógica: api-gateway/public/cotizaciones/index.html → calcular().
   Si se corrige aquí o allá, corregir AMBOS hasta unificar (pendiente máxima #1).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');
const { getUF } = require('./uf');

// Tasa de seguros por tramo de plazo (paquete completo D+RDH+Cesantía, default
// del simulador) — PARAMÉTRICA: sale del mantenedor Factores de Seguros Clientes
// (parametros_credito: seg_d_* + seg_r_* + seg_c_*). Fallback = valores 2026-07
// si la BD no responde. Caché 60s para no consultar en cada cotización.
const SEG_FALLBACK = { 6: 0.053186, 12: 0.071008, 24: 0.08613, 36: 0.1012, 48: 0.136622, 72: 0.164822 };
const bracket = p => [6, 12, 24, 36, 48, 72].find(b => p <= b) || 72;
let _segCache = null, _segCacheAt = 0;
async function segRates() {
  if (_segCache && Date.now() - _segCacheAt < 60000) return _segCache;
  try {
    // seg_full_drc_<bracket>: factor actuarial del combo COMPLETO (tabla de la
    // aseguradora, mantenedor Factores de Seguros Clientes) — NO es la suma de
    // los factores individuales seg_d/r/c (esos solo distribuyen el total).
    const [rows] = await pool.query("SELECT clave, valor FROM parametros_credito WHERE clave LIKE 'seg_full_drc_%'");
    const p = {}; rows.forEach(r => { p[r.clave] = parseFloat(r.valor) || 0; });
    const t = {};
    for (const b of [6, 12, 24, 36, 48, 72]) t[b] = p['seg_full_drc_' + b] > 0 ? p['seg_full_drc_' + b] : SEG_FALLBACK[b];
    _segCache = t; _segCacheAt = Date.now();
    return t;
  } catch (e) { return SEG_FALLBACK; }
}

function pmt(r, n, pv) {
  if (Math.abs(r) < 1e-10) return pv / n;
  return pv * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
}

/**
 * Cuota mensual aproximada con gastos y seguros incluidos.
 * @param {number} valorVehiculo  precio del auto (CLP)
 * @param {number} pie            pie en CLP
 * @param {number} plazo          meses (6–48)
 * @returns {Promise<null|{cuota:number,montoFin:number,saldoPrecio:number,gastosOp:number,seguros:number,tasa:number,plazo:number,piePct:number}>}
 */
async function cotizarCuota(valorVehiculo, pie, plazo) {
  const v = Math.round(+valorVehiculo || 0), p = Math.round(+pie || 0), n = parseInt(plazo) || 0;
  if (!(v >= 1000000 && v <= 300000000 && p >= 0 && p < v && n >= 6 && n <= 48)) return null;
  const saldoPrecio = v - p;

  // Gastos operacionales del mantenedor Parámetros de Crédito
  const [rows] = await pool.query("SELECT clave, valor FROM parametros_credito WHERE clave IN ('prenda','retiro_gestion','limitacion_dominio','gastos_admin','inscripcion','gps_24meses','reparaciones_menores')");
  const g = {}; rows.forEach(r => { g[r.clave] = parseFloat(r.valor) || 0; });
  const gastosOp = (g.prenda || 0) + (g.retiro_gestion || 0) + (g.limitacion_dominio || 0) + (g.gastos_admin || 0) + (g.inscripcion || 0) + (g.gps_24meses || 0) + (g.reparaciones_menores || 0);

  const subSin = saldoPrecio + gastosOp;
  const seguros = (await segRates())[bracket(n)] * subSin;
  const montoFin = Math.round(subSin + seguros);

  // Tasa vigente del mantenedor Tasas, tramo por 200 UF sobre el monto financiado
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const uf = await getUF(hoy);
  const [[t]] = await pool.query('SELECT tasa_mensual_menor, tasa_mensual_mayor FROM tasas WHERE fecha_desde<=CURDATE() ORDER BY fecha_desde DESC LIMIT 1');
  if (!t) return null;
  const tasa = parseFloat(uf && montoFin > 200 * uf ? t.tasa_mensual_mayor : t.tasa_mensual_menor);
  if (!(tasa > 0)) return null;

  const cuota = Math.round(pmt(tasa / 100, n, montoFin));
  return { cuota, montoFin, saldoPrecio, gastosOp, seguros: Math.round(seguros), tasa, plazo: n, piePct: Math.round(p / v * 100) };
}

/* ── Simulador rápido: monto a financiar → opciones 12/24/36/48 meses ─────────
   CAE desde el MOTOR ÚNICO cae-core.js (definición oficial: RATE ×12). */
const { cae: caeDe } = require('../api-gateway/public/js/cae-core');

/**
 * Simulador rápido para dealers/ejecutivos: un monto → cuotas a 12/24/36/48.
 * @param {number} monto  saldo precio a financiar (CLP)
 * @returns {Promise<null|{opciones:Array,condiciones:Object}>}
 */
async function simuladorRapido(monto) {
  const m = Math.round(+monto || 0);
  if (!(m >= 1000000 && m <= 300000000)) return null;
  const opciones = [];
  for (const n of [12, 24, 36, 48]) {
    const c = await cotizarCuota(m, 0, n);
    if (c) opciones.push({ plazo: n, cuota: c.cuota, cae: caeDe(c.saldoPrecio, c.cuota, n), tasa: c.tasa, monto_fin: c.montoFin });
  }
  if (!opciones.length) return null;
  const hoy = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const uf = await getUF(hoy);
  return { opciones, condiciones: { uf, fecha: hoy, tasa: opciones[opciones.length - 1].tasa, mayor200: uf ? opciones[0].monto_fin > 200 * uf : null } };
}

module.exports = { cotizarCuota, simuladorRapido };
