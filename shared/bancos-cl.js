'use strict';
/* ── MOTOR ÚNICO: lista de bancos para los selectores del navegador ────────────────────
   Antes /js/bancos-cl.js era un archivo estático con la lista escrita a mano (27-08-2026) y el
   mantenedor Bancos de la Plaza (rh_catalogo BANCO) era OTRA lista: Pato agregó GLOBAL66 y las
   fichas de dealer no lo veían (14-09-2026). Ahora el gateway sirve /js/bancos-cl.js generado
   desde el catálogo (bancos activos), con los alias legados ("CHILE", "BCI", "BBVA", "CORPBANCA")
   resueltos contra los nombres del catálogo. Misma API en el navegador: AF_BANCOS y AF_BANCO_CANON. */
const pool = require('./config/database');

const sinAcentos = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
// sinónimo escrito por el usuario → cómo reconocer el banco del catálogo
const SINONIMOS = [
  ['chile', /EDWARDS|CITI|\bCHILE\b/], ['de chile', /\bCHILE\b/], ['banco de chile', /\bCHILE\b/], ['edwards', /EDWARDS|\bCHILE\b/],
  ['internacional', /INTERNACIONAL/], ['scotiabank', /SCOTIA/], ['bbva', /SCOTIA/], ['scotia', /SCOTIA/], ['desarrollo', /SCOTIA|DESARROLLO/], ['banco del desarrollo', /SCOTIA|DESARROLLO/], ['banco desarrollo', /SCOTIA|DESARROLLO/],
  ['bci', /\bBCI\b|CREDITO E INVERSIONES/], ['banco bci', /\bBCI\b|CREDITO E INVERSIONES/], ['credito e inversiones', /\bBCI\b|CREDITO E INVERSIONES/],
  ['bice', /BICE/], ['hsbc', /HSBC/], ['santander', /SANTANDER/], ['itau', /ITAU|CORPBANCA/], ['corpbanca', /ITAU|CORPBANCA/],
  ['falabella', /FALABELLA/], ['ripley', /RIPLEY/], ['consorcio', /CONSORCIO/], ['tenpo', /TENPO/],
  ['estado', /\bESTADO\b/], ['bancoestado', /\bESTADO\b/], ['banco estado', /\bESTADO\b/], ['estado-vista', /\bESTADO\b/],
  ['security', /SECURITY/], ['mercadopago', /MERCADO ?PAGO/], ['mercado pago', /MERCADO ?PAGO/], ['coopeuch', /COOPEUCH/], ['global66', /GLOBAL ?66/],
  // nombres largos que quedaron guardados en fichas con la lista antigua (27-08-2026)
  ['banco de credito e inversiones', /\bBCI\b|CREDITO E INVERSIONES/], ['banco internacional', /INTERNACIONAL/], ['banco bice', /BICE/],
  ['hsbc bank', /HSBC/], ['banco santander', /SANTANDER/], ['banco itau', /ITAU/], ['banco falabella', /FALABELLA/], ['banco ripley', /RIPLEY/],
  ['banco consorcio', /CONSORCIO/], ['tenpo bank chile', /TENPO/], ['banco security', /SECURITY/], ['banco edwards', /EDWARDS|\bCHILE\b/],
];

let _cache = null, _exp = 0;
async function generarJS() {
  if (_cache && _exp > Date.now()) return _cache;
  const [rows] = await pool.query("SELECT nombre FROM rh_catalogo WHERE tipo='BANCO' AND activo=1 ORDER BY nombre");
  const BANCOS = rows.map(r => r.nombre);
  const ALIAS = {};
  for (const [syn, re] of SINONIMOS) { const hit = BANCOS.find(n => re.test(sinAcentos(n))); if (hit) ALIAS[syn] = hit; }
  _cache = `/* Bancos de la Plaza (mantenedor /mantenedores/bancos/) — generado por el servidor, no editar */
(function () {
  const BANCOS = ${JSON.stringify(BANCOS)};
  const ALIAS = ${JSON.stringify(ALIAS)};
  const norm = v => String(v || '').trim().toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '');
  // Devuelve el nombre del catálogo, o null si lo escrito no calza con ningún banco.
  function canon(v) {
    const n = norm(v); if (!n) return null;
    const ex = BANCOS.find(b => norm(b) === n); if (ex) return ex;
    if (ALIAS[n]) return ALIAS[n];
    const n2 = n.replace(/^banco\\s+/, '');   // "BANCO SECURITY" → "security"
    if (ALIAS[n2]) return ALIAS[n2];
    const ex2 = BANCOS.find(b => norm(b) === n2 || norm(b).replace(/^banco\\s+/, '') === n2); if (ex2) return ex2;
    const sub = BANCOS.filter(b => norm(b).includes(n2) || n2.includes(norm(b)));
    return sub.length === 1 ? sub[0] : null;
  }
  if (typeof window !== 'undefined') { window.AF_BANCOS = BANCOS; window.AF_BANCO_CANON = canon; }
})();
`;
  _exp = Date.now() + 60 * 1000;
  return _cache;
}
function invalidar() { _cache = null; }

module.exports = { generarJS, invalidar };
