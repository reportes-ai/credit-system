/* ─────────────────────────────────────────────────────────────────────────
   QR de verificación reutilizable. Requiere /js/qrcode-generator.js cargado.
   El QR codifica  <origin>/verificar/<codigo>  → página pública de verificación.
     qrVerificacion(codigo, {cell,margin})  → { url, dataUrl }
     qrVerificacionHTML(codigo, {px})       → bloque HTML listo para estampar
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  function urlDe(codigo) { return location.origin + '/verificar/' + encodeURIComponent(codigo); }
  function dataUrl(codigo, opts) {
    opts = opts || {};
    try {
      if (typeof qrcode !== 'function') return '';
      const qr = qrcode(0, 'M');
      qr.addData(urlDe(codigo));
      qr.make();
      return qr.createDataURL(opts.cell || 4, opts.margin || 2);
    } catch (e) { return ''; }
  }
  window.qrVerificacion = function (codigo, opts) {
    return { url: urlDe(codigo), dataUrl: dataUrl(codigo, opts) };
  };
  window.qrVerificacionHTML = function (codigo, opts) {
    opts = opts || {};
    const du = dataUrl(codigo, opts);
    if (!du) return '';
    const px = opts.px || 110;
    return `<div style="display:inline-flex;flex-direction:column;align-items:center;gap:3px;font-family:'Segoe UI',system-ui,sans-serif">
      <img src="${du}" width="${px}" height="${px}" alt="QR de verificación" style="display:block;border:1px solid #e2e8f0;border-radius:6px">
      <div style="font-size:8.5px;color:#475569;letter-spacing:.4px;text-align:center">Verifica este documento:<br><b style="letter-spacing:1px">${codigo}</b></div>
      <div style="font-size:7.5px;color:#94a3b8">${location.host}/verificar</div>
    </div>`;
  };
})();
