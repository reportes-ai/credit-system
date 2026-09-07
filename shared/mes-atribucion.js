'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   MES DE ATRIBUCIÓN de una operación — motor único (Máxima 1).

   La definición de negocio (Pato, 21-08-2026): la comisión y las metas se
   atribuyen por la FECHA DE CURSE (fecha_otorgado). Pero INDEXA no dejaba
   digitar con fechas distintas, así que los meses históricos se ajustaron a
   mano vía la columna `mes` (mes contable) y ESOS ajustes deben seguir
   cuadrando tal cual — recalcular el pasado descuadraría todo lo ya pagado.

   Regla:  mes evaluado <  corte → manda `mes` (el mes contable ajustado)
           mes evaluado >= corte → manda `fecha_otorgado` (la fecha de curse)

   El corte es PARAMÉTRICO: parametros_credito.mes_corte_curse (formato AAAAMM,
   default 202608 = agosto 2026, el primer mes que se rige por fecha de curse).
   ───────────────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

const { MES_SQL, SET_MES_SQL, DEFAULT_CORTE } = require('./mes-atribucion-core');   // parte pura, sin pool

require('./migrate').enFila('mes-atribucion', async () => {
  try {
    await pool.query(
      `INSERT IGNORE INTO parametros_credito (clave, valor, descripcion) VALUES
        ('mes_corte_curse', 202608,
         'Comisiones/metas — primer mes (AAAAMM) que se atribuye por FECHA DE CURSE; antes manda el mes contable ajustado')`);
  } catch (e) { console.error('[mes-atribucion seed]', e.message); }
});

/** Mes de corte como 'YYYY-MM' (cacheado 60s — es un parámetro, no un dato vivo). */
let _cache = null, _cacheAt = 0;
async function mesCorte() {
  if (_cache && Date.now() - _cacheAt < 60000) return _cache;
  try {
    const [[r]] = await pool.query("SELECT valor FROM parametros_credito WHERE clave='mes_corte_curse'");
    const v = String(Math.round(parseFloat(r && r.valor) || 0));
    _cache = /^\d{6}$/.test(v) ? v.slice(0, 4) + '-' + v.slice(4) : DEFAULT_CORTE;
  } catch (_) { _cache = DEFAULT_CORTE; }
  _cacheAt = Date.now();
  return _cache;
}

module.exports = { mesCorte, MES_SQL, SET_MES_SQL, DEFAULT_CORTE };
