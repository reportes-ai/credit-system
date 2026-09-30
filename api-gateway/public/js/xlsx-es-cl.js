/* ═══════════════════════════════════════════════════════════════
   📗 EXPORTAR UNA TABLA HTML CON NÚMEROS EN FORMATO CHILENO A .xlsx — motor único (30-09-2026).
   SheetJS (`table_to_book` / `table_to_sheet`) "adivina" los números leyendo el texto de la celda con la
   coma y el punto al revés: "850.000" → 850, "1.234,50" → 1,2345, "-3.500" → -3,5 y "1.234.567" queda
   como texto. Así salieron el Presupuesto y el Directorio la semana del 28-09.
   Acá la tabla se lee cruda (raw: todo texto) y cada celda que es un número es-CL se convierte de verdad:
     "1.234.567" → 1234567 · "-3.500" → -3500 · "$ 12.345" → 12345 · "1.234,50" → 1234.5 · "12,5%" → 0.125 (formato %)
   Lo que no es un número es-CL (RUT, fechas, texto) se deja como texto. Requiere /js/xlsx.full.min.js.
   Uso:  const wb = AF_XLSX.libroDeTabla(tablaEl, 'Nombre hoja');  XLSX.writeFile(wb, 'archivo.xlsx');
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
  return { numeroEsCL, convertirCeldas, hojaDeTabla, libroDeTabla };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = window.AF_XLSX;   // pruebas en Node
