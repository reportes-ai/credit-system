// Formato numérico chileno: punto miles, coma decimal
// "1.234.567,89" ↔ 1234567.89

function parseCL(str) {
  if (str === null || str === undefined || str === '') return NaN;
  // Elimina puntos de miles, reemplaza coma decimal por punto
  return parseFloat(String(str).replace(/\./g, '').replace(',', '.'));
}

function formatCL(num, decimals = 2) {
  if (num === null || num === undefined || num === '' || isNaN(Number(num))) return '';
  return Number(num).toLocaleString('es-CL', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatCLInt(num) {
  if (num === null || num === undefined || num === '') return '';
  return Math.round(Number(num)).toLocaleString('es-CL');
}

// Aplica formato chileno a un input:
// - focus: deja el valor limpio para editar (coma decimal, sin puntos)
// - blur:  formatea con puntos de miles y coma decimal
function setupCLInput(el, decimals = 2) {
  el.addEventListener('focus', () => {
    const val = parseCL(el.value);
    if (!isNaN(val)) el.value = val.toFixed(decimals).replace('.', ',');
  });
  el.addEventListener('blur', () => {
    const val = parseCL(el.value);
    if (!isNaN(val)) el.value = formatCL(val, decimals);
  });
}
