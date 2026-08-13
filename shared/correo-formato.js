'use strict';
/* Formato de los correos con plantilla — módulo PURO (sin BD), para poder
   probarlo solo. Lo usa shared/plantillas-correo.js.

   El cuerpo se escribe en TEXTO PLANO en el mantenedor: quien edita un correo
   quiere cambiar una frase, no pelear con etiquetas. El motor le da el formato
   al enviar. Si alguien pega HTML de verdad, se respeta tal cual. */

const esHTML = t => /<(p|div|table|br|h[1-6]|ul|ol|strong|b|span)\b/i.test(String(t || ''));

/* Línea en blanco = párrafo nuevo (con aire); salto simple = salto de línea.
   Sin esto el correo llega como un solo bloque de texto pegado e ilegible. */
function aHTML(t) {
  if (esHTML(t)) return String(t);
  const esc = String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    .map(p => '<p style="margin:0 0 12px">' + p.replace(/\n/g, '<br>') + '</p>').join('');
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
