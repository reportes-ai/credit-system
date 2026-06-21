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

async function mesUTMcargado() {
  try { const [[r]] = await pool.query("SELECT 1 ok FROM utm WHERE DATE_FORMAT(fecha,'%Y-%m')=DATE_FORMAT(CURDATE(),'%Y-%m') LIMIT 1"); return !!r; }
  catch { return false; }
}
async function periodoTMCcargado() {
  try { const [[r]] = await pool.query("SELECT 1 ok FROM tasas WHERE fecha_desde >= DATE_FORMAT(CURDATE(),'%Y-%m-01') LIMIT 1"); return !!r; }
  catch { return false; }
}

/**
 * Cadencia: corre cada 24h (y al arrancar / botón con force=true).
 *  - UF : DIARIA, siempre (la API trae los últimos ~31 días).
 *  - UTM: MENSUAL, solo si falta el valor del mes en curso.
 *  - TMC: desde el DÍA 13 y hasta encontrar el período nuevo del mes (luego deja de buscar).
 * force=true (arranque / botón "Actualizar") ignora esas ventanas (sirve para calibrar la TMC).
 */
async function sincronizar(opts = {}) {
  const force = !!opts.force;
  const dia = new Date().getDate();
  const out = {};

  // UF — diaria
  try { out.uf = await syncTabla('uf', 'uf'); await setEstado('sync_uf', ''); console.log(`[indicadores] UF: ${out.uf.nuevos}/${out.uf.total}`); }
  catch (e) { out.uf = { error: e.message }; await setEstado('sync_uf', 'UF: ' + e.message); console.error('[indicadores] UF:', e.message); }

  // UTM — mensual: solo si aún no está el mes en curso
  try {
    if (force || !(await mesUTMcargado())) { out.utm = await syncTabla('utm', 'utm'); console.log(`[indicadores] UTM: ${out.utm.nuevos}/${out.utm.total}`); }
    else out.utm = { sin_cambios: true };
    await setEstado('sync_utm', '');
  } catch (e) { out.utm = { error: e.message }; await setEstado('sync_utm', 'UTM: ' + e.message); console.error('[indicadores] UTM:', e.message); }

  // TMC — desde el día 13 y hasta cargar el período del mes
  try {
    if (force || dia >= 13) {
      if (!force && await periodoTMCcargado()) { out.tmc = { sin_cambios: true, motivo: 'período del mes ya cargado' }; await setEstado('sync_tmc', ''); }
      else { out.tmc = await sincronizarTMC(); await setEstado('sync_tmc', out.tmc.ok ? '' : ('TMC: ' + (out.tmc.motivo || 'no se pudo sincronizar'))); }
    } else {
      out.tmc = { skipped: true, motivo: 'la TMC se busca desde el día 13' };
    }
    console.log('[indicadores] TMC:', JSON.stringify(out.tmc));
  } catch (e) {
    out.tmc = e.code === 'NOCMF' ? { ok: false, motivo: 'falta CMF_API_KEY' } : { error: e.message };
    await setEstado('sync_tmc', 'TMC: ' + (e.code === 'NOCMF' ? 'falta CMF_API_KEY' : e.message));
    if (e.code !== 'NOCMF') console.error('[indicadores] TMC:', e.message);
  }

  await setEstado('sync_ultima', new Date().toISOString());
  return out;
}

// Al arrancar: puesta al día (force). Luego cada 24h (UF diaria; UTM/TMC según ventana).
setTimeout(() => { sincronizar({ force: true }); }, 15000);
setInterval(() => { sincronizar(); }, 24 * 60 * 60 * 1000);

module.exports = { sincronizar };
