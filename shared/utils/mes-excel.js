'use strict';
/* ── Motor único: parsea la columna MES de Excel → 'YYYY-MM-01', y calcula el
   último día de ese mes. Acepta: número de serie de Excel (45658), objeto Date,
   y texto ("may-26", "mayo 2026", "2026-05", "05/2026"). Usado por carga-masiva
   y carga-trinidad cuando la fecha real (FECHA OTORGADO/CURSE) no es confiable
   (ej. INDEXA fuerza "hoy" y el período contable REAL solo consta en MES). */
const XLSX = require('xlsx');
const MESES_ABBR = { ene:1,jan:1, feb:2, mar:3, abr:4,apr:4, may:5, jun:6,
  jul:7, ago:8,aug:8, sep:9,set:9, oct:10, nov:11, dic:12,dec:12 };

// Serial de fecha de Excel → 'YYYY-MM-01' (rango típico 2009-2064 = 40000-60000).
function serialAMes(n) {
  if (typeof n !== 'number' || n < 20000 || n > 90000) return null;
  const d = XLSX.SSF.parse_date_code(n);
  return d ? `${d.y}-${String(d.m).padStart(2,'0')}-01` : null;
}

function parseMesTxt(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}-01`;
  if (typeof v === 'number') return serialAMes(v);   // celda de fecha leída con cellDates:false
  const s = String(v).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // Texto que es un serial de Excel puro ("45658")
  if (/^\d{5}$/.test(s)) { const r = serialAMes(parseInt(s)); if (r) return r; }
  let m = s.match(/^([a-z]{3,})[\s\-\/.]+(\d{2,4})$/);   // "may-26" / "mayo 2026"
  if (m) {
    const mon = MESES_ABBR[m[1].slice(0, 3)];
    if (!mon) return null;
    let yr = parseInt(m[2]); if (yr < 100) yr += 2000;
    return `${yr}-${String(mon).padStart(2,'0')}-01`;
  }
  m = s.match(/^(\d{4})[\-\/](\d{1,2})$/);               // "2026-05"
  if (m) return `${m[1]}-${String(+m[2]).padStart(2,'0')}-01`;
  m = s.match(/^(\d{1,2})[\-\/](\d{4})$/);               // "05/2026"
  if (m) return `${m[2]}-${String(+m[1]).padStart(2,'0')}-01`;
  return null;
}

/* Último día del mes 'YYYY-MM' o 'YYYY-MM-01' → 'YYYY-MM-DD' */
function finDeMes(mesStr) {
  if (!mesStr) return null;
  const [y, m] = mesStr.slice(0, 7).split('-').map(Number);
  const d = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}

module.exports = { parseMesTxt, finDeMes };
