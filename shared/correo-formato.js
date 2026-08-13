'use strict';
/* Formato de los correos con plantilla — módulo PURO (sin BD), para poder
   probarlo solo. Lo usa shared/plantillas-correo.js.

   El cuerpo se escribe en TEXTO PLANO en el mantenedor: quien edita un correo
   quiere cambiar una frase, no pelear con etiquetas. El motor le da el formato
   al enviar. Si alguien pega HTML de verdad, se respeta tal cual. */

const esHTML = t => /<(p|div|table|br|h[1-6]|ul|ol|strong|b|span)\b/i.test(String(t || ''));

/* Una línea de monto es "Etiqueta: $1.234" — lo que en el correo se lee mucho
   mejor como fila de tabla que como texto corrido. Se exige el signo $ para no
   convertir por error frases que terminan en dos puntos ("Favor emitir a:"). */
const RE_MONTO = /^(.+?):\s*(\$[\d.,]+)$/;

const filaHTML = (etiqueta, monto) => {
  const total = /^total\b/i.test(etiqueta.trim());
  const td = 'padding:8px 12px;border-bottom:1px solid #e2e8f0' + (total ? ';font-weight:700;background:#f1f5f9;color:#012d70' : '');
  return `<tr><td style="${td}">${etiqueta}</td><td style="${td};text-align:right;white-space:nowrap">${monto}</td></tr>`;
};

const tablaHTML = filas =>
  '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;margin:0 0 14px;min-width:60%">' +
  '<tr><th style="background:#012d70;color:#fff;text-align:left;padding:8px 12px;font-size:.9em">Concepto</th>' +
  '<th style="background:#012d70;color:#fff;text-align:right;padding:8px 12px;font-size:.9em">Monto</th></tr>' +
  filas.join('') + '</table>';

/* Línea en blanco = párrafo nuevo (con aire); salto simple = salto de línea;
   dos o más líneas de monto seguidas = tabla. Sin esto el correo llega como un
   solo bloque de texto pegado e ilegible. */
function aHTML(t) {
  if (esHTML(t)) return String(t);
  const esc = String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(bloque => {
    const lineas = bloque.split('\n');
    const montos = lineas.map(l => l.match(RE_MONTO));
    // El bloque es una tabla solo si TODAS sus líneas son montos y hay al menos dos
    if (montos.length >= 2 && montos.every(Boolean))
      return tablaHTML(montos.map(m => filaHTML(m[1], m[2])));
    return '<p style="margin:0 0 12px">' + lineas.join('<br>') + '</p>';
  }).join('');
}

/* Reemplaza {VARIABLE} por su valor. Acepta {MAYUSCULAS} y {minusculas} (las
   plantillas de dealer usan minúscula). Una variable sin dato queda VACÍA,
   nunca "{VARIABLE}" a la vista de quien recibe el correo. */
const render = (texto, datos = {}) =>
  String(texto || '').replace(/\{(\w+)\}/g, (_, k) =>
    (datos[k] != null ? String(datos[k])
      : datos[k.toUpperCase()] != null ? String(datos[k.toUpperCase()])
      : datos[k.toLowerCase()] != null ? String(datos[k.toLowerCase()]) : ''));

module.exports = { esHTML, aHTML, render };
