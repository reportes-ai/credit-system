'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   Comprobante de Pago en PDF — réplica server-side del comprobante de caja
   (api-gateway/public/js/comprobante.js). Se adjunta al correo que recibe el
   CLIENTE al aprobarse una ODP de Cuotas. Motor único: si cambia el layout,
   cambiar aquí y en comprobante.js (el de pantalla).
   ═══════════════════════════════════════════════════════════════════════════ */
const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const clp = v => '$' + Math.round(Number(v) || 0).toLocaleString('es-CL');
const fmtD = s => {
  if (!s) return '—';
  const str = typeof s === 'string' ? s : new Date(s).toISOString();
  const [y, m, d] = str.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
};

const AZUL = '#0141A2', GRIS = '#6b7280', NEGRO = '#111827', LINEA = '#e5e7eb', VERDE = '#16a34a', ROJO = '#dc2626';

/* generarComprobantePDF({ credito, pagos, trxNum, cajaNombre, horaPago }) → Promise<Buffer>
   credito: { numero_credito, nombre_cliente, rut_cliente, plazo? }
   pagos:   [{ numero_cuota, fecha_vencimiento, fecha_pago, monto_cuota,
               interes_mora, gastos_cobranza, total_pagado }] */
function generarComprobantePDF({ credito = {}, pagos = [], trxNum, cajaNombre, horaPago }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 50, left: 90, right: 90, bottom: 50 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const X = doc.page.margins.left, W = doc.page.width - X * 2;
    const p1 = pagos[0] || {};
    const isMulti = pagos.length > 1;
    const totalPagado = pagos.reduce((s, p) => s + (Number(p.total_pagado) || 0), 0);
    const hayGastos = pagos.some(p => Number(p.gastos_cobranza) > 0);
    const hayMora = pagos.some(p => Number(p.interes_mora) > 0);

    /* ── Timbre PAGADO (verde, rotado, arriba a la derecha) ── */
    doc.save();
    doc.rotate(-12, { origin: [X + W - 60, 78] });
    doc.roundedRect(X + W - 130, 52, 140, 52, 8).lineWidth(2.5).strokeColor(VERDE).stroke();
    doc.font('Helvetica-Bold').fontSize(17).fillColor(VERDE)
      .text('PAGADO', X + W - 130, 60, { width: 140, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(6.5)
      .text([cajaNombre, fmtD(p1.fecha_pago), horaPago].filter(Boolean).join('  ·  '),
        X + W - 130, 82, { width: 140, align: 'center' });
    doc.restore();

    /* ── Logo + título ── */
    try {
      const logo = path.join(__dirname, '..', 'api-gateway', 'public', 'img', 'logo.png');
      if (fs.existsSync(logo)) doc.image(logo, doc.page.width / 2 - 55, 50, { width: 110 });
    } catch (_) {}
    doc.y = 100;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(AZUL)
      .text('COMPROBANTE DE PAGO', X, doc.y, { width: W, align: 'center', characterSpacing: 1.5 });
    doc.font('Helvetica').fontSize(9).fillColor(GRIS)
      .text(trxNum ? `TRX-${String(trxNum).padStart(6, '0')}` : '', X, doc.y + 2, { width: W, align: 'center' });
    doc.y += 16;

    const hr = () => {
      doc.moveTo(X, doc.y).lineTo(X + W, doc.y).lineWidth(1.2).strokeColor(LINEA).stroke();
      doc.y += 10;
    };
    const secTitle = (t, color) => {
      doc.font('Helvetica-Bold').fontSize(7).fillColor(color || '#9ca3af')
        .text(t.toUpperCase(), X, doc.y, { characterSpacing: 1 });
      doc.y += 12;
    };
    const row = (label, val, color) => {
      const y = doc.y;
      doc.font('Helvetica').fontSize(9.5).fillColor(GRIS).text(label, X, y);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(color || NEGRO)
        .text(String(val), X, y, { width: W, align: 'right' });
      doc.y = y + 16;
    };

    /* ── Crédito ── */
    hr(); secTitle('Crédito');
    row('N° Operación', credito.numero_credito || credito.id_credito || '—');
    row('Cliente', credito.nombre_cliente || '—');
    row('RUT', credito.rut_cliente || '—');
    doc.y += 4;

    /* ── Detalle del pago ── */
    hr(); secTitle(`Detalle del Pago${isMulti ? ` (${pagos.length} cuotas)` : ''}`);
    if (!isMulti) {
      row('Cuota N°', `${p1.numero_cuota || '—'}${credito.plazo ? ' de ' + credito.plazo : ''}`);
      row('Vencimiento', fmtD(p1.fecha_vencimiento));
      row('Fecha de Pago', fmtD(p1.fecha_pago), VERDE);
      if (cajaNombre) row('Caja', cajaNombre);
      // Orden pedido por Pato (09-09-2026): cuota, interés por mora, gastos de cobranza (montos COMPLETOS,
      // antes de condonar), Total a pagar; luego las condonaciones y el Total pagado.
      const moraFull = Number(p1.interes_mora_total != null ? p1.interes_mora_total : p1.interes_mora) || 0;
      const gastosFull = Number(p1.gastos_cobranza_total != null ? p1.gastos_cobranza_total : p1.gastos_cobranza) || 0;
      row('Monto Cuota', clp(p1.monto_cuota));
      if (moraFull > 0) row('Interés por Mora', clp(moraFull));
      if (gastosFull > 0) row('Gastos de Cobranza', clp(gastosFull));
      if (moraFull > 0 || gastosFull > 0) row('Total a Pagar', clp((Number(p1.monto_cuota) || 0) + moraFull + gastosFull));
    } else {
      row('Fecha de Pago', fmtD(p1.fecha_pago), VERDE);
      if (cajaNombre) row('Caja', cajaNombre);
      doc.y += 4;
      /* Tabla multi-cuota: CUOTA · VENCIM. · CUOTA · [GTOS.] · [MORA] · TOTAL */
      const cols = [['CUOTA', 0.13, 'left'], ['VENCIM.', 0.20, 'left'], ['CUOTA', 0.19, 'right']];
      if (hayGastos) cols.push(['GTOS.', 0.14, 'right']);
      if (hayMora) cols.push(['MORA', 0.14, 'right']);
      cols.push(['TOTAL', 1 - cols.reduce((s, c) => s + c[1], 0), 'right']);
      let cx = X;
      const xs = cols.map(c => { const o = { x: cx, w: c[1] * W, al: c[2], t: c[0] }; cx += o.w; return o; });
      const hy = doc.y;
      doc.rect(X, hy, W, 16).fillColor('#f0f4f8').fill();
      xs.forEach(c => doc.font('Helvetica-Bold').fontSize(6.5).fillColor(GRIS)
        .text(c.t, c.x + 3, hy + 5, { width: c.w - 6, align: c.al }));
      doc.y = hy + 16;
      for (const p of pagos) {
        const vals = [`N°${p.numero_cuota}`, fmtD(p.fecha_vencimiento), clp(p.monto_cuota)];
        if (hayGastos) vals.push(Number(p.gastos_cobranza) > 0 ? clp(p.gastos_cobranza) : '—');
        if (hayMora) vals.push(Number(p.interes_mora) > 0 ? clp(p.interes_mora) : '—');
        vals.push(clp(p.total_pagado));
        const y = doc.y;
        xs.forEach((c, i) => {
          const esTotal = i === xs.length - 1, esPrimera = i === 0;
          doc.font(esTotal || esPrimera ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
            .fillColor(esTotal || esPrimera ? AZUL : (vals[i] === '—' ? '#9ca3af' : NEGRO))
            .text(vals[i], c.x + 3, y, { width: c.w - 6, align: c.al });
        });
        doc.y = y + 15;
        doc.moveTo(X, doc.y - 3).lineTo(X + W, doc.y - 3).lineWidth(0.5).strokeColor('#f1f5f9').stroke();
      }
    }
    doc.y += 6;

    /* ── Condonación otorgada (si vienen los montos full antes de condonar) ── */
    const sumK = k => pagos.reduce((s, p) => s + (Number(p[k]) || 0), 0);
    const condMora = Math.max(0, Math.round(pagos.reduce((s, p) =>
      s + (Number(p.interes_mora_total != null ? p.interes_mora_total : p.interes_mora) || 0), 0) - sumK('interes_mora')));
    const condGastos = Math.max(0, Math.round(pagos.reduce((s, p) =>
      s + (Number(p.gastos_cobranza_total != null ? p.gastos_cobranza_total : p.gastos_cobranza) || 0), 0) - sumK('gastos_cobranza')));
    if (condMora + condGastos > 0) {
      if (isMulti) row('Total a Pagar', clp(Number(totalPagado) + condMora + condGastos));
      hr(); secTitle('Condonación Otorgada', '#15803d');
      if (condMora > 0) row('Condonación Interés por Mora', '-' + clp(condMora), '#15803d');
      if (condGastos > 0) row('Condonación Gastos de Cobranza', '-' + clp(condGastos), '#15803d');
      doc.y += 4;
    }

    /* ── Total ── */
    const yBox = doc.y;   // ambas líneas se posicionan desde el MISMO origen (antes doc.y ya había avanzado tras el rótulo)
    doc.roundedRect(X, yBox, W, 40, 8).fillColor(AZUL).fill();
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#ffffff')
      .text(`TOTAL PAGADO${isMulti ? ` (${pagos.length} CUOTAS)` : ''}`, X + 16, yBox + 16, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#ffffff')
      .text(clp(totalPagado), X, yBox + 12, { width: W - 16, align: 'right', lineBreak: false });
    doc.y = yBox + 40 + 10;

    /* ── Pie ── */
    doc.moveTo(X, doc.y).lineTo(X + W, doc.y).lineWidth(0.8).strokeColor(LINEA).dash(2, { space: 2 }).stroke().undash();
    doc.font('Helvetica').fontSize(7.5).fillColor('#9ca3af')
      .text('AutoFácil Crédito Automotriz   ·   Documento no válido como boleta o factura',
        X, doc.y + 8, { width: W, align: 'center' });

    doc.end();
  });
}

module.exports = { generarComprobantePDF };
