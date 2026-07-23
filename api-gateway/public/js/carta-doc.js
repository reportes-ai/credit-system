/* ─────────────────────────────────────────────────────────────────────────
   MOTOR ÚNICO del documento CARTA DE APROBACIÓN.
   La carta debe salir IDÉNTICA desde cualquier módulo que la imprima
   (Cartas de Aprobación, Aprobaciones, futuros). Todo cambio de formato o
   texto se hace AQUÍ, una sola vez.

     window.AF_CARTA_DOC(c, opts) → HTML string

   c: la carta (campos estándar: cliente, rutCliente, tipo, parque, vendedor,
      concesionario, rutConc, tipoVehiculo, marca, modelo, anio, precioVenta,
      patente, pie, prenda, saldo, plazo, partNeto, partIVA, partBruto,
      acreedor, fecha, ejecutivoNombre/Tel/Mail, opCarta, numeroCreditoCreado,
      excepciones[], excepcionesComentarios{}, creadoPorInitials,
      aprobadoPorInitials)
   opts:
     banner      HTML previo (ej. aviso VISTA PREVIA) — opcional
     intro       texto intro (paramétrico cartas-params carta_intro)
     consid      consideraciones, una por línea (paramétrico carta_consideraciones)
     logoSrc     src del logo (base64 o URL)
     firmaImg    HTML de la firma (img o línea)
     validezStr  fecha de validez ya formateada
     qr          { qrHTML, fes }  → se estampa junto a la firma — opcional
     qrSlot      true → deja los slots vacíos #cartaQRSlot / #cartaFESLine
                 para estampado asíncrono posterior — opcional
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const clp = v => (v == null || v === '' || isNaN(Number(v))) ? '' : '$' + Math.round(Number(v)).toLocaleString('es-CL');
  const rutF = r => {
    const s = String(r || '').replace(/[^0-9kK]/g, '').toUpperCase();
    if (s.length < 2) return String(r || '');
    const cuerpo = s.slice(0, -1), dv = s.slice(-1);
    return cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + dv;
  };
  const title = s => String(s || '').toLowerCase().replace(/(^|\s)\S/g, m => m.toUpperCase());
  const fechaF = f => { try { return new Date(f).toLocaleDateString('es-CL'); } catch (_) { return String(f || ''); } };

  window.AF_CARTA_DOC = function (c, opts) {
    opts = opts || {};
    const acreedor = esc(c.acreedor || 'AUTOFIN');
    const isParque = c.tipo && String(c.tipo).includes('PARQUE');
    const parqueSec = isParque ? `
    <div class="sec-title">DATOS DEL PARQUE Y DEALER</div>
    <table class="data-tbl">
      <tr><td class="lbl">PARQUE AUTOMOTRIZ</td><td class="val">${esc(c.parque || '')}</td><td class="lbl">VENDEDOR</td><td class="val">${esc(c.vendedor || '')}</td></tr>
      <tr><td class="lbl">DEALER</td><td class="val" colspan="3">${esc(c.concesionario || '')}</td></tr>
      <tr><td class="lbl">RUT</td><td class="val" colspan="3">${rutF(c.rutConc || '')}</td></tr>
    </table>` : `
    <div class="sec-title">DATOS DEL DEALER</div>
    <table class="data-tbl">
      <tr><td class="lbl">DEALER</td><td class="val" colspan="3">${esc(c.concesionario || '')}</td></tr>
      <tr><td class="lbl">RUT</td><td class="val">${rutF(c.rutConc || '')}</td><td class="lbl">VENDEDOR</td><td class="val">${esc(c.vendedor || '')}</td></tr>
    </table>`;

    // Excepciones: NO van en la carta que se firma y entrega (tema interno, decisión
    // 2026-07-23). Siguen visibles en la revisión del analista y en el listado ("E").
    const excepcionesSec = '';

    const qrHTML = opts.qr && opts.qr.qrHTML ? opts.qr.qrHTML : '';
    const fesTxt = opts.qr && opts.qr.fes ? esc(opts.qr.fes) : '';

    return `<div class="carta-doc" id="cartaDoc">
    ${opts.banner || ''}
    <div style="display:flex;align-items:flex-start;justify-content:space-between;border-bottom:2px solid #0141A2;padding-bottom:6px;margin-bottom:8px">
      <div style="font-size:8px;color:#546E7A;line-height:1.6">Av. Presidente Kennedy 5757, Of. 1601, Las Condes<br>Santiago, Chile &middot; www.autofacilchile.cl</div>
      <img src="${opts.logoSrc || (location.origin + '/img/logo-autofacil.png')}" style="height:30px;object-fit:contain">
    </div>
    <div style="text-align:center;font-size:12px;font-weight:bold;color:#0141A2;letter-spacing:.5px;margin-bottom:7px;text-transform:uppercase">CARTA DE APROBACIÓN DE CRÉDITO</div>
    <p style="font-size:9px;text-align:justify;line-height:1.5;margin:0 0 7px">${esc(opts.intro || '').replace(/\{\{ACREEDOR\}\}/g, acreedor)}</p>
    <table class="data-tbl">
      <tr><td class="lbl" style="width:13%">FECHA</td><td class="val" style="width:18%">${fechaF(c.fecha)}</td><td class="lbl" style="width:18%">VALIDEZ APROBACIÓN</td><td class="val">${esc(opts.validezStr || '')}</td></tr>
      <tr><td class="lbl">EJECUTIVO</td><td class="val">${esc(c.ejecutivoNombre || '')}</td><td class="lbl">TELÉFONO</td><td class="val">${esc(c.ejecutivoTel || '')}</td></tr>
      <tr><td class="lbl">CORREO</td><td class="val">${esc(c.ejecutivoMail || '')}</td><td class="lbl">N° CARTA</td><td class="val"><strong>${esc(c.opCarta || '')}</strong>${c.numeroCreditoCreado ? ` &nbsp;<span style="color:#475569;font-weight:normal;font-size:8.5px">· Crédito: <b>${esc(c.numeroCreditoCreado)}</b></span>` : ''}</td></tr>
    </table>
    <div class="sec-title">DATOS DEL CLIENTE</div>
    <table class="data-tbl">
      <tr><td class="lbl" style="width:13%">NOMBRE</td><td class="val" style="width:37%">${esc(title(c.cliente || ''))}</td><td class="lbl" style="width:13%">RUT</td><td class="val">${rutF(c.rutCliente || '')}</td></tr>
    </table>
    <div class="sec-title">DATOS DEL VEHÍCULO</div>
    <table class="data-tbl" style="table-layout:fixed;width:100%">
      <colgroup><col style="width:19%"><col style="width:31%"><col style="width:19%"><col style="width:31%"></colgroup>
      <tr><td class="lbl">TIPO</td><td class="val">${esc(c.tipoVehiculo || '')}</td><td class="lbl">MARCA</td><td class="val">${esc(c.marca || '')}</td></tr>
      <tr><td class="lbl">MODELO</td><td class="val">${esc(c.modelo || '')}</td><td class="lbl">AÑO</td><td class="val">${esc(c.anio || '')}</td></tr>
      <tr><td class="lbl">PRECIO VENTA</td><td class="val">${clp(c.precioVenta)}</td><td class="lbl">PLACA PATENTE</td><td class="val">${esc(c.patente || '')}</td></tr>
      <tr><td class="lbl">PIE</td><td class="val">${clp(c.pie)}</td><td class="lbl">PRENDA VEHÍCULO</td><td class="val">${esc(c.prenda || '')}</td></tr>
      <tr><td class="lbl">SALDO PRECIO</td><td class="val">${clp(c.saldo)}</td><td class="lbl">PLAZO</td><td class="val">${esc(c.plazo || '')} cuotas</td></tr>
    </table>
    ${parqueSec}
    <div class="sec-title">PARTICIPACIÓN DEALER</div>
    <table class="data-tbl">
      <tr><td class="lbl" style="width:13%">VALOR NETO</td><td class="val" style="width:20%">${clp(c.partNeto)}</td><td class="lbl" style="width:13%">VALOR IVA</td><td class="val">${clp(c.partIVA)}</td></tr>
      <tr><td class="lbl">VALOR BRUTO</td><td class="val">${clp(c.partBruto)}</td><td class="lbl">ACREEDOR</td><td class="val">${acreedor}</td></tr>
    </table>
    ${excepcionesSec}
    <div class="sec-title">CONSIDERACIONES</div>
    <div style="font-size:9px;line-height:1.5;text-align:justify;margin-top:3px">
      ${String(opts.consid || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => `<p style="margin:2px 0">${esc(l).replace(/\{\{ACREEDOR\}\}/g, acreedor)}</p>`).join('')}
    </div>
    <div style="margin-top:8px;display:flex;align-items:flex-end">
      <div id="cartaQRSlot" style="width:130px">${qrHTML}</div>
      <div style="flex:1;text-align:center">
        ${opts.firmaImg || ''}
        <div style="font-weight:bold;font-size:10px;margin-top:3px;letter-spacing:.3px">GERENTE OPERACIONES AUTOFÁCIL SPA</div>
        <div id="cartaFESLine" style="font-size:7.5px;color:#64748b;margin-top:3px">${fesTxt}</div>
      </div>
      <div style="width:130px"></div>
    </div>
    <div style="margin-top:5px;font-size:7.5px;color:#aaa;text-align:right;border-top:.5px solid #e0e0e0;padding-top:3px">
      Creado por: ${esc(c.creadoPorInitials || '')} | ${c.aprobadoPorInitials ? 'Revisado por: ' + esc(c.aprobadoPorInitials) : 'Pendiente de Revisión'} | Tipo: ${esc(c.tipo || '')}
    </div>
  </div>`;
  };
})();
