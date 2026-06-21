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

async function sincronizar() {
  const out = {};
  try { out.uf = await syncTabla('uf', 'uf'); console.log(`[indicadores] UF: ${out.uf.nuevos} nuevos / ${out.uf.total}`); }
  catch (e) { out.uf = { error: e.message }; console.error('[indicadores] UF sync:', e.message); }
  try { out.utm = await syncTabla('utm', 'utm'); console.log(`[indicadores] UTM: ${out.utm.nuevos} nuevos / ${out.utm.total}`); }
  catch (e) { out.utm = { error: e.message }; console.error('[indicadores] UTM sync:', e.message); }
  return out;
}

// Al arrancar (espera a que las tablas estén listas) y luego cada 12 horas.
setTimeout(() => { sincronizar(); }, 15000);
setInterval(() => { sincronizar(); }, 12 * 60 * 60 * 1000);

module.exports = { sincronizar };
