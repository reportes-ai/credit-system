'use strict';
/**
 * shared/seguros-autofacil.js — MOTOR ÚNICO de la prima de los seguros de los créditos
 * AUTOFÁCIL (recursos propios) con SURA: desgravamen y cesantía.
 *
 *   prima = tasa del tramo de plazo (opción vigente del mantenedor) × MIC
 *   MIC   = Monto Inicial del Crédito (así lo define la cotización SURA)
 *   Opción 2 (tasa técnica neta) admite un markup de AutoFácil: prima_cliente = prima_neta × (1 + markup)
 *   El markup es POR TRAMO (29-09-2026: igualar tramo a tramo el precio de AutoFin); si el tramo no lo tiene, usa el de la cabecera.
 *   Opción 1 (tasa bruta) ya trae las comisiones dentro: prima_cliente = prima_neta
 *
 * Los datos viven en seguros_autofacil / _tramos / _comisiones (mantenedor Seguros AutoFácil).
 * Caché 60 s. NO es el motor de los seguros del canal AUTOFIN (shared/cotizador.js, seg_*).
 */
const pool = require('./config/database');
const CORE = require('../api-gateway/public/js/seguros-sura-core');   // fórmula única (isomorfa): la misma del Simulador y las Cartas

let _cache = null, _at = 0;
const TTL = 60000;

async function cargar(force = false) {
  if (!force && _cache && Date.now() - _at < TTL) return _cache;
  const [segs] = await pool.query('SELECT * FROM seguros_autofacil ORDER BY FIELD(seguro,"DESGRAVAMEN","CESANTIA","VEHICULO")');
  const [tr] = await pool.query('SELECT seguro, opcion, plazo_desde, plazo_hasta, tasa_pct, markup_pct FROM seguros_autofacil_tramos ORDER BY seguro, opcion, plazo_desde');
  const [co] = await pool.query('SELECT seguro, opcion, nombre, pct, iva_incluido FROM seguros_autofacil_comisiones ORDER BY seguro, opcion, orden');
  const out = segs.map(s => {
    let links = [];
    try { links = typeof s.links === 'string' ? JSON.parse(s.links) : (s.links || []); } catch (_) {}
    const f = v => (v == null ? null : require('./fecha-chile').isoFlex(v));
    return {
      ...s, links, fecha_cotizacion: f(s.fecha_cotizacion), vigencia_desde: f(s.vigencia_desde),
      markup_pct: s.markup_pct == null ? null : Number(s.markup_pct), tope_capital_uf: s.tope_capital_uf == null ? null : Number(s.tope_capital_uf),
      tope_cuota_uf: s.tope_cuota_uf == null ? null : Number(s.tope_cuota_uf),
      tramos: { 1: tr.filter(t => t.seguro === s.seguro && t.opcion === 1).map(t => ({ plazo_desde: t.plazo_desde, plazo_hasta: t.plazo_hasta, tasa_pct: Number(t.tasa_pct), markup_pct: null })),
                2: tr.filter(t => t.seguro === s.seguro && t.opcion === 2).map(t => ({ plazo_desde: t.plazo_desde, plazo_hasta: t.plazo_hasta, tasa_pct: Number(t.tasa_pct), markup_pct: t.markup_pct == null ? null : Number(t.markup_pct) })) },
      comisiones: { 1: co.filter(c => c.seguro === s.seguro && c.opcion === 1).map(c => ({ nombre: c.nombre, pct: Number(c.pct), iva_incluido: c.iva_incluido === 1 })),
                    2: co.filter(c => c.seguro === s.seguro && c.opcion === 2).map(c => ({ nombre: c.nombre, pct: Number(c.pct), iva_incluido: c.iva_incluido === 1 })) },
    };
  });
  _cache = out; _at = Date.now();
  return out;
}
function invalidar() { _cache = null; }

/**
 * Prima única de un seguro AutoFácil.
 * @param {'DESGRAVAMEN'|'CESANTIA'} seguro
 * @param {number} mic     monto inicial del crédito (CLP)
 * @param {number} plazo   meses
 * @param {object} [o]     { opcion } para simular una opción distinta de la vigente
 * @returns {Promise<{seguro,opcion,plazo,tramo,tasa_pct,prima_neta,markup_pct,prima_cliente,comisiones:[{nombre,pct,monto}],error?}>}
 */
async function prima(seguro, mic, plazo, o = {}) {
  const segs = await cargar();
  const s = CORE.seguroDe(segs, seguro);
  if (!s) return { seguro, error: 'Seguro no configurado' };
  return CORE.primaDe(s, mic, plazo, o.opcion);
}
/** Primas capitalizadas (desgravamen + cesantía) de un crédito AutoFácil: MIC = (saldo + gastos) / (1 − tasas) */
async function capitalizar(subSinSeg, plazo, o = {}) { return CORE.capitalizar(await cargar(), subSinSeg, plazo, o); }

module.exports = { cargar, invalidar, prima, capitalizar, CORE };
