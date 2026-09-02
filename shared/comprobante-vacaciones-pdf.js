'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   Comprobante de Vacaciones en PDF — motor único (Máxima 1).
   Se genera al RECEPCIONAR RRHH la solicitud aprobada y se archiva en la
   carpeta digital del colaborador (rh_documentos). Certifica el flujo con las
   firmas FES registradas (trabajador al solicitar, supervisor al aprobar,
   RRHH al recepcionar) y el folio verificable (QR /verificar/<codigo>).
   ═══════════════════════════════════════════════════════════════════════════ */
const PDFDocument = require('pdfkit');

const AZUL = '#0141A2', AZUL_OSC = '#012d70', GRIS = '#6b7280', NEGRO = '#111827', LINEA = '#e5e7eb', VERDE = '#16a34a';
const fmtD = s => { if (!s) return '—'; const str = typeof s === 'string' ? s : new Date(s).toISOString(); const [y, m, d] = str.slice(0, 10).split('-'); return `${d}-${m}-${y}`; };
const fmtDT = s => { if (!s) return '—'; const d = new Date(s); return d.toLocaleString('es-CL', { timeZone: 'America/Santiago', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };

/* generarComprobanteVacacionesPDF({ solicitud, colaborador, firmas, codigo, saldo }) → Promise<Buffer>
   solicitud: { id, fecha_desde, fecha_hasta, dias, dias_habiles, comentario, resuelto_nombre }
   colaborador: { nombre, rut, cargo }
   firmas: [{ rol, nombre, cargo, fecha, hash_doc, ip }]
   codigo: folio verificable · saldo: { disponibles } (después del descuento) */
function generarComprobanteVacacionesPDF({ solicitud = {}, colaborador = {}, firmas = [], codigo, saldo }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, left: 70, right: 70, bottom: 54 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const X = doc.page.margins.left, W = doc.page.width - X * 2;

    // Encabezado con logo
    doc.rect(0, 0, doc.page.width, 6).fill(AZUL);
    try {
      // logo.png es el limpio con fondo transparente (el -bs-mail trae una tarjeta blanca con borde)
      const logo = require('path').join(__dirname, '..', 'api-gateway', 'public', 'img', 'logo.png');
      if (require('fs').existsSync(logo)) doc.image(logo, X, 26, { height: 26 });
    } catch (_) {}
    doc.fillColor(AZUL_OSC).font('Helvetica-Bold').fontSize(19).text('COMPROBANTE DE VACACIONES', X, 64, { width: W, align: 'center' });
    doc.fillColor(GRIS).font('Helvetica').fontSize(10).text('AutoFácil Crédito Automotriz — Recursos Humanos', { width: W, align: 'center' });
    doc.moveDown(0.4);
    doc.fillColor(GRIS).fontSize(9).text(`Folio verificable: ${codigo || '—'}   ·   Solicitud N° ${solicitud.id || '—'}`, { width: W, align: 'center' });
    doc.moveDown(1.2);

    // Datos
    const fila = (k, v) => {
      const y = doc.y;
      doc.fillColor(GRIS).font('Helvetica').fontSize(10).text(k, X, y, { width: 180 });
      doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(10).text(String(v ?? '—'), X + 185, y, { width: W - 185 });
      doc.moveTo(X, doc.y + 4).lineTo(X + W, doc.y + 4).strokeColor(LINEA).lineWidth(0.5).stroke();
      doc.y += 10;
    };
    fila('Colaborador', colaborador.nombre);
    fila('RUT', colaborador.rut || '—');
    fila('Cargo', colaborador.cargo || '—');
    fila('Período de vacaciones', `${fmtD(solicitud.fecha_desde)}  al  ${fmtD(solicitud.fecha_hasta)}`);
    fila('Días corridos', solicitud.dias);
    if (solicitud.dias_habiles != null) fila('Días hábiles descontados', solicitud.dias_habiles);
    if (saldo && saldo.disponibles != null) fila('Saldo disponible tras el descuento', `${saldo.disponibles} día(s) hábil(es)`);
    if (solicitud.comentario) fila('Comentario', solicitud.comentario);

    // Firmas FES
    doc.moveDown(1.2);
    doc.fillColor(AZUL_OSC).font('Helvetica-Bold').fontSize(12).text('Certificación del flujo — Firma Electrónica Simple', X, doc.y, { width: W });
    doc.moveDown(0.3);
    doc.fillColor(GRIS).font('Helvetica').fontSize(8.5).text(
      'Cada etapa quedó firmada electrónicamente en Business Suite (Ley 19.799): identidad de la sesión, fecha/hora, IP y huella SHA-256 del contenido firmado.',
      { width: W });
    doc.moveDown(0.6);
    const ROL_LBL = { TRABAJADOR: 'Solicitó (trabajador)', EMPLEADOR: 'Aprobó (jefatura/empleador)', RRHH: 'Recepcionó (Recursos Humanos)' };
    for (const f of firmas) {
      const y0 = doc.y;
      doc.rect(X, y0, W, 44).strokeColor(LINEA).lineWidth(0.7).stroke();
      doc.fillColor(VERDE).font('Helvetica-Bold').fontSize(9).text('✔ ' + (ROL_LBL[f.rol] || f.rol), X + 10, y0 + 7);
      doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(10).text(`${f.nombre || '—'}${f.cargo ? ' · ' + f.cargo : ''}`, X + 10, y0 + 19, { width: W - 20 });
      doc.fillColor(GRIS).font('Helvetica').fontSize(8)
        .text(`${fmtDT(f.fecha)}   ·   IP ${f.ip || '—'}   ·   SHA-256 ${(f.hash_doc || '').slice(0, 16)}…`, X + 10, y0 + 32, { width: W - 20 });
      doc.y = y0 + 52;
    }

    // Verificación con QR (motor qrcode-generator, el mismo de las cartas)
    doc.moveDown(1);
    const urlVerif = `https://afbs.autofacilchile.cl/verificar/${codigo || ''}`;
    try {
      const qrGen = require('../api-gateway/public/js/qrcode-generator.js');
      const q = qrGen(0, 'M'); q.addData(urlVerif); q.make();
      const n = q.getModuleCount(), cell = 76 / n, qx = X + W / 2 - 38, qy = doc.y + 6;
      doc.rect(qx - 4, qy - 4, 84, 84).fill('#ffffff').strokeColor(LINEA).lineWidth(0.7).stroke();
      doc.fillColor('#000000');
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
        if (q.isDark(r, c)) doc.rect(qx + c * cell, qy + r * cell, cell + 0.2, cell + 0.2).fill();
      doc.y = qy + 84;
    } catch (e) { /* sin QR: queda la URL en texto */ }
    doc.moveDown(0.4);
    doc.fillColor(GRIS).font('Helvetica').fontSize(8.5).text(
      `Documento generado automáticamente por AutoFácil Business Suite al recepcionar RRHH la solicitud. ` +
      `Verifique su autenticidad escaneando el código QR o en ${urlVerif}`, X, doc.y, { width: W, align: 'center' });

    doc.end();
  });
}

module.exports = { generarComprobanteVacacionesPDF };
