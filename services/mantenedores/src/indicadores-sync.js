'use strict';
/**
 * Sincronizador de indicadores — fuente única: API oficial CMF (cmf-api.js).
 *  - UF y dólar: DIARIOS (siempre).
 *  - UTM e IPC: MENSUALES (mes actual + anterior, por la publicación tardía del IPC).
 *  - TMC: desde el DÍA 13 y hasta encontrar el período nuevo del mes (tmc-sync.js).
 * Corre al arrancar (force) y cada 24h. Requiere CMF_API_KEY (sin ella, falla suave y avisa).
 */
const pool = require('../../../shared/config/database');
const { cmfGet } = require('./cmf-api');
const { sincronizarTMC } = require('./tmc-sync');

// Estado de la última sincronización por indicador ('' = OK) → lo usa el módulo de Alertas.
async function setEstado(clave, valor) {
  try {
    await pool.query(
      "INSERT INTO parametros_credito (clave, valor, descripcion) VALUES (?,?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)",
      [clave, String(valor || '').slice(0, 255), 'Estado de la última sincronización de indicadores']);
  } catch (_) {}
}

async function syncTabla(recurso, tabla, year, month, mensual) {
  const serie = await cmfGet(recurso, year, month);
  let nuevos = 0;
  for (const s of serie) {
    const fecha = mensual ? s.fecha.slice(0, 7) + '-01' : s.fecha;   // mensuales → día 1 del mes
    const [r] = await pool.query(`INSERT IGNORE INTO ${tabla} (fecha, valor) VALUES (?, ?)`, [fecha, s.valor]);
    if (r.affectedRows === 1) nuevos++;
  }
  return { total: serie.length, nuevos };
}

async function periodoTMCcargado() {
  try { const [[r]] = await pool.query("SELECT 1 ok FROM tasas WHERE fecha_desde >= DATE_FORMAT(CURDATE(),'%Y-%m-01') LIMIT 1"); return !!r; }
  catch { return false; }
}

const eMsg = (lbl, e) => `${lbl}: ${e.code === 'NOCMF' ? 'falta CMF_API_KEY' : e.message}`;

async function sincronizar(opts = {}) {
  const force = !!opts.force;
  const dia = new Date().getDate();
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const out = {};

  // Diarios: UF y dólar
  for (const [rec, tab] of [['uf', 'uf'], ['dolar', 'dolar']]) {
    try { out[tab] = await syncTabla(rec, tab, y, m, false); await setEstado('sync_' + tab, ''); await setEstado('sync_' + tab + '_ts', new Date().toISOString()); }
    catch (e) { out[tab] = { error: e.message }; await setEstado('sync_' + tab, eMsg(tab.toUpperCase(), e)); if (e.code !== 'NOCMF') console.error('[indicadores]', tab, e.message); }
  }
  // Mensuales: UTM e IPC (mes actual + anterior)
  for (const [rec, tab] of [['utm', 'utm'], ['ipc', 'ipc']]) {
    try {
      const a = await syncTabla(rec, tab, y, m, true);
      let b = { nuevos: 0, total: 0 };
      try { b = await syncTabla(rec, tab, py, pm, true); } catch (_) {}
      out[tab] = { nuevos: a.nuevos + b.nuevos, total: a.total + b.total };
      await setEstado('sync_' + tab, '');
      await setEstado('sync_' + tab + '_ts', new Date().toISOString());
    } catch (e) { out[tab] = { error: e.message }; await setEstado('sync_' + tab, eMsg(tab.toUpperCase(), e)); if (e.code !== 'NOCMF') console.error('[indicadores]', tab, e.message); }
  }
  // TMC: desde el día 13 y hasta cargar el período del mes
  try {
    if (force || dia >= 13) {
      if (!force && await periodoTMCcargado()) { out.tmc = { sin_cambios: true, motivo: 'período del mes ya cargado' }; await setEstado('sync_tmc', ''); await setEstado('sync_tmc_ts', new Date().toISOString()); }
      else {
        out.tmc = await sincronizarTMC();
        if (out.tmc.ok) { await setEstado('sync_tmc', ''); await setEstado('sync_tmc_ts', new Date().toISOString()); }
        else await setEstado('sync_tmc', 'TMC: ' + (out.tmc.motivo || 'no se pudo sincronizar'));
      }
    } else out.tmc = { skipped: true, motivo: 'la TMC se busca desde el día 13' };
  } catch (e) {
    out.tmc = e.code === 'NOCMF' ? { ok: false, motivo: 'falta CMF_API_KEY' } : { error: e.message };
    await setEstado('sync_tmc', eMsg('TMC', e));
    if (e.code !== 'NOCMF') console.error('[indicadores] TMC', e.message);
  }

  await setEstado('sync_ultima', new Date().toISOString());
  console.log('[indicadores]', JSON.stringify(out));
  return out;
}

// Al arrancar: puesta al día (force). Luego cada 24h.
setTimeout(() => { sincronizar({ force: true }); }, 15000);
setInterval(() => { sincronizar(); }, 24 * 60 * 60 * 1000);

module.exports = { sincronizar };
