/* v1.3 — montos negativos como "− $x" (retención de boleta que se descuenta). v1.2 — el timbre PAGADO se ancla al fin del cuerpo (tapaba la trazabilidad). v1.1 — pie de TRAZABILIDAD (carta → aprobación → otorgamiento → fundantes → factura → orden → pago)
   ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
   MOTOR ÚNICO del documento "Solicitud de Pago" (Orden de Pago)

   Vivía dentro de /ordenes-pago/historial/. Se extrajo para que Saldos
   Precios a Pagar muestre EXACTAMENTE el mismo documento en su propio
   popup, sin abrir otra pestaña ni mantener una segunda copia del HTML.

   Uso:  AF_ODP_DOC.html(orden)     → HTML del documento
         AF_ODP_DOC.impInfo(orden)  → { neto, bruto, imp, pagar, pct, lbl, esRet, esEx }
   La orden se obtiene de GET /api/ordenes-pago/ordenes/:id/documento
   ───────────────────────────────────────────────────────────────── */
(function () {
const escH = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
// Negativos como descuento legible: "− $38.565" (la retención de una boleta se descuenta)
const fmtMon = n => { const v = Number(n||0); return (v < 0 ? '− ' : '') + '$' + Math.abs(v).toLocaleString('es-CL'); };
const fdate = d => d? String(d).slice(0,10).split('-').reverse().join('/') : '—';
/* ── Documento "Solicitud de Pago" (formato AutoFácil) ── */
const MESES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const periodoCL = d => { if(!d) return '—'; const x=new Date(String(d).slice(0,10)); if(isNaN(x)) return '—'; return MESES[x.getUTCMonth()]+'-'+String(x.getUTCFullYear()).slice(2); };
function impInfo(o){
  const t = o.tratamiento || '';
  const esRet = (t==='RET'||t==='HONORARIOS');
  const esEx  = (t==='EXENTO');
  const neto  = Number(o.monto_neto != null ? o.monto_neto : o.monto)||0;
  const imp   = Number(o.impuesto_monto)||0;
  const bruto = Number(o.monto_bruto != null ? o.monto_bruto : (neto + imp))||0;
  const pagar = Number(o.monto)||0;
  const pct   = Number(o.impuesto_pct != null ? o.impuesto_pct : (esRet?15.25:esEx?0:19));
  const lbl   = esRet ? `Retención ${pct}%` : esEx ? 'Exento' : `IVA ${pct}%`;
  return { neto, bruto, imp, pagar, pct, lbl, esRet, esEx };
}
/* Fecha y hora larga para la trazabilidad: "20-08-2026 01:20 p. m. hrs" */
const fdh = d => {
  if (!d) return '';
  const x = new Date(String(d).replace(' ', 'T'));
  if (isNaN(x)) return String(d).slice(0, 16).replace('T', ' ');
  return x.toLocaleDateString('es-CL') + ' ' +
         x.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) + ' hrs';
};
/* Pie de TRAZABILIDAD — la vida del negocio que se está pagando, desde la carta
   de aprobación hasta la orden. Mismo formato que las Órdenes de Compra. */
function trazaHTML(traza){
  if (!Array.isArray(traza) || !traza.length) return '';
  const pasos = traza.map(p => {
    const col = p.mal ? '#b91c1c' : '#15803d';
    const quien = p.nombre ? ` <b>${escH(p.nombre)}</b>` : '';
    const cuando = p.fecha ? ` el ${fdh(p.fecha)}` : '';
    return `<span style="color:${col};font-weight:600">${escH(p.label)}</span>${quien}${cuando}`;
  }).join(' &nbsp;⟶&nbsp; ');
  return `<div style="margin-top:14px;padding-top:9px;border-top:1px dashed #cbd5e1;font-size:9.5px;color:#475569;line-height:1.7">
    <b style="color:#1e3a8a;text-transform:uppercase;font-size:9px">Trazabilidad</b><br>${pasos}
  </div>`;
}
function docHTML(o){
  const i = impInfo(o);
  const docNum = [o.tipo_documento, o.numero_documento].filter(Boolean).join(' ');
  const periodo = periodoCL(o.fecha_documento || o.fecha_emision);
  const fechaPagar = fdate(o.fecha_pago || o.fecha_emision);
  const tipoGasto = (o.categoria || 'PAGO A PROVEEDOR').toUpperCase();
  const Sdoc='position:relative;font-family:Arial,sans-serif;color:#1e293b;font-size:11px;border:2px solid #93c5fd;border-radius:8px;padding:14px 16px;display:block;width:100%;box-sizing:border-box';
  const sello = (o.pago && window.timbrePagado) ? `<div style="position:absolute;right:30px;bottom:22px;z-index:3">${timbrePagado(o.pago)}</div>` : '';
  const Smeta='border-collapse:collapse;font-size:11px';
  const Slbl='color:#64748b;font-weight:700;text-transform:uppercase;font-size:9px;padding:1px 8px;white-space:nowrap';
  const Smv='padding:1px 8px;font-size:11px';
  const Stbl='width:100%;border-collapse:collapse;margin:8px 0;font-size:11px;table-layout:fixed';
  const Sth='background:#dbeafe;color:#1e3a8a;border:1px solid #93c5fd;padding:5px 6px;font-size:9px;text-transform:uppercase;text-align:left;white-space:normal;word-break:break-word';
  const Std='border:1px solid #cbd5e1;padding:5px 6px;white-space:normal;word-break:break-word';
  const Snum=Std+';text-align:right';
  const Sres='border-collapse:collapse;margin-top:14px;width:100%;max-width:860px';
  const SresL='border:1px solid #cbd5e1;padding:5px 8px;font-size:11px;background:#eff6ff;font-weight:700;width:22%;white-space:nowrap';
  const SresV='border:1px solid #cbd5e1;padding:5px 8px;font-size:11px';
  // Saldo Precio de AUTOFIN: desglose (Saldo + Transferencia + Limitación); el resto: tabla tributaria.
  const hayDesg = Array.isArray(o.desglose) && o.desglose.length > 0;
  const tablaDetalle = hayDesg ? `
    <table style="${Stbl}">
      <colgroup><col style="width:30%"><col style="width:22%"><col style="width:33%"><col style="width:15%"></colgroup>
      <thead><tr><th style="${Sth}">Proveedor</th><th style="${Sth}">RUT</th><th style="${Sth}">Detalle</th><th style="${Sth}">Monto</th></tr></thead>
      <tbody>
        ${o.desglose.map((d,idx)=>`<tr><td style="${Std}">${idx===0?escH(o.proveedor_nombre||''):''}</td><td style="${Std}">${idx===0?escH(o.proveedor_rut||''):''}</td><td style="${Std}">${escH(d.label||'')}</td><td style="${Snum}">${fmtMon(d.monto)}</td></tr>`).join('')}
        <tr><td colspan="3" style="${Std};text-align:right;font-weight:800;background:#f1f5f9">A PAGAR</td><td style="${Snum};font-weight:800;background:#dbeafe;color:#1e3a8a">${fmtMon(i.pagar)}</td></tr>
      </tbody>
    </table>` : `
    <table style="${Stbl}">
      <colgroup><col style="width:23%"><col style="width:12%"><col style="width:21%"><col style="width:8%"><col style="width:12%"><col style="width:12%"><col style="width:12%"></colgroup>
      <thead><tr><th style="${Sth}">Proveedor</th><th style="${Sth}">RUT</th><th style="${Sth}">Detalle</th><th style="${Sth}">Mes</th><th style="${Sth}">Monto Bruto</th><th style="${Sth}">${escH(i.lbl)}</th><th style="${Sth}">Monto Neto</th></tr></thead>
      <tbody>
        <tr><td style="${Std}">${escH(o.proveedor_nombre||'')}</td><td style="${Std}">${escH(o.proveedor_rut||'')}</td>
          <td style="${Std}">${escH(o.concepto||'')}</td><td style="${Std}">${periodo}</td>
          <td style="${Snum}">${fmtMon(i.bruto)}</td><td style="${Snum}">${i.esEx?'—':fmtMon(i.imp)}</td><td style="${Snum}">${fmtMon(i.neto)}</td></tr>
        <tr><td colspan="6" style="${Std};text-align:right;font-weight:800;background:#f1f5f9">A PAGAR</td><td style="${Snum};font-weight:800;background:#dbeafe;color:#1e3a8a">${fmtMon(i.pagar)}</td></tr>
      </tbody>
    </table>`;
  const montoRows = hayDesg
    ? o.desglose.map(d=>`<tr><td style="${SresL}">${escH(d.label||'')}</td><td style="${SresV}">${fmtMon(d.monto)}</td></tr>`).join('')
    : `<tr><td style="${SresL}">Monto bruto</td><td style="${SresV}">${fmtMon(i.bruto)}</td></tr>
      <tr><td style="${SresL}">${escH(i.lbl)}</td><td style="${SresV}">${i.esEx?'—':fmtMon(i.imp)}</td></tr>
      <tr><td style="${SresL}">Monto neto</td><td style="${SresV}">${fmtMon(i.neto)}</td></tr>`;
  /* El timbre PAGADO se ancla al final del CUERPO, no al pie del documento:
     abajo va la trazabilidad y el timbre la tapaba. */
  return `<div style="${Sdoc}">
    <div style="position:relative">${sello}
    <table style="width:100%;border-collapse:collapse;margin-bottom:14px"><tbody><tr>
      <td style="vertical-align:top"><table style="${Smeta}"><tbody>
        <tr><td style="${Slbl}">Concepto</td><td style="${Smv}">SOLICITUD DE PAGO</td></tr>
        <tr><td style="${Slbl}">Compañía</td><td style="${Smv}">AUTOFÁCIL SPA</td></tr>
        <tr><td style="${Slbl}">Tipo gasto</td><td style="${Smv}">${escH(tipoGasto)}</td></tr>
        <tr><td style="${Slbl}">N° Orden</td><td style="${Smv}">${escH(o.numero||'—')}</td></tr>
        <tr><td style="${Slbl}">Solicitante</td><td style="${Smv}">${escH(o.usuario_nombre||'—')}</td></tr>
        <tr><td style="${Slbl}">Fecha</td><td style="${Smv}">${fdate(o.fecha_emision)}</td></tr>
      </tbody></table></td>
      <td style="vertical-align:top;text-align:right">
        <img width="150" height="34" style="height:34px;width:auto" src="${location.origin}/img/logo-autofacil.png" onerror="this.src='${location.origin}/img/logo.png'">
      </td>
    </tr></tbody></table>
    ${tablaDetalle}
    <table style="${Sres}"><tbody>
      <tr><td style="${SresL}">Proveedor</td><td style="${SresV}">${escH(o.proveedor_nombre||'')}</td></tr>
      <tr><td style="${SresL}">Concepto</td><td style="${SresV}">${escH(o.concepto||'')}</td></tr>
      <tr><td style="${SresL}">Período</td><td style="${SresV}">${periodo}</td></tr>
      <tr><td style="${SresL}">Documento</td><td style="${SresV}">${escH(o.tipo_documento||'—')}${docNum&&o.numero_documento?' N° '+escH(o.numero_documento):''}${o.fecha_documento?' · '+fdate(o.fecha_documento):''}</td></tr>
      ${Array.isArray(o.facturas)&&o.facturas.length?`<tr><td style="${SresL}">Factura adjunta</td><td style="${SresV}">${o.facturas.map(f=>`<a href="#" onclick="AF_ODP_DOC.verFactura(${f.id});return false" style="color:#0141A2;font-weight:700;text-decoration:none">📎 ${escH(f.nombre)}</a>`).join(' · ')}</td></tr>`:''}
      ${o.deposito ? `
      <tr><td style="${SresL}">Depositar en</td><td style="${SresV}"><b>${escH(o.deposito.banco||'—')}</b> · ${
        o.deposito.tipo_cuenta ? escH(o.deposito.tipo_cuenta)
        : '<span style="color:#b45309;font-weight:700">⚠ falta el tipo de cuenta</span>'
      } · Cta. N° <b>${escH(o.deposito.num_cuenta||'')}</b></td></tr>
      <tr><td style="${SresL}">Titular</td><td style="${SresV}">${escH(o.deposito.titular||'—')}${o.deposito.rut?' · RUT '+escH(o.deposito.rut):''}</td></tr>`
      : o.sin_datos_banco
      ? `<tr><td style="${SresL}">Depositar en</td><td style="${SresV};color:#b91c1c;font-weight:700">⚠ SIN DATOS BANCARIOS — completar banco, tipo y N° de cuenta en la ficha antes de transferir</td></tr>`
      : `<tr><td style="${SresL}">Destino</td><td style="${SresV}">${escH(o.destino||'—')}</td></tr>`}
      ${montoRows}
      <tr><td style="${SresL}">A pagar</td><td style="${SresV};font-weight:700">${fmtMon(i.pagar)}</td></tr>
      <tr><td style="${SresL}">Fecha a pagar</td><td style="${SresV}">${fechaPagar}</td></tr>
    </tbody></table>
    </div>
    ${trazaHTML(o.traza)}
  </div>`;
}
/* Abre la factura adjunta en otra pestaña (fetch con token → blob: un link
   directo no sirve porque el endpoint exige Authorization). */
async function verFactura(id){
  try {
    const t = sessionStorage.getItem('token');
    const r = await fetch('/api/postventa/factura-doc/' + id, { headers: { Authorization: 'Bearer ' + t } });
    if (!r.ok) throw new Error();
    const u = URL.createObjectURL(await r.blob());
    window.open(u, '_blank');
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  } catch (_) { alert('No se pudo abrir la factura adjunta.'); }
}
window.AF_ODP_DOC = { html: docHTML, impInfo, verFactura };
})();
