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
const { cmfGet } = require('./cmf-api');
const { recalcularMesesAbiertos } = require('../../creditos/src/utils/recalcular-mes');
const tasaUtils = require('../../../shared/tasa-utils');

async function getParam(clave) {
  try { const [[r]] = await pool.query('SELECT valor FROM parametros_credito WHERE clave=? LIMIT 1', [clave]); return r ? r.valor : null; }
  catch { return null; }
}
async function setParam(clave, valor, desc) {
  await pool.query('INSERT INTO parametros_credito (clave, valor, descripcion) VALUES (?,?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)', [clave, String(valor), desc || '']);
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
  const tmcs = await cmfGet('tmc', now.getFullYear(), now.getMonth() + 1);
  if (!tmcs.length) return { ok: false, pendiente: true, motivo: 'La CMF aún no publica datos de TMC para este mes.' };

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
  if (!eMenor || !eMayor) return { ok: false, pendiente: true, motivo: 'La CMF aún no publica los TMC calibrados de este mes.' };

  const desde = eMenor.fecha || eMayor.fecha;
  const hasta = eMenor.hasta || eMayor.hasta;
  if (!desde || !hasta) return { ok: false, motivo: 'La CMF no entregó fechas de vigencia válidas.' };

  const [[ya]] = await pool.query('SELECT id_tasa FROM tasas WHERE fecha_desde=? LIMIT 1', [desde]);
  if (ya) return { ok: true, sin_cambios: true, desde, menor: eMenor.valor, mayor: eMayor.valor };

  const mensual_menor = tasaUtils.anualAMensual(eMenor.valor);
  const mensual_mayor = tasaUtils.anualAMensual(eMayor.valor);
  const sp_mayor = 0.67;                                   // spread por defecto (igual que el mantenedor)
  const sp_menor = tasaUtils.spreadMenor(mensual_menor, mensual_mayor, sp_mayor);
  await pool.query(
    'INSERT INTO tasas (fecha_desde, fecha_hasta, tasa_anual_menor, tasa_mensual_menor, tasa_anual_mayor, tasa_mensual_mayor, spread_menor, spread_mayor) VALUES (?,?,?,?,?,?,?,?)',
    [desde, hasta, eMenor.valor, mensual_menor, eMayor.valor, mensual_mayor, sp_menor, sp_mayor]);
  recalcularMesesAbiertos().then(r => { if (r && r.actualizados) console.log(`[tmc recalc] ${r.actualizados} ops`); }).catch(e => console.error('[tmc recalc]', e.message));

  return { ok: true, insertado: true, desde, hasta, menor: eMenor.valor, mayor: eMayor.valor };
}

module.exports = { sincronizarTMC };
