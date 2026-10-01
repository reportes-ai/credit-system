/* ═══════════════════════════════════════════════════════════════
   📗 EXPORTAR UNA TABLA HTML CON NÚMEROS EN FORMATO CHILENO A .xlsx — motor único (30-09-2026).
   SheetJS (`table_to_book` / `table_to_sheet`) "adivina" los números leyendo el texto de la celda con la
   coma y el punto al revés: "850.000" → 850, "1.234,50" → 1,2345, "-3.500" → -3,5 y "1.234.567" queda
   como texto. Así salieron el Presupuesto y el Directorio la semana del 28-09.
   Acá la tabla se lee cruda (raw: todo texto) y cada celda que es un número es-CL se convierte de verdad:
     "1.234.567" → 1234567 · "-3.500" → -3500 · "$ 12.345" → 12345 · "1.234,50" → 1234.5 · "12,5%" → 0.125 (formato %)
   Lo que no es un número es-CL (RUT, fechas, texto) se deja como texto. Requiere /js/xlsx.full.min.js.
   Uso:  const wb = AF_XLSX.libroDeTabla(tablaEl, 'Nombre hoja');  XLSX.writeFile(wb, 'archivo.xlsx');

   FILAS ARMADAS EN JS (01-10-2026): los DECIMAL de la base llegan como TEXTO ("850000", "1234.50") y
   `aoa_to_sheet` los escribía como celdas de texto: en Excel no suman. `hojaDeFilas` / `libroDeFilas`
   convierten esos textos en números (miles con punto en Excel). La primera fila es el encabezado; las
   columnas cuyo encabezado se pase en `texto` se dejan como texto (N° de documento, cuenta contable).
   Uso:  const wb = AF_XLSX.libroDeFilas(filas, 'Auxiliar', ['N° Doc', 'Cta Gasto']);

   FECHAS (01-10-2026): `fechasEnHoja(ws, { 'Fecha Otorgado': 'D', 'Creado': 'DT' })` convierte las celdas de texto
   'AAAA-MM-DD' ('D') o 'AAAA-MM-DD HH:MM[:SS]' ('DT') de esas columnas en fechas de Excel (se pueden ordenar y
   filtrar), con formato dd-mm-aaaa. Se escribe el número de serie directo: sin objetos Date, sin zona horaria.
   ═══════════════════════════════════════════════════════════════ */
window.AF_XLSX = (function () {
  /* "1.234,50" → { v: 1234.5, z: '#,##0.00' } · "12,5%" → { v: 0.125, z: '0.0%' } · lo demás → null */
  function numeroEsCL(txt) {
    let s = String(txt == null ? '' : txt).replace(/ /g, ' ').trim();
    if (!s) return null;
    const pct = s.endsWith('%'); if (pct) s = s.slice(0, -1).trim();
    let neg = false;
    if (s.startsWith('-') || s.startsWith('−')) { neg = true; s = s.slice(1).trim(); }
    if (s.startsWith('$')) s = s.slice(1).trim();
    if (s.startsWith('-') || s.startsWith('−')) { neg = !neg; s = s.slice(1).trim(); }
    if (!/^\d{1,3}(\.\d{3})+(,\d+)?$|^\d+(,\d+)?$/.test(s)) return null;
    const v = Number(s.replace(/\./g, '').replace(',', '.'));
    if (!Number.isFinite(v)) return null;
    const n = neg ? -v : v;
    if (pct) return { v: n / 100, z: '0.0%' };
    // Un entero escrito sin separador ("2026", "45") se deja sin miles: puede ser un año o un conteo
    return { v: n, z: Number.isInteger(n) ? (s.includes('.') ? '#,##0' : '0') : '#,##0.00' };
  }
  /* Recorre una hoja ya leída en crudo y convierte las celdas de texto que son números es-CL */
  function convertirCeldas(ws) {
    if (!ws || !ws['!ref']) return ws;
    const r = XLSX.utils.decode_range(ws['!ref']);
    for (let R = r.s.r; R <= r.e.r; R++) for (let C = r.s.c; C <= r.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (!cell || cell.t !== 's') continue;
      const n = numeroEsCL(cell.v);
      if (n) { cell.t = 'n'; cell.v = n.v; cell.z = n.z; delete cell.w; }
    }
    return ws;
  }
  function hojaDeTabla(tabla, opts) { return convertirCeldas(XLSX.utils.table_to_sheet(tabla, Object.assign({ raw: true }, opts || {}))); }
  function libroDeTabla(tabla, nombreHoja, opts) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, hojaDeTabla(tabla, opts), String(nombreHoja || 'Datos').replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 31) || 'Datos');
    return wb;
  }
  /* "1234.50" | "-850000" | 1234.5 → número con formato; "007", "2026-09", RUT, texto → null (se deja igual).
     Sin ceros a la izquierda (son códigos) y hasta 15 dígitos (más allá Excel pierde precisión). */
  function numeroDeBD(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string' || !/^-?(0|[1-9]\d{0,14})(\.\d+)?$/.test(v)) return null;
    const n = Number(v); return Number.isFinite(n) ? n : null;
  }
  function hojaDeFilas(filas, texto) {
    const ws = XLSX.utils.aoa_to_sheet(filas);
    if (!ws['!ref']) return ws;
    const noTocar = new Set((texto || []).map(t => String(t)));
    const r = XLSX.utils.decode_range(ws['!ref']);
    const esTexto = [];
    for (let C = r.s.c; C <= r.e.c; C++) { const h = ws[XLSX.utils.encode_cell({ r: r.s.r, c: C })]; esTexto[C] = !!(h && noTocar.has(String(h.v))); }
    for (let R = r.s.r + 1; R <= r.e.r; R++) for (let C = r.s.c; C <= r.e.c; C++) {
      const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
      if (!cell) continue;
      if (esTexto[C]) { if (cell.t === 'n') { cell.t = 's'; cell.v = String(cell.v); delete cell.w; } continue; }
      const n = numeroDeBD(cell.v);
      if (n == null) continue;
      cell.t = 'n'; cell.v = n; cell.z = Number.isInteger(n) ? '#,##0' : '#,##0.00'; delete cell.w;
    }
    return ws;
  }
  function libroDeFilas(filas, nombreHoja, texto) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, hojaDeFilas(filas, texto), String(nombreHoja || 'Datos').replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 31) || 'Datos');
    return wb;
  }
  /* 'AAAA-MM-DD[ HH:MM[:SS]]' → número de serie de Excel (días desde el 30-12-1899); otra cosa → null */
  function serialExcel(txt) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(txt == null ? '' : txt));
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3], ms = Date.UTC(y, mo - 1, d);
    const x = new Date(ms);
    if (y < 1900 || x.getUTCFullYear() !== y || x.getUTCMonth() !== mo - 1 || x.getUTCDate() !== d) return null;   // 0000-00-00, 2026-02-31
    return ms / 86400000 + 25569 + ((+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) / 86400;
  }
  function fechasEnHoja(ws, mapa) {
    if (!ws || !ws['!ref'] || !mapa) return ws;
    const r = XLSX.utils.decode_range(ws['!ref']);
    for (let C = r.s.c; C <= r.e.c; C++) {
      const h = ws[XLSX.utils.encode_cell({ r: r.s.r, c: C })];
      const tipo = h && mapa[String(h.v)];
      if (!tipo) continue;
      for (let R = r.s.r + 1; R <= r.e.r; R++) {
        const cell = ws[XLSX.utils.encode_cell({ r: R, c: C })];
        if (!cell || cell.t !== 's') continue;
        const n = serialExcel(cell.v);
        if (n == null) continue;
        cell.t = 'n'; cell.v = n; cell.z = tipo === 'DT' ? 'dd-mm-yyyy hh:mm' : 'dd-mm-yyyy'; delete cell.w;
      }
    }
    return ws;
  }
  return { numeroEsCL, convertirCeldas, hojaDeTabla, libroDeTabla, numeroDeBD, hojaDeFilas, libroDeFilas, serialExcel, fechasEnHoja };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = window.AF_XLSX;   // pruebas en Node
