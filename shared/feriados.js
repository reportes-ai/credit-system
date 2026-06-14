'use strict';
const pool = require('./config/database');

/* ── Feriados chilenos (parametrizable) ──────────────────────────────────────
   Tabla `feriados` editable por el negocio (mantenedor candidato). Se siembra
   automáticamente con los feriados legales de Chile para el rango de años
   relevante. Incluye los móviles (Viernes/Sábado Santo) calculados vía Pascua.
   Los "movibles a lunes" (San Pedro, Encuentro Dos Mundos) se siembran en su
   fecha nominal — el Administrador puede ajustarlos en la tabla si difieren. */

const FIJOS = [
  ['01-01', 'Año Nuevo'],
  ['05-01', 'Día del Trabajo'],
  ['05-21', 'Día de las Glorias Navales'],
  ['06-20', 'Día Nacional de los Pueblos Indígenas'],
  ['06-29', 'San Pedro y San Pablo'],
  ['07-16', 'Virgen del Carmen'],
  ['08-15', 'Asunción de la Virgen'],
  ['09-18', 'Independencia Nacional'],
  ['09-19', 'Día de las Glorias del Ejército'],
  ['10-12', 'Encuentro de Dos Mundos'],
  ['10-31', 'Día de las Iglesias Evangélicas y Protestantes'],
  ['11-01', 'Día de Todos los Santos'],
  ['12-08', 'Inmaculada Concepción'],
  ['12-25', 'Navidad'],
];

const fmt = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

// Domingo de Pascua (algoritmo Gregoriano anónimo / Meeus)
function pascua(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4,
        f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3),
        h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
        l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451),
        mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, mes - 1, dia);
}

function feriadosDeAnio(y) {
  const out = FIJOS.map(([md, nombre]) => [`${y}-${md}`, nombre]);
  const p = pascua(y);
  const vs = new Date(p); vs.setDate(p.getDate() - 2);
  const ss = new Date(p); ss.setDate(p.getDate() - 1);
  out.push([fmt(vs), 'Viernes Santo'], [fmt(ss), 'Sábado Santo']);
  return out;
}

let _set = new Set();   // cache en memoria: 'YYYY-MM-DD'

async function migrarYsembrar() {
  await pool.query(`CREATE TABLE IF NOT EXISTS feriados (
    fecha  DATE PRIMARY KEY,
    nombre VARCHAR(120) NOT NULL,
    pais   VARCHAR(2) NOT NULL DEFAULT 'CL'
  )`);
  const hoy = new Date().getFullYear();
  for (let y = hoy - 1; y <= hoy + 2; y++) {
    for (const [fecha, nombre] of feriadosDeAnio(y)) {
      await pool.query('INSERT IGNORE INTO feriados (fecha, nombre) VALUES (?,?)', [fecha, nombre]);
    }
  }
}

async function cargar() {
  try {
    const [rows] = await pool.query('SELECT DATE_FORMAT(fecha, "%Y-%m-%d") AS f FROM feriados');
    _set = new Set(rows.map(r => r.f));
  } catch (e) { console.error('[feriados cargar]', e.message); }
}

(async () => {
  try { await migrarYsembrar(); await cargar(); console.log('[feriados] CL cargados:', _set.size); }
  catch (e) { console.error('[feriados init]', e.message); }
})();
setInterval(cargar, 6 * 60 * 60 * 1000);   // refresca cada 6 h por si el Admin edita la tabla

const esFinde   = d => d.getDay() === 0 || d.getDay() === 6;
const esFeriado = d => _set.has(fmt(d));
const esHabil   = d => !esFinde(d) && !esFeriado(d);

// Suma N días hábiles (salta fines de semana y feriados chilenos)
function sumarDiasHabiles(fecha, n) {
  const d = new Date(fecha);
  let add = 0;
  while (add < n) { d.setDate(d.getDate() + 1); if (esHabil(d)) add++; }
  return d;
}

module.exports = { sumarDiasHabiles, esHabil, esFeriado, cargarFeriados: cargar, feriadosDeAnio };
