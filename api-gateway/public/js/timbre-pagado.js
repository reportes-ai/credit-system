/**
 * timbre-pagado.js — Timbre "PAGADO" reutilizable (estilo sello de goma).
 * Se usa en el documento de Órdenes de Pago y en el comprobante de cuotas.
 *
 *   window.timbrePagado({ caja, fecha, hora, color }) → string HTML autocontenido.
 *     caja  : nombre o número de la caja (se muestra como "CAJA N° X")
 *     fecha : fecha del pago (texto ya formateado, ej. 23-06-2026)
 *     hora  : hora del pago HH:MM:SS
 *     color : color de la tinta (por defecto verde #15803d)
 */
window.timbrePagado = function (o) {
  o = o || {};
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = o.color || '#15803d';
  // "Caja 2" → "2"; "Principal" → "Principal" (evita "CAJA N° Caja 2").
  const cajaTxt = String(o.caja || '').replace(/^caja\s*N?°?\s*/i, '').trim();
  const fecha = esc(String(o.fecha || '').replace(/-/g, '/'));   // dd/mm/AAAA
  const hora = esc(o.hora || '');
  return `<div style="display:inline-block;transform:rotate(-13deg);border:3px double ${col};color:${col};border-radius:10px;padding:5px 16px 7px;text-align:center;font-family:Arial,Helvetica,sans-serif;opacity:.85;line-height:1.18;background:transparent">
    <div style="font-size:22px;font-weight:900;letter-spacing:3px">PAGADO</div>
    ${cajaTxt ? `<div style="font-size:10px;font-weight:800;letter-spacing:.4px;margin-top:2px">CAJA N° ${esc(cajaTxt)}</div>` : ''}
    ${fecha ? `<div style="font-size:10px;font-weight:700">${fecha}</div>` : ''}
    ${hora ? `<div style="font-size:10px;font-weight:700">${hora}</div>` : ''}
  </div>`;
};
