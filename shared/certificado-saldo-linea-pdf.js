'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   Certificado de Saldo Insoluto de una línea de crédito rotativa — motor único.
   Cláusula Cuarta del Contrato de Apertura de Línea de Crédito (UCA): cada vez
   que un saldo de precio se compensa contra el capital de la línea, AutoFácil
   emite este certificado con el saldo insoluto resultante, dentro de 2 días
   hábiles bancarios del Aviso de Cierre de Negocio.
   Se arma SIEMPRE desde el snapshot congelado en documentos_verificables, así
   que reenviarlo produce exactamente el mismo documento.
   ═══════════════════════════════════════════════════════════════════════════ */
const PDFDocument = require('pdfkit');

const AZUL = '#0141A2', AZUL_OSC = '#012d70', GRIS = '#6b7280', NEGRO = '#111827', LINEA = '#e5e7eb';
const clp = v => '$' + Math.round(Number(v) || 0).toLocaleString('es-CL');
const rutPuntos = r => { const m = String(r || '').replace(/\./g, '').match(/^(\d+)-?([\dkK])$/); return m ? m[1].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + m[2].toUpperCase() : (r || '—'); };
const fmtD = s => { if (!s) return '—'; const [y, m, d] = String(s).slice(0, 10).split('-'); return `${d}-${m}-${y}`; };

/* generarCertificadoSaldoLineaPDF({ d, codigo, host }) → Promise<Buffer>
   d = snapshot (ver linea-credito.controller → datosCertificado) */
function generarCertificadoSaldoLineaPDF({ d = {}, codigo, host }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, left: 70, right: 70, bottom: 54 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const X = doc.page.margins.left, W = doc.page.width - X * 2;
    const deu = d.deudor || {}, acr = d.acreedor || {}, op = d.operacion || {}, li = d.linea || {};

    doc.rect(0, 0, doc.page.width, 6).fill(AZUL);
    try {
      const logo = require('path').join(__dirname, '..', 'api-gateway', 'public', 'img', 'logo.png');
      if (require('fs').existsSync(logo)) doc.image(logo, X, 26, { height: 26 });
    } catch (_) {}
    doc.fillColor(AZUL_OSC).font('Helvetica-Bold').fontSize(17)
      .text('CERTIFICADO DE SALDO INSOLUTO', X, 66, { width: W, align: 'center' });
    doc.fillColor(GRIS).font('Helvetica').fontSize(9.5)
      .text(`N° ${d.numero_txt || '—'}   ·   Santiago, ${fmtD(d.fecha_emision)}`, { width: W, align: 'center' });
    doc.moveDown(1.2);

    // Textos paramétricos (pestaña Parámetros), congelados ya resueltos en el snapshot.
    doc.fillColor(NEGRO).font('Helvetica').fontSize(9.5).text(d.texto_intro || '', X, doc.y, { width: W, align: 'justify', lineGap: 2 });
    doc.moveDown(1);

    const sec = t => {
      doc.moveDown(0.3);
      doc.fillColor(AZUL).font('Helvetica-Bold').fontSize(8).text(t.toUpperCase(), X, doc.y, { characterSpacing: 1 });
      doc.moveDown(0.35);
    };
    const fila = (k, v, fuerte) => {
      const y = doc.y;
      doc.fillColor(GRIS).font('Helvetica').fontSize(9.5).text(k, X, y, { width: 250 });
      const hK = doc.y - y;
      doc.fillColor(fuerte ? AZUL_OSC : NEGRO).font('Helvetica-Bold').fontSize(fuerte ? 11 : 9.5)
        .text(String(v ?? '—'), X + 255, y, { width: W - 255, align: 'right' });
      doc.y = Math.max(doc.y, y + hK, y + 14);
      doc.moveTo(X, doc.y + 2).lineTo(X + W, doc.y + 2).strokeColor(LINEA).lineWidth(0.5).stroke();
      doc.y += 7;
    };

    sec('Operación (Aviso de Cierre de Negocio)');
    fila('N° de operación AutoFácil', op.num_op);
    if (op.id_financiera) fila('N° de operación UCA', op.id_financiera);
    fila('Cliente', op.cliente);
    fila('RUT cliente', rutPuntos(op.rut));
    fila('Fecha de otorgamiento (Fecha de la Compensación)', fmtD(op.fecha_otorgado));

    sec('Compensación');
    fila('Saldo insoluto anterior', clp(d.saldo_anterior));
    fila('Saldo de precio de la operación', clp(d.saldo_precio));
    fila('Monto compensado contra el capital', clp(d.compensado));
    if (Number(d.exceso) > 0) fila('Exceso a pagar por UCA (Convenio Comercial)', clp(d.exceso));
    fila('SALDO INSOLUTO DE LA LÍNEA', clp(d.saldo_nuevo), true);

    sec('Estado de la línea');
    fila('Monto máximo de la línea', clp(li.limite));
    fila('Cupo disponible, aceptado este certificado', clp(li.disponible));
    fila('Utilización de la línea', `${(Number(li.uso_pct) || 0).toLocaleString('es-CL', { maximumFractionDigits: 1 })}%`);
    if (li.vencimiento) fila('Fecha de Vencimiento', fmtD(li.vencimiento));

    doc.moveDown(0.8);
    doc.fillColor(GRIS).font('Helvetica').fontSize(8.5).text(d.texto_cierre || '', X, doc.y, { width: W, align: 'justify', lineGap: 1.5 });

    // Firma
    doc.moveDown(2.2);
    const yF = doc.y;
    doc.moveTo(X + W / 2 - 110, yF).lineTo(X + W / 2 + 110, yF).strokeColor('#9ca3af').lineWidth(0.7).stroke();
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(9.5).text(d.firmante_nombre || '—', X, yF + 5, { width: W, align: 'center' });
    doc.fillColor(GRIS).font('Helvetica').fontSize(8.5)
      .text([d.firmante_cargo, `pp. ${deu.razon_social || ''}`].filter(Boolean).join(' · '), X, doc.y, { width: W, align: 'center' });

    // QR de verificación (mismo motor de las cartas y comprobantes)
    const urlVerif = `${host || 'https://afbs.autofacilchile.cl'}/verificar/${codigo || ''}`;
    doc.moveDown(1);
    try {
      const qrGen = require('../api-gateway/public/js/qrcode-generator.js');
      const q = qrGen(0, 'M'); q.addData(urlVerif); q.make();
      const n = q.getModuleCount(), cell = 64 / n, qx = X + W / 2 - 32, qy = doc.y + 4;
      doc.fillColor('#000000');
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
        if (q.isDark(r, c)) doc.rect(qx + c * cell, qy + r * cell, cell + 0.2, cell + 0.2).fill();
      doc.y = qy + 70;
    } catch (_) { /* sin QR: queda la URL en texto */ }
    doc.fillColor(GRIS).font('Helvetica').fontSize(7.5).text(
      `Documento generado automáticamente por AutoFácil Business Suite. Folio verificable ${codigo || '—'}: ${urlVerif}`,
      X, doc.y, { width: W, align: 'center' });

    doc.end();
  });
}

module.exports = { generarCertificadoSaldoLineaPDF };
