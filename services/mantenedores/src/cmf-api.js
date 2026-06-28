'use strict';
/**
 * Cliente de la API oficial CMF (ex-SBIF). Una sola fuente para UF, UTM, dólar, IPC y TMC.
 *   GET https://api.cmfchile.cl/api-sbifv3/recursos_api/<recurso>/<año>/<mes>?apikey=KEY&formato=json
 * Requiere CMF_API_KEY (env Render). Devuelve [{fecha,valor,tipo,hasta}] normalizado.
 */
const axios = require('axios');

// Número chileno "39.795,85" / "71.506" / "34,42" → 39795.85 / 71506 / 34.42
const parseCLNum = v => {
  const n = Number(String(v == null ? '' : v).replace(/\./g, '').replace(',', '.'));
  return isFinite(n) ? n : NaN;
};
function normFecha(s) {
  s = String(s || '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);   if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})[-/](\d{2})[-/](\d{4})/);  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return '';
}

async function cmfGet(recurso, year, month) {
  const key = process.env.CMF_API_KEY;
  if (!key) { const e = new Error('Falta CMF_API_KEY'); e.code = 'NOCMF'; throw e; }
  // La CMF exige el mes con DOS dígitos (MM): a una ruta con mes sin cero (…/2026/6) responde
  // lista VACÍA y sin error → "+0" con la tabla vacía. Padding a MM. (month vacío → ruta por año.)
  const mm = (month === undefined || month === null || month === '') ? '' : '/' + String(month).padStart(2, '0');
  const url = `https://api.cmfchile.cl/api-sbifv3/recursos_api/${recurso}/${year}${mm}?apikey=${encodeURIComponent(key)}&formato=json`;
  // validateStatus: la CMF responde el detalle del error (key inválida, sin datos, etc.) en el body con
  // CodigoError AUN con HTTP != 200 (ej. 421 "API key no valida"). Sin esto, axios lo oculta tras un
  // genérico "Request failed with status code 421" y no se sabe la causa real.
  const r = await axios.get(url, { timeout: 15000, headers: { Accept: 'application/json' }, validateStatus: () => true });
  const body = r.data;
  if (body && body.CodigoError) { const e = new Error('CMF: ' + (body.Mensaje || ('error ' + body.CodigoError))); e.code = 'CMFERR'; throw e; }
  // El array viene bajo distintas llaves (UFs, UTMs, Dolares, IPCs, TMCs): tomamos el primer array.
  const arr = (body && typeof body === 'object') ? (Object.values(body).find(v => Array.isArray(v)) || []) : [];
  return arr.map(x => ({
    fecha: normFecha(x.Fecha ?? x.fecha),
    valor: parseCLNum(x.Valor ?? x.valor),
    tipo:  (x.Tipo ?? x.tipo) != null ? String(x.Tipo ?? x.tipo).trim() : null,
    hasta: normFecha(x.Hasta ?? x.hasta),
  })).filter(x => x.fecha && isFinite(x.valor));
}

module.exports = { cmfGet, parseCLNum, normFecha };
