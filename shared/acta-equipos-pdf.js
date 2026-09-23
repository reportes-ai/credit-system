'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   Acta de Recepción / Devolución de Equipos en PDF — motor único (Máxima 1).
   El texto vive en rh_config (acta_eq_*) y se edita en Entrega de Equipos →
   pestaña "Texto del acta". Aquí solo se dibuja; nunca se hardcodea el texto.
   ═══════════════════════════════════════════════════════════════════════════ */
const PDFDocument = require('pdfkit');

const AZUL = '#0141A2', AZUL_OSC = '#012d70', GRIS = '#6b7280', NEGRO = '#111827', LINEA = '#e5e7eb';
const tpl = (t, vars) => String(t || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));

/* generarActaEquiposPDF({ textos, vars, equipo, accion }) → Promise<Buffer>
   textos: { titulo, intro, importante, telefonos, firma_empresa }  (ya elegidos según ENTREGA/DEVOLUCION)
   vars:   { nombre, rut, empresa, rut_empresa, fecha, ... } para los {marcadores}
   equipo: { tipo_label, marca, modelo, serie, numero_linea, descripcion } */
function generarActaEquiposPDF({ textos = {}, vars = {}, equipo = {}, accion = 'ENTREGA' }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, left: 70, right: 70, bottom: 54 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const X = doc.page.margins.left, W = doc.page.width - X * 2;

    doc.rect(0, 0, doc.page.width, 6).fill(AZUL);
    try {
      const logo = require('path').join(__dirname, '..', 'api-gateway', 'public', 'img', 'logo.png');
      if (require('fs').existsSync(logo)) doc.image(logo, X, 26, { height: 26 });
    } catch (_) {}
    doc.fillColor(AZUL_OSC).font('Helvetica-Bold').fontSize(18).text(tpl(textos.titulo, vars).toUpperCase(), X, 70, { width: W, align: 'center' });
    doc.moveDown(1.4);

    doc.fillColor(NEGRO).font('Helvetica').fontSize(11).text(tpl(textos.intro, vars), X, doc.y, { width: W, align: 'justify', lineGap: 3 });
    doc.moveDown(1);

    // Recuadro del equipo
    const filas = [['Equipo', equipo.tipo_label], ['Marca', equipo.marca], ['Modelo', equipo.modelo], ['Serie', equipo.serie]];
    if (equipo.numero_linea) filas.push(['Línea', equipo.numero_linea]);
    if (equipo.descripcion) filas.push(['Descripción', equipo.descripcion]);
    const y0 = doc.y, h = filas.length * 20 + 14;
    doc.rect(X, y0, W, h).fill('#f8fafc').strokeColor(LINEA).lineWidth(0.7).stroke();
    let y = y0 + 9;
    for (const [k, v] of filas) {
      doc.fillColor(GRIS).font('Helvetica').fontSize(10).text(k + ':', X + 14, y, { width: 110 });
      doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(10).text(String(v || '—'), X + 124, y, { width: W - 140 });
      y += 20;
    }
    doc.y = y0 + h + 16;

    if (textos.importante) {
      doc.fillColor(AZUL_OSC).font('Helvetica-Bold').fontSize(11).text('Importante:', X, doc.y, { width: W });
      doc.moveDown(0.3);
      doc.fillColor(NEGRO).font('Helvetica').fontSize(10).text(tpl(textos.importante, vars), X, doc.y, { width: W, align: 'justify', lineGap: 2 });
      doc.moveDown(0.8);
    }
    if (textos.telefonos && (equipo.tipo === 'CELULAR' || accion === 'ENTREGA')) {
      doc.fillColor(NEGRO).font('Helvetica').fontSize(10).text(tpl(textos.telefonos, vars), X, doc.y, { width: W, align: 'justify', lineGap: 2 });
      doc.moveDown(0.8);
    }
    doc.fillColor(NEGRO).font('Helvetica-Bold').fontSize(10.5).text(`Fecha de ${accion === 'DEVOLUCION' ? 'Devolución' : 'Recepción'}: ${vars.fecha || ''}`, X, doc.y, { width: W });

    // Firmas (dos columnas)
    const yf = Math.max(doc.y + 80, doc.page.height - 200);
    const colW = (W - 40) / 2;
    const firma = (x, lineas) => {
      doc.moveTo(x, yf).lineTo(x + colW, yf).strokeColor(NEGRO).lineWidth(0.8).stroke();
      let yy = yf + 6;
      lineas.forEach((l, i) => { doc.fillColor(NEGRO).font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).text(l || '', x, yy, { width: colW, align: 'center' }); yy += 13; });
    };
    firma(X, [vars.nombre, `RUT: ${vars.rut || ''}`, accion === 'DEVOLUCION' ? 'Entrega (trabajador)' : 'Recibe conforme (trabajador)']);
    firma(X + colW + 40, [vars.empresa, textos.firma_empresa || '', accion === 'DEVOLUCION' ? 'Recibe (empresa)' : 'Entrega (empresa)']);

    doc.fillColor(GRIS).font('Helvetica').fontSize(8).text('Documento generado por AutoFácil Business Suite — Recursos Humanos › Entrega de Equipos', X, doc.page.height - 70, { width: W, align: 'center' });
    doc.end();
  });
}

module.exports = { generarActaEquiposPDF, tpl };
