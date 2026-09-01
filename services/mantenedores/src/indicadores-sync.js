'use strict';
/**
 * Sincronizador de indicadores — fuente única: API oficial CMF (cmf-api.js).
 *  - UF y dólar: DIARIOS (siempre).
 *  - UTM e IPC: MENSUALES (mes actual + anterior, por la publicación tardía del IPC).
 *  - TMC: desde el DÍA 13 y hasta encontrar el período nuevo del mes (tmc-sync.js).
 * Corre al arrancar (force) y cada 24h. Requiere CMF_API_KEY (sin ella, falla suave y avisa).
 */
const { programar } = require('../../../shared/scheduler.js');
const pool = require('../../../shared/config/database');
const { cmfGet } = require('./cmf-api');
const { sincronizarTMC, backfillTMC } = require('./tmc-sync');

// Estado de la última sincronización por indicador ('' = OK) → lo usan Alertas y el sello de la
// página. Tabla propia con valor TEXT: parametros_credito.valor es DECIMAL y NO admite las
// fechas/errores que guardamos aquí (el INSERT fallaba en silencio → sello siempre vacío).
require('../../../shared/migrate').enFila('indicadores-sync', async () => {
  try { await pool.query("CREATE TABLE IF NOT EXISTS indicadores_estado (clave VARCHAR(50) PRIMARY KEY, valor TEXT)"); }
  catch (e) { if (e.errno !== 1050) console.error('[indicadores_estado migration]', e.message); }
});

async function setEstado(clave, valor) {
  try {
    await pool.query(
      "INSERT INTO indicadores_estado (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)",
      [clave, String(valor == null ? '' : valor).slice(0, 255)]);
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

  // Diarios: UF y dólar. La UF se publica el día 9 con los valores HASTA el día
  // 10 del mes siguiente → se pide también el MES SIGUIENTE (y el anterior los
  // primeros días, por huecos). INSERT IGNORE deduplica; no restringir al mes
  // en curso (pedido Pato 01-09-2026: quedó cargada solo hasta el 31-08).
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  // El dólar no tiene valores futuros (es el observado del día), pero el mes
  // anterior va siempre: rellena huecos si algún día falló la corrida.
  const MESES_POR_TABLA = {
    uf:    [[py, pm], [y, m], [ny, nm]],
    dolar: [[py, pm], [y, m]],
  };
  for (const [rec, tab] of [['uf', 'uf'], ['dolar', 'dolar']]) {
    let nuevos = 0, total = 0, ok = false, lastErr = null;
    for (const [yy, mm2] of MESES_POR_TABLA[tab]) {
      try { const r = await syncTabla(rec, tab, yy, mm2, false); nuevos += r.nuevos; total += r.total; ok = true; }
      catch (e) { lastErr = e; }
    }
    if (ok) { out[tab] = { nuevos, total }; await setEstado('sync_' + tab, ''); await setEstado('sync_' + tab + '_ts', new Date().toISOString()); }
    else {
      const e = lastErr || new Error('sin datos');
      out[tab] = { error: e.message };
      await setEstado('sync_' + tab, eMsg(tab.toUpperCase(), e));
      if (e.code !== 'NOCMF') console.error('[indicadores]', tab, e.message);
    }
  }
  // Mensuales: UTM e IPC → se piden por AÑO (/recurso/AAAA trae TODOS los meses publicados del
  // año, según doc CMF), no mes a mes. Se trae el año en curso y el anterior (cubre enero y da
  // respaldo); INSERT IGNORE deduplica. Esto evita depender de la publicación tardía del mes.
  for (const [rec, tab] of [['utm', 'utm'], ['ipc', 'ipc']]) {
    let nuevos = 0, total = 0, ok = false, lastErr = null;
    // Desde noviembre se pide también el AÑO SIGUIENTE: la UTM de enero se
    // publica en diciembre y no debe quedar fuera por el corte de año.
    for (const yy of (m >= 11 ? [y, py, y + 1] : [y, py])) {
      try { const r = await syncTabla(rec, tab, yy, null, true); nuevos += r.nuevos; total += r.total; ok = true; }
      catch (e) { lastErr = e; }
    }
    if (ok) {
      out[tab] = { nuevos, total };
      await setEstado('sync_' + tab, '');
      await setEstado('sync_' + tab + '_ts', new Date().toISOString());
    } else {
      const e = lastErr || new Error('sin datos');
      out[tab] = { error: e.message };
      await setEstado('sync_' + tab, eMsg(tab.toUpperCase(), e));
      if (e.code !== 'NOCMF') console.error('[indicadores]', tab, e.message);
    }
  }
  // TMC: desde el día 13 y hasta cargar el período del mes
  try {
    if (force || dia >= 13) {
      if (!force && await periodoTMCcargado()) { out.tmc = { sin_cambios: true, motivo: 'período del mes ya cargado' }; await setEstado('sync_tmc', ''); await setEstado('sync_tmc_ts', new Date().toISOString()); }
      else {
        out.tmc = await sincronizarTMC();
        if (out.tmc.ok) { await setEstado('sync_tmc', ''); await setEstado('sync_tmc_ts', new Date().toISOString()); }
        // "pendiente" = la CMF aún no publica el TMC del mes (normal a inicios de mes):
        // NO es un problema y NO debe alarmar; las tasas vigentes siguen OK y el
        // vencimiento real ya lo cubren las alertas de Tasas. Se limpia el estado.
        else if (out.tmc.pendiente) await setEstado('sync_tmc', '');
        else await setEstado('sync_tmc', 'TMC: ' + (out.tmc.motivo || 'no se pudo sincronizar'));
      }
    } else out.tmc = { skipped: true, motivo: 'la TMC se busca desde el día 13' };
  } catch (e) {
    out.tmc = e.code === 'NOCMF' ? { ok: false, motivo: 'falta CMF_API_KEY' } : { error: e.message };
    await setEstado('sync_tmc', eMsg('TMC', e));
    if (e.code !== 'NOCMF') console.error('[indicadores] TMC', e.message);
  }

  // Backfill de TMC histórica (una vez que exista cobertura, sale al tiro con sin_cambios).
  // Necesaria para el interés por mora de cuotas antiguas (día a día con la TMC de SU fecha).
  if (force) {
    try { out.tmc_backfill = await backfillTMC('2017-01'); }   // cartera más antigua en mora: feb-2017
    catch (e) { out.tmc_backfill = { error: e.message }; if (e.code !== 'NOCMF') console.error('[indicadores] tmc backfill', e.message); }
  }

  await setEstado('sync_ultima', new Date().toISOString());
  console.log('[indicadores]', JSON.stringify(out));
  // Un fallo de red (ej. "socket hang up") NO puede esperar 24h al próximo tick:
  // reintento a los 30 min, solo para las corridas automáticas del scheduler.
  if (opts.auto && (out.uf?.error || out.dolar?.error || out.utm?.error || out.ipc?.error || out.tmc?.error)) programarReintento();
  return out;
}

let _retryTimer = null;
function programarReintento() {
  if (_retryTimer) return;
  _retryTimer = setTimeout(() => { _retryTimer = null; sincronizar({ auto: true }).catch(() => {}); }, 30 * 60 * 1000);
  if (_retryTimer.unref) _retryTimer.unref();
  console.log('[indicadores] reintento programado en 30 min (fallo de red)');
}

// Al arrancar: puesta al día (force). Luego cada 24h.
programar('indicadores-sync', () => sincronizar({ auto: true }), 24 * 60 * 60 * 1000,
  { arranqueMs: 15000, arranqueFn: () => sincronizar({ force: true, auto: true }) });

module.exports = { sincronizar };
