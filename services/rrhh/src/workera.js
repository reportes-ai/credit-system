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

// Todas las páginas de un endpoint paginado ({page,totalPages,data}).
// La página 1 revela totalPages; el resto se trae EN PARALELO (lotes de 6)
// porque la API es lenta (~20 registros/página) y en serie tarda minutos.
async function getTodas(path, params = {}) {
  const p1 = await get(path, { ...params, page: 1 });
  const out = [...(p1.data || [])];
  const total = Math.min(Number(p1.totalPages) || 1, 100);
  for (let desde = 2; desde <= total; desde += 6) {
    const lote = [];
    for (let p = desde; p < desde + 6 && p <= total; p++) lote.push(get(path, { ...params, page: p }));
    (await Promise.all(lote)).forEach(j => out.push(...(j.data || [])));
  }
  return out;
}

// Marcaciones entre dos fechas (yyyy-MM-dd, inclusive)
const marcaciones = (start, end) => getTodas('attendanceData', { start, end });

// Trabajadores registrados en Workera
const trabajadores = () => getTodas('employee');

// Horarios/turnos asignados por trabajador y día (workshift/schedules)
const horarios = (start, end) => getTodas('workshift/schedules', { start, end });

const configurado = () => !!(process.env.WORKERA_API_USER && process.env.WORKERA_API_KEY);

module.exports = { marcaciones, trabajadores, horarios, configurado };
