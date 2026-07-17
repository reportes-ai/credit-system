'use strict';
// Cliente de la API de Workera (reloj control) — fuente ÚNICA de marcaciones.
// Auth por headers API_USER / API_KEY (verificado contra producción).
// Docs: https://help.workera.com/documentación-de-apis
const BASE = 'https://workera.com/apiClient/v1';

function credenciales() {
  const user = process.env.WORKERA_API_USER, key = process.env.WORKERA_API_KEY;
  if (!user || !key) throw new Error('Faltan WORKERA_API_USER / WORKERA_API_KEY en las variables de entorno');
  return { API_USER: user, API_KEY: key };
}

async function get(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${BASE}/${path}${qs ? '?' + qs : ''}`, { headers: credenciales() });
  if (!r.ok) throw new Error(`Workera ${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// Todas las páginas de un endpoint paginado ({page,totalPages,data})
async function getTodas(path, params = {}) {
  const out = [];
  let page = 1, total = 1;
  do {
    const j = await get(path, { ...params, page });
    out.push(...(j.data || []));
    total = Number(j.totalPages) || 1;
    page++;
  } while (page <= total && page <= 100);
  return out;
}

// Marcaciones entre dos fechas (yyyy-MM-dd, inclusive)
const marcaciones = (start, end) => getTodas('attendanceData', { start, end });

// Trabajadores registrados en Workera
const trabajadores = () => getTodas('employee');

const configurado = () => !!(process.env.WORKERA_API_USER && process.env.WORKERA_API_KEY);

module.exports = { marcaciones, trabajadores, configurado };
