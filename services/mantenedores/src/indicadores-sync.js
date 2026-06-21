'use strict';
/**
 * Sincronizador automático de indicadores (UF y UTM) desde mindicador.cl.
 * - Corre al arrancar (tras 15s) y cada 12 horas.
 * - INSERT IGNORE: solo agrega fechas que falten; NUNCA pisa valores ya cargados
 *   ni ediciones del administrador.
 * - UF se publica con valores diarios (la API trae ~31 días); UTM es mensual.
 */
const pool = require('../../../shared/config/database');
const axios = require('axios');
const { sincronizarTMC } = require('./tmc-sync');

async function fetchSerie(ind) {
  const r = await axios.get(`https://mindicador.cl/api/${ind}`, { timeout: 15000, headers: { Accept: 'application/json' } });
  const serie = (r.data && r.data.serie) || [];
  return serie
    .map(s => ({ fecha: String(s.fecha).slice(0, 10), valor: Number(s.valor) }))
    .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s.fecha) && isFinite(s.valor) && s.valor > 0);
}

async function syncTabla(ind, tabla) {
  const serie = await fetchSerie(ind);
  let nuevos = 0;
  for (const s of serie) {
    const fecha = ind === 'utm' ? s.fecha.slice(0, 7) + '-01' : s.fecha; // UTM: 1 registro por mes
    const [r] = await pool.query(`INSERT IGNORE INTO ${tabla} (fecha, valor) VALUES (?, ?)`, [fecha, s.valor]);
    if (r.affectedRows === 1) nuevos++;
  }
  return { total: serie.length, nuevos };
}

// Guarda el estado de la última sincronización por indicador ('' = OK) para que el
// módulo de Alertas avise si algo no se pudo sincronizar.
async function setEstado(clave, valor) {
  try {
    await pool.query(
      "INSERT INTO parametros_credito (clave, valor, descripcion) VALUES (?,?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)",
      [clave, String(valor || '').slice(0, 255), 'Estado de la última sincronización de indicadores']);
  } catch (_) {}
}

/**
 * @param {object} opts  { force } — force=true ignora la ventana del día 13 (botón manual / arranque)
 * El sync automático corre cada 24h pero solo ACTÚA desde el día 13 de cada mes
 * (cuando se publican UF/UTM/TMC del nuevo período).
 */
async function sincronizar(opts = {}) {
  if (!opts.force && new Date().getDate() < 13) return { skipped: true, motivo: 'fuera de ventana (se sincroniza desde el día 13)' };
  const out = {};
  try { out.uf = await syncTabla('uf', 'uf'); await setEstado('sync_uf', ''); console.log(`[indicadores] UF: ${out.uf.nuevos}/${out.uf.total}`); }
  catch (e) { out.uf = { error: e.message }; await setEstado('sync_uf', 'UF: ' + e.message); console.error('[indicadores] UF sync:', e.message); }
  try { out.utm = await syncTabla('utm', 'utm'); await setEstado('sync_utm', ''); console.log(`[indicadores] UTM: ${out.utm.nuevos}/${out.utm.total}`); }
  catch (e) { out.utm = { error: e.message }; await setEstado('sync_utm', 'UTM: ' + e.message); console.error('[indicadores] UTM sync:', e.message); }
  try {
    out.tmc = await sincronizarTMC();
    await setEstado('sync_tmc', out.tmc.ok ? '' : ('TMC: ' + (out.tmc.motivo || 'no se pudo sincronizar')));
    console.log('[indicadores] TMC:', JSON.stringify(out.tmc));
  } catch (e) {
    out.tmc = e.code === 'NOCMF' ? { ok: false, motivo: 'falta CMF_API_KEY' } : { error: e.message };
    await setEstado('sync_tmc', 'TMC: ' + (e.code === 'NOCMF' ? 'falta CMF_API_KEY' : e.message));
    if (e.code !== 'NOCMF') console.error('[indicadores] TMC sync:', e.message);
  }
  await setEstado('sync_ultima', new Date().toISOString());
  return out;
}

// Al arrancar: una puesta al día (force). Luego cada 24h, actuando solo desde el día 13.
setTimeout(() => { sincronizar({ force: true }); }, 15000);
setInterval(() => { sincronizar(); }, 24 * 60 * 60 * 1000);

module.exports = { sincronizar };
