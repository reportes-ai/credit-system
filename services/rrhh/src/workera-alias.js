'use strict';
// Alias de RUT hacia Workera: el RUT es la LLAVE del trabajador en Workera y no
// se puede editar por API. Cuando el RUT de la suite difiere del que Workera
// conoce (ej. extranjero que pasó de RUT provisorio a definitivo), se mapea acá.
// Paramétrico: rh_config 'workera_rut_alias' = JSON { "rut_suite": "rut_workera" }.
const pool = require('../../../shared/config/database');

require('../../../shared/migrate').enFila('rrhh-workera-alias', async () => {
  await pool.query(`INSERT IGNORE INTO rh_config (clave, valor) VALUES
    ('workera_rut_alias', '{"28817774-0":"28617412-4"}')`);
  console.log('[workera-alias] listo');
});

const norm = r => String(r || '').replace(/[.\s-]/g, '').toUpperCase();

let _cache = { t: 0, map: {} };
// Mapa normalizado rut_suite → rut_workera (caché 60s)
async function mapa() {
  if (Date.now() - _cache.t < 60000) return _cache.map;
  const map = {};
  try {
    const [[cfg]] = await pool.query(`SELECT valor FROM rh_config WHERE clave='workera_rut_alias'`);
    for (const [k, v] of Object.entries(JSON.parse(cfg?.valor || '{}'))) map[norm(k)] = norm(v);
  } catch (e) { console.error('[workera-alias]', e.message); }
  _cache = { t: Date.now(), map };
  return map;
}

// RUT normalizado tal como lo conoce Workera
async function rutWorkera(rut) { const m = await mapa(); const n = norm(rut); return m[n] || n; }

module.exports = { mapa, rutWorkera, norm };
