'use strict';
/**
 * Sincronizador de TMC (Tasa Máxima Convencional) desde la API oficial de la CMF.
 *   GET https://api.cmfchile.cl/api-sbifv3/recursos_api/tmc/<año>/<mes>?apikey=KEY&formato=json
 * Requiere CMF_API_KEY (env var en Render; registro gratuito en la CMF). Sin ella, no hace nada.
 *
 * La TMC vive en el mantenedor de Tasas (tasa_anual_menor=≤200 UF, tasa_anual_mayor=>200 UF).
 * Calibración: identifica QUÉ tipos de TMC de la CMF corresponden a los valores ya cargados
 * (verifica que el valor vigente sea idéntico al del mantenedor) y guarda esos tipos en
 * parametros_credito. Luego, cada mes, carga el período nuevo en `tasas` (gatilla el recálculo
 * de meses abiertos, igual que una carga manual). INSERT solo de períodos nuevos; nunca pisa.
 */
const pool = require('../../../shared/config/database');
const axios = require('axios');
const { recalcularMesesAbiertos } = require('../../creditos/src/utils/recalcular-mes');

const round4 = n => Math.round(n * 10000) / 10000;

function normFecha(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);            if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);          if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return '';
}

async function getParam(clave) {
  try { const [[r]] = await pool.query('SELECT valor FROM parametros_credito WHERE clave=? LIMIT 1', [clave]); return r ? r.valor : null; }
  catch { return null; }
}
async function setParam(clave, valor, desc) {
  await pool.query('INSERT INTO parametros_credito (clave, valor, descripcion) VALUES (?,?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', [clave, String(valor), desc || '']);
}

async function fetchTMC(year, month) {
  const key = process.env.CMF_API_KEY;
  if (!key) { const e = new Error('Falta CMF_API_KEY'); e.code = 'NOCMF'; throw e; }
  const url = `https://api.cmfchile.cl/api-sbifv3/recursos_api/tmc/${year}/${month}?apikey=${encodeURIComponent(key)}&formato=json`;
  const r = await axios.get(url, { timeout: 15000, headers: { Accept: 'application/json' } });
  const arr = (r.data && (r.data.TMCs || r.data.tmcs || r.data.TMC)) || [];
  return arr.map(x => ({
    tipo:  String(x.Tipo ?? x.tipo ?? '').trim(),
    valor: parseFloat(String(x.Valor ?? x.valor ?? '').replace(',', '.')),
    desde: normFecha(x.Fecha ?? x.fecha),
    hasta: normFecha(x.Hasta ?? x.hasta),
  })).filter(x => x.tipo && isFinite(x.valor) && x.valor > 0);
}

// Identifica los tipos de TMC que coinciden con los valores ya cargados (verificación "idéntico al cargado").
async function calibrar(tmcs) {
  const [[t]] = await pool.query('SELECT tasa_anual_menor, tasa_anual_mayor FROM tasas ORDER BY fecha_desde DESC LIMIT 1');
  if (!t) return {};
  const cerca = (a, b) => Math.abs(a - b) < 0.05;
  const menor = tmcs.find(x => cerca(x.valor, Number(t.tasa_anual_menor)));
  const mayor = tmcs.find(x => cerca(x.valor, Number(t.tasa_anual_mayor)));
  if (menor) await setParam('tmc_tipo_menor', menor.tipo, 'CMF: tipo de TMC para ≤200 UF (auto-calibrado)');
  if (mayor) await setParam('tmc_tipo_mayor', mayor.tipo, 'CMF: tipo de TMC para >200 UF (auto-calibrado)');
  return { menor: menor && menor.tipo, mayor: mayor && mayor.tipo };
}

async function sincronizarTMC() {
  const now = new Date();
  const tmcs = await fetchTMC(now.getFullYear(), now.getMonth() + 1);
  if (!tmcs.length) return { ok: false, motivo: 'La CMF no devolvió datos de TMC para el mes.' };

  let tipoMenor = await getParam('tmc_tipo_menor');
  let tipoMayor = await getParam('tmc_tipo_mayor');
  if (!tipoMenor || !tipoMayor) {
    const cal = await calibrar(tmcs);
    tipoMenor = tipoMenor || cal.menor; tipoMayor = tipoMayor || cal.mayor;
  }
  if (!tipoMenor || !tipoMayor)
    return { ok: false, motivo: 'No se pudo calibrar: ningún tipo de TMC de la CMF coincide con la tasa cargada. Verifica/carga la TMC manual una vez y reintenta.' };

  const eMenor = tmcs.find(x => x.tipo === String(tipoMenor));
  const eMayor = tmcs.find(x => x.tipo === String(tipoMayor));
  if (!eMenor || !eMayor) return { ok: false, motivo: 'La CMF no trae este mes los tipos de TMC calibrados.' };

  const desde = eMenor.desde || eMayor.desde;
  const hasta = eMenor.hasta || eMayor.hasta;
  if (!desde || !hasta) return { ok: false, motivo: 'La CMF no entregó fechas de vigencia válidas.' };

  const [[ya]] = await pool.query('SELECT id_tasa FROM tasas WHERE fecha_desde=? LIMIT 1', [desde]);
  if (ya) return { ok: true, sin_cambios: true, desde, menor: eMenor.valor, mayor: eMayor.valor };

  const mensual_menor = round4(eMenor.valor / 12);
  const mensual_mayor = round4(eMayor.valor / 12);
  const sp_mayor = 0.67;                                   // spread por defecto (igual que el mantenedor)
  const sp_menor = round4(mensual_menor - mensual_mayor + sp_mayor);
  await pool.query(
    'INSERT INTO tasas (fecha_desde, fecha_hasta, tasa_anual_menor, tasa_mensual_menor, tasa_anual_mayor, tasa_mensual_mayor, spread_menor, spread_mayor) VALUES (?,?,?,?,?,?,?,?)',
    [desde, hasta, eMenor.valor, mensual_menor, eMayor.valor, mensual_mayor, sp_menor, sp_mayor]);
  recalcularMesesAbiertos().then(r => { if (r && r.actualizados) console.log(`[tmc recalc] ${r.actualizados} ops`); }).catch(e => console.error('[tmc recalc]', e.message));

  return { ok: true, insertado: true, desde, hasta, menor: eMenor.valor, mayor: eMayor.valor };
}

module.exports = { sincronizarTMC };
