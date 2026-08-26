'use strict';
/* ═══════════════════════════════════════════════════════════════════════════
   Motor ÚNICO del correo "Comprobante de Pago" al CLIENTE.
   Lo usan el pago en CAJA (pagos-credito → createBatch) y la ODP de Cuotas
   (cobranza → aprobar). Plantilla paramétrica `cliente_comprobante_cuota`
   (Correos del Sistema): asunto, texto, interruptor, CC y CCO.
   Adjunta el Comprobante de Pago en PDF (shared/comprobante-pago-pdf).
   NUNCA lanza: un correo caído jamás frena un pago.
   ═══════════════════════════════════════════════════════════════════════════ */
const TPL = require('./plantillas-correo');

const clp = v => '$' + Math.round(Number(v) || 0).toLocaleString('es-CL');
const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtD = s => {
  if (!s) return '—';
  const str = typeof s === 'string' ? s : new Date(s).toISOString();
  const [y, m, d] = str.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
};

/* Tabla de cuotas + condonación + caja del total (estructura fija del correo). */
function tablaComprobanteHTML({ cuotas, total, origen }) {
  const filas = cuotas.map(c => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;text-align:center">${c.numero_cuota}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7">${fmtD(c.fecha_vencimiento)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;text-align:right">${clp(c.monto_cuota)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;text-align:right">${clp(c.interes_mora)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;text-align:right">${clp(c.gastos_cobranza)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eef2f7;text-align:right;font-weight:700">${clp(c.total_pagado)}</td>
    </tr>`).join('');
  // Condonación (si vienen los montos full antes de condonar)
  const sum = k => cuotas.reduce((s, c) => s + (Number(c[k]) || 0), 0);
  const condMora = Math.max(0, Math.round(cuotas.reduce((s, c) =>
    s + (Number(c.interes_mora_total != null ? c.interes_mora_total : c.interes_mora) || 0), 0) - sum('interes_mora')));
  const condGastos = Math.max(0, Math.round(cuotas.reduce((s, c) =>
    s + (Number(c.gastos_cobranza_total != null ? c.gastos_cobranza_total : c.gastos_cobranza) || 0), 0) - sum('gastos_cobranza')));
  const condHTML = (condMora + condGastos) > 0 ? `
    <div style="margin:0 0 14px;font-size:13px">
      <div style="font-weight:700;color:#15803d;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Condonación otorgada</div>
      ${condGastos > 0 ? `<div>Gastos de cobranza condonados: <b style="color:#15803d">-${clp(condGastos)}</b></div>` : ''}
      ${condMora > 0 ? `<div>Intereses por mora condonados: <b style="color:#15803d">-${clp(condMora)}</b></div>` : ''}
    </div>` : '';
  return `<table style="width:100%;border-collapse:collapse;font-size:13px;margin:0 0 14px">
      <thead>
        <tr style="background:#f1f5f9;color:#334155">
          <th style="padding:7px 8px;text-align:center">N°</th>
          <th style="padding:7px 8px;text-align:left">Vencimiento</th>
          <th style="padding:7px 8px;text-align:right">Cuota</th>
          <th style="padding:7px 8px;text-align:right">Int. Mora</th>
          <th style="padding:7px 8px;text-align:right">Gtos. Cobr.</th>
          <th style="padding:7px 8px;text-align:right">Total</th>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>
    ${condHTML}
    <table style="width:100%;border-collapse:collapse;background:#0141A2;border-radius:10px"><tr>
      <td style="padding:12px 18px;color:#fff;font-size:13px;opacity:.85">TOTAL PAGADO${origen ? ' · ' + esc(origen) : ''}</td>
      <td style="padding:12px 18px;color:#fff;font-size:20px;font-weight:800;text-align:right">${clp(total)}</td>
    </tr></table>`;
}

/* enviarComprobantePago({ credito, pagos, trxNum, fechaPago, cajaNombre, origen, bccExtra })
   credito: { id_credito?, numero_credito, nombre_cliente, rut_cliente, email_cliente, plazo? }
   pagos:   [{ numero_cuota, fecha_vencimiento, fecha_pago, monto_cuota, interes_mora,
               gastos_cobranza, total_pagado, interes_mora_total?, gastos_cobranza_total? }]
   Devuelve { ok, msg }. */
async function enviarComprobantePago({ credito = {}, pagos = [], trxNum, fechaPago, cajaNombre, origen, bccExtra = [] }) {
  try {
    if (!credito.email_cliente) return { ok: false, msg: 'sin email del cliente' };
    if (!pagos.length) return { ok: false, msg: 'sin cuotas' };
    const p = await TPL.obtener('cliente_comprobante_cuota').catch(() => null);
    if (p && !p.activo) return { ok: false, msg: 'no enviado: plantilla desactivada en Correos del Sistema' };

    const total = pagos.reduce((s, c) => s + Math.round(Number(c.total_pagado) || 0), 0);
    const trx = 'TRX-' + String(trxNum || '').padStart(6, '0');
    const datos = {
      cliente: credito.nombre_cliente || 'cliente',
      num_credito: String(credito.numero_credito || credito.id_credito || ''),
      trx, fecha: fmtD(fechaPago || pagos[0].fecha_pago), total: clp(total),
      origen: origen || '', n_cuotas: pagos.length,
    };
    const { enviarCorreo, envolverHTML, remitenteCobranza } = require('./mailer');
    const intro = p ? TPL.aHTML(TPL.render(p.cuerpo, datos))
      : `<p style="margin:0 0 14px">Estimado(a) <strong>${esc(datos.cliente)}</strong>,</p>
         <p style="margin:0 0 16px">Confirmamos el pago registrado para su crédito <strong>N° ${esc(datos.num_credito)}</strong>.
         Comprobante <strong>${trx}</strong> · ${datos.fecha}.</p>`;
    const html = envolverHTML(intro + tablaComprobanteHTML({ cuotas: pagos, total, origen }));

    // Comprobante de Pago en PDF adjunto — si falla, el correo sale igual
    let attachments;
    try {
      const { generarComprobantePDF } = require('./comprobante-pago-pdf');
      const buf = await generarComprobantePDF({
        credito, pagos, trxNum, cajaNombre,
        horaPago: new Date().toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour12: false }),
      });
      attachments = [{ filename: `Comprobante-${trx}.pdf`, content: buf, contentType: 'application/pdf' }];
    } catch (e) { console.error('[comprobante-pago pdf]', e.message); }

    const lista = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
    const cc = p ? lista(p.cc) : [];
    const bcc = [...new Set([...(p ? lista(p.cco) : []), ...bccExtra]
      .map(s => String(s || '').trim().toLowerCase()).filter(Boolean))];

    const r = await enviarCorreo({
      to: credito.email_cliente,
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      from: remitenteCobranza(),
      subject: p ? TPL.render(p.asunto, datos) : `Comprobante de pago — Crédito N° ${datos.num_credito} (${trx})`,
      html, attachments,
    });
    return r.ok ? { ok: true, msg: 'enviado' } : { ok: false, msg: 'no enviado: ' + r.error };
  } catch (e) {
    console.error('[comprobante-pago-correo]', e.message);
    return { ok: false, msg: e.message };
  }
}

module.exports = { enviarComprobantePago, tablaComprobanteHTML };
