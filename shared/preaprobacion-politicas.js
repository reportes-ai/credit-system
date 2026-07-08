'use strict';
/* ───────────────────────────────────────────────────────────────────
   Políticas de Preaprobación — MOTOR ÚNICO de lectura.

   Una sola fuente para las variables de la preaprobación automática,
   consumida por TODOS los canales (Portal del Dealer y WhatsApp/Facilito).
   Los valores viven en la tabla `preaprobacion_parametros` (mantenedor
   /mantenedores/preaprobacion/); este módulo los lee con caché de 60s
   y hace fallback a los defaults si la tabla no existe o falta la clave.
   ─────────────────────────────────────────────────────────────────── */
const pool = require('./config/database');

// Defaults = comportamiento histórico del sistema (no cambian nada al desplegar)
const DEFAULTS = {
  carga_max_pct:          30,          // cuota máxima como % de la renta líquida
  plazos:                 '12,24,36,48', // plazos (meses) evaluados, CSV
  tolerancia_renta_pct:   20,          // % de diferencia declarada vs interna que gatilla nota
  precio_min:             1000000,     // precio mínimo del vehículo
  precio_max:             300000000,   // precio máximo del vehículo
  antiguedad_max_default: 7,           // años máx del vehículo si la matriz de política no dice otra cosa
  max_protestos:          0,           // protestos vigentes permitidos
  max_deuda_morosa:       0,           // $ de deuda morosa permitida
  max_deuda_vencida:      0,           // $ de deuda vencida permitida
  max_deuda_castigada:    0,           // $ de deuda castigada permitida
  wsp_severidad_max:      'regular',   // peor severidad DealerNet que igual preaprueba (bueno|regular|malo)
  wsp_pie_expres_pct:     40,          // % de pie desde el cual el trámite es exprés (mensaje del bot)
};

let _cache = null, _cacheAt = 0;
async function getPoliticas() {
  if (_cache && Date.now() - _cacheAt < 60000) return _cache;
  const out = { ...DEFAULTS };
  try {
    const [rows] = await pool.query('SELECT clave, valor FROM preaprobacion_parametros');
    for (const r of rows) {
      if (!(r.clave in DEFAULTS)) continue;
      const def = DEFAULTS[r.clave];
      out[r.clave] = (typeof def === 'number') ? (isNaN(parseFloat(r.valor)) ? def : parseFloat(r.valor)) : String(r.valor);
    }
  } catch (e) { /* tabla aún no existe → defaults */ }
  out.plazosArr = String(out.plazos).split(',').map(n => parseInt(n, 10)).filter(n => n > 0);
  if (!out.plazosArr.length) out.plazosArr = [12, 24, 36, 48];
  _cache = out; _cacheAt = Date.now();
  return out;
}

module.exports = { getPoliticas, DEFAULTS };
