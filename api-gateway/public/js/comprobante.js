/**
 * comprobante.js — Comprobante de pago unificado AutoFácil
 * Usado por: caja.html, pagar-cuotas.html, revisar.html
 */

const _cClp = v => '$' + Math.round(Number(v)||0).toLocaleString('es-CL');
const _cFmtD = s => {
  if (!s) return '—';
  const str = typeof s === 'string' ? s : new Date(s).toISOString();
  const [y, m, d] = str.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
};
const _cEsc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const _cFmtNow = () => new Date().toLocaleDateString('es-CL', {
  day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'
});

/**
 * buildRecibo(opts) → string HTML
 *
 * opts.credito   — objeto crédito (numero_credito, nombre_cliente, rut_cliente, plazo)
 * opts.pagos     — array de pagos (1 o muchos); cada uno tiene numero_cuota, fecha_vencimiento,
 *                  fecha_pago, monto_cuota, interes_mora, gastos_cobranza, total_pagado, observacion
 * opts.cajaNombre— string, nombre de la caja (opcional)
 * opts.trxNum    — número de transacción (opcional; si hay, se usa como código del comprobante)
 * opts.idPago    — id del pago (cuando no hay trxNum)
 */
function buildRecibo({ credito, pagos, cajaNombre, trxNum, idPago }) {
  const c = credito || {};
  const numComp = trxNum
    ? `TRX-${String(trxNum).padStart(6, '0')}`
    : `N° ${String(idPago || '').padStart(8, '0')}`;

  const totalPagado = pagos.reduce((s, p) => s + (Number(p.total_pagado) || 0), 0);
  const totMora     = pagos.reduce((s, p) => s + (Number(p.interes_mora) || 0), 0);
  const totGastos   = pagos.reduce((s, p) => s + (Number(p.gastos_cobranza) || 0), 0);
  const isMulti     = pagos.length > 1;
  const primerPago  = pagos[0] || {};

  /* ── Detalle ── */
  let detalleHTML = '';

  if (isMulti) {
    /* Tabla multi-cuota */
    const hayGastos = totGastos > 0;
    const hayMora   = totMora   > 0;
    detalleHTML = `
      <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.83rem">
        <span style="color:#6b7280">Fecha de Pago</span>
        <span style="font-weight:600;color:#16a34a">${_cFmtD(primerPago.fecha_pago)}</span>
      </div>
      ${cajaNombre ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.83rem">
        <span style="color:#6b7280">Caja</span><span style="font-weight:600">${_cEsc(cajaNombre)}</span>
      </div>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:.82rem;margin-top:10px">
        <thead>
          <tr style="background:#f0f4f8">
            <th style="padding:6px 8px;text-align:left;color:#6b7280;font-size:.68rem;border-bottom:1.5px solid #e5e7eb">CUOTA</th>
            <th style="padding:6px 8px;text-align:left;color:#6b7280;font-size:.68rem;border-bottom:1.5px solid #e5e7eb">VENCIM.</th>
            <th style="padding:6px 8px;text-align:right;color:#6b7280;font-size:.68rem;border-bottom:1.5px solid #e5e7eb">CUOTA</th>
            ${hayGastos ? '<th style="padding:6px 8px;text-align:right;color:#6b7280;font-size:.68rem;border-bottom:1.5px solid #e5e7eb">GTOS.</th>' : ''}
            ${hayMora   ? '<th style="padding:6px 8px;text-align:right;color:#6b7280;font-size:.68rem;border-bottom:1.5px solid #e5e7eb">MORA</th>' : ''}
            <th style="padding:6px 8px;text-align:right;color:#6b7280;font-size:.68rem;border-bottom:1.5px solid #e5e7eb">TOTAL</th>
          </tr>
        </thead>
        <tbody>
          ${pagos.map(p => `
            <tr style="border-bottom:1px solid #f1f5f9">
              <td style="padding:6px 8px;font-weight:700;color:#0141A2">N°${p.numero_cuota}</td>
              <td style="padding:6px 8px;color:#6b7280;font-size:.78rem">${_cFmtD(p.fecha_vencimiento)}</td>
              <td style="padding:6px 8px;text-align:right;font-family:monospace">${_cClp(p.monto_cuota)}</td>
              ${hayGastos ? `<td style="padding:6px 8px;text-align:right;font-family:monospace;color:${Number(p.gastos_cobranza||0)>0?'#dc2626':'#9ca3af'}">${Number(p.gastos_cobranza||0)>0?_cClp(p.gastos_cobranza):'—'}</td>` : ''}
              ${hayMora   ? `<td style="padding:6px 8px;text-align:right;font-family:monospace;color:${Number(p.interes_mora||0)>0?'#dc2626':'#9ca3af'}">${Number(p.interes_mora||0)>0?_cClp(p.interes_mora):'—'}</td>` : ''}
              <td style="padding:6px 8px;text-align:right;font-family:monospace;font-weight:800;color:#0141A2">${_cClp(p.total_pagado)}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } else {
    /* Filas individuales — cuota única */
    const p = primerPago;
    detalleHTML = `
      <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.83rem">
        <span style="color:#6b7280">Cuota N°</span>
        <span style="font-weight:600">${p.numero_cuota} de ${c.plazo || '—'}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.83rem">
        <span style="color:#6b7280">Vencimiento</span>
        <span style="font-weight:600">${_cFmtD(p.fecha_vencimiento)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.83rem">
        <span style="color:#6b7280">Fecha de Pago</span>
        <span style="font-weight:600;color:#16a34a">${_cFmtD(p.fecha_pago)}</span>
      </div>
      ${cajaNombre ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.83rem">
        <span style="color:#6b7280">Caja</span><span style="font-weight:600">${_cEsc(cajaNombre)}</span>
      </div>` : ''}
      <div style="border-top:1px solid #f1f5f9;margin-top:6px;padding-top:6px">
        <div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.83rem">
          <span style="color:#6b7280">Monto Cuota</span>
          <span style="font-weight:600;font-family:monospace">${_cClp(p.monto_cuota)}</span>
        </div>
        ${Number(p.interes_mora||0) > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.83rem">
          <span style="color:#6b7280">Int. por Mora</span>
          <span style="font-weight:700;color:#dc2626;font-family:monospace">${_cClp(p.interes_mora)}</span>
        </div>` : ''}
        ${Number(p.gastos_cobranza||0) > 0 ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.83rem">
          <span style="color:#6b7280">Gtos. Cobranza</span>
          <span style="font-weight:700;color:#dc2626;font-family:monospace">${_cClp(p.gastos_cobranza)}</span>
        </div>` : ''}
        ${p.observacion ? `<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:.83rem">
          <span style="color:#6b7280">Observación</span>
          <span style="font-weight:600;max-width:60%;text-align:right">${_cEsc(p.observacion)}</span>
        </div>` : ''}
      </div>`;
  }

  return `
    <div id="compPrint" style="font-family:'Segoe UI',system-ui,sans-serif;padding:28px 32px;max-width:480px;margin:0 auto;background:#fff">

      <!-- Logo + título -->
      <div style="text-align:center;margin-bottom:14px">
        <img src="/img/logo.png" alt="" style="height:38px;display:block;margin:0 auto"
             onerror="this.style.display='none'">
        <div style="font-size:1rem;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#0141A2;margin-top:12px">Comprobante de Pago</div>
        <div style="font-size:.75rem;color:#6b7280;margin-top:3px">${_cEsc(numComp)} &nbsp;·&nbsp; ${_cFmtNow()}</div>
      </div>

      <!-- Crédito -->
      <div style="border-top:1.5px solid #e5e7eb;padding:10px 0">
        <div style="font-size:.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;margin-bottom:8px">Crédito</div>
        <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:.83rem">
          <span style="color:#6b7280">N° Crédito</span>
          <span style="font-weight:700">${_cEsc(c.numero_credito || c.id_credito || '—')}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:.83rem">
          <span style="color:#6b7280">Cliente</span>
          <span style="font-weight:700;text-align:right;max-width:70%">${_cEsc(c.nombre_cliente || '—')}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:.83rem">
          <span style="color:#6b7280">RUT</span>
          <span style="font-weight:600">${_cEsc(c.rut_cliente || '—')}</span>
        </div>
      </div>

      <!-- Detalle -->
      <div style="border-top:1.5px solid #e5e7eb;padding:10px 0">
        <div style="font-size:.65rem;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:#9ca3af;margin-bottom:8px">
          Detalle del Pago${isMulti ? ` (${pagos.length} cuotas)` : ''}
        </div>
        ${detalleHTML}
      </div>

      <!-- Total -->
      <div style="background:linear-gradient(135deg,#012d70,#0141A2);border-radius:10px;padding:14px 18px;margin-top:10px;display:flex;justify-content:space-between;align-items:center;color:#fff">
        <span style="font-size:.78rem;font-weight:700;opacity:.85;text-transform:uppercase">
          Total Pagado${isMulti ? ` (${pagos.length} cuotas)` : ''}
        </span>
        <span style="font-size:1.4rem;font-weight:900;font-family:monospace">${_cClp(totalPagado)}</span>
      </div>

      <!-- Pie -->
      <div style="text-align:center;font-size:.68rem;color:#9ca3af;margin-top:14px;padding-top:10px;border-top:1px dashed #e5e7eb">
        AutoFácil Crédito Automotriz &nbsp;·&nbsp; Documento no válido como boleta o factura
      </div>

    </div>`;
}

/* ── Capturar comprobante como imagen ── */
async function capturarComprobanteImagen() {
  const el = document.getElementById('compPrint');
  if (!el) { alert('No hay comprobante visible.'); return; }

  const btn = document.getElementById('btnCapturarImg');
  const txtOrig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span style="font-size:.85rem">⏳ Generando...</span>'; }

  try {
    const canvas = await html2canvas(el, {
      scale: 2,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      windowWidth: 520,
    });

    canvas.toBlob(async (blob) => {
      if (!blob) throw new Error('No se pudo generar la imagen.');

      /* Intentar copiar al portapapeles (Chrome/Edge/Firefox ≥ 98) */
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        _cToast('✓ Imagen copiada — pégala directamente en WhatsApp o correo (Ctrl+V)');
      } catch (_) {
        /* Fallback: descargar PNG */
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = `comprobante-${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
        _cToast('✓ Imagen descargada — adjúntala en WhatsApp o correo');
      }
    }, 'image/png');
  } catch (e) {
    alert('Error al generar imagen: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = txtOrig; }
  }
}

function _cToast(msg) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;' +
    'padding:11px 22px;border-radius:10px;font-size:.88rem;font-weight:600;z-index:99999;' +
    'box-shadow:0 4px 20px rgba(0,0,0,.35);white-space:nowrap;pointer-events:none';
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 4000);
}
