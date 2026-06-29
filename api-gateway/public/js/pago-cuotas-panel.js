/* ─────────────────────────────────────────────────────────────────────────────
   Panel de Pago de Cuotas — componente reutilizable (sin Bootstrap).
   Misma lógica probada de /tesoreria/caja: selección múltiple, "monto recibido"
   con condonación automática (gastos proporcional → intereses proporcional,
   respetando topes de la caja), formato pesos y pago en lote
   (POST /api/pagos-credito/batch) registrando la condonación (montos full).

   Uso:
     <script src="/js/comprobante.js"></script>   <!-- buildRecibo -->
     <script src="/js/pago-cuotas-panel.js"></script>
     PagoCuotas.montar(hostEl, { creditId, onLoad?: fn(credito) });

   Mora/gastos: fuente canónica /api/cobranza/calcular-cobranza-lote (paramétrico).
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.PagoCuotas) return;

  const tok = () => sessionStorage.getItem('token');
  const API = (p, o = {}) => fetch(p, { headers: { Authorization: 'Bearer ' + tok(), 'Content-Type': 'application/json' }, ...o });
  const clp = v => '$' + Math.round(Number(v) || 0).toLocaleString('es-CL');
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtRut = v => { v = String(v || '').replace(/[^0-9kK]/g, '').toUpperCase(); if (v.length < 2) return String(v || ''); const dv = v.slice(-1); return v.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + dv; };
  const fmtFecha = f => { if (!f) return '—'; try { return new Date(f).toLocaleDateString('es-CL', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '—'; } };

  const S = {
    host: null, creditId: null, onLoad: null,
    credito: null, pagos: [], schedule: [], miCaja: null, cuentas: [],
    tmc: 0, ufHoy: 0, ufMap: new Map(), cobranzaMap: new Map(),
    saldoAFavor: 0, sel: new Set(),
  };

  /* ── Estilos (una vez) ── */
  function injectCSS() {
    if (document.getElementById('pcp-css')) return;
    const st = document.createElement('style'); st.id = 'pcp-css';
    st.textContent = `
      .pcp-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px}
      .pcp-stat{background:#fff;border-radius:10px;border:1.5px solid #e5e7eb;padding:12px 14px}
      .pcp-stat.mora{border-color:#fca5a5;background:#fff5f5}.pcp-stat.pag{border-color:#86efac;background:#f0fdf4}.pcp-stat.pend{border-color:#fcd34d;background:#fefce8}
      .pcp-stat .l{font-size:.62rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin-bottom:3px}
      .pcp-stat.mora .l{color:#b91c1c}.pcp-stat.pag .l{color:#15803d}.pcp-stat.pend .l{color:#a16207}
      .pcp-stat .v{font-size:1.4rem;font-weight:900;color:#0f2d6b;line-height:1}
      .pcp-card{background:#fff;border-radius:14px;border:1px solid #e5e7eb;overflow:hidden}
      .pcp-head{padding:13px 18px;background:#f8faff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between}
      .pcp-head .t{font-size:.8rem;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:#0f2d6b}
      .pcp-tw{overflow-x:auto}
      table.pcp-tbl{width:100%;border-collapse:collapse;font-size:.83rem}
      table.pcp-tbl th{background:#f1f5f9;color:#374151;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:9px 12px;border-bottom:2px solid #e5e7eb;white-space:nowrap}
      table.pcp-tbl td{padding:9px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
      table.pcp-tbl tr.pag td{background:#f0fdf4}table.pcp-tbl tr.mora td{background:#fff8f0}table.pcp-tbl tr.sel td{background:#eff6ff !important}
      .pcp-r{text-align:right}.pcp-c{text-align:center}
      .pcp-amt{font-weight:700;font-family:monospace;font-size:.82rem}.pcp-mora{color:#dc2626}.pcp-mut{color:#9ca3af;font-weight:400}
      .pcp-chk{width:17px;height:17px;cursor:pointer;accent-color:#0f2d6b}
      .pcp-pill{display:inline-flex;align-items:center;gap:4px;border-radius:20px;padding:3px 9px;font-size:.71rem;font-weight:700;white-space:nowrap}
      .pcp-pill.pag{background:#dcfce7;color:#166534}.pcp-pill.mora{background:#fee2e2;color:#991b1b}.pcp-pill.al{background:#dbeafe;color:#1d4ed8}
      .pcp-bcomp{background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:6px;padding:3px 10px;font-size:.73rem;font-weight:700;cursor:pointer}
      .pcp-brev{background:#fff1f2;color:#991b1b;border:1px solid #fca5a5;border-radius:6px;padding:3px 10px;font-size:.73rem;font-weight:700;cursor:pointer}
      .pcp-nocaja{background:#fff7ed;border:1.5px solid #fed7aa;border-radius:12px;padding:14px 18px;color:#92400e;font-size:.86rem;margin-bottom:16px}

      /* Panel de pago (sticky) */
      .pcp-pay{position:fixed;bottom:0;left:0;right:0;z-index:150;background:#fff;border-top:2px solid #0f2d6b;box-shadow:0 -4px 24px rgba(15,45,107,.15);max-height:62vh;overflow-y:auto;transition:transform .25s}
      .pcp-pay.hidden{transform:translateY(100%)}
      .pcp-pres{display:flex;align-items:center;gap:16px;padding:12px 24px;flex-wrap:wrap}
      .pcp-btn{border:none;border-radius:9px;padding:9px 22px;font-size:.9rem;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
      .pcp-btn.go{background:linear-gradient(135deg,#16a34a,#15803d);color:#fff}.pcp-btn.go:disabled{opacity:.55;cursor:default}
      .pcp-btn.sec{background:#eef2f7;color:#334155}
      .pcp-ph{background:linear-gradient(90deg,#012d70,#0255c5);color:#fff;padding:10px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
      .pcp-pb{padding:16px 24px}
      .pcp-auto{background:#f0f9ff;border:1.5px solid #bae6fd;border-radius:10px;padding:12px 16px;margin-bottom:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
      .pcp-auto label{font-size:.82rem;font-weight:600;color:#075985;white-space:nowrap}
      .pcp-auto input{border:1.5px solid #7dd3fc;border-radius:8px;padding:7px 12px;font-size:.9rem;font-weight:700;width:180px;outline:none;color:#0c4a6e}
      .pcp-hint{font-size:.75rem;color:#0369a1;flex:1;min-width:160px}
      table.pcp-bd{width:100%;border-collapse:collapse;font-size:.82rem;margin-bottom:14px}
      table.pcp-bd th{background:#f8fafc;color:#6b7280;font-weight:700;font-size:.7rem;text-transform:uppercase;padding:7px 10px;border-bottom:2px solid #e5e7eb;white-space:nowrap}
      table.pcp-bd td{padding:7px 10px;border-bottom:1px solid #f1f5f9}
      .pcp-in{border:1.5px solid #d1d5db;border-radius:7px;padding:5px 8px;font-size:.83rem;width:120px;text-align:right}
      .pcp-in:disabled{background:#f9fafb;color:#9ca3af}.pcp-in.warn{border-color:#f59e0b;background:#fffbeb}.pcp-in.err{border-color:#ef4444;background:#fff1f2}
      .pcp-cond{font-size:.68rem;padding:1px 6px;border-radius:5px;font-weight:700}.pcp-cond.ok{background:#dcfce7;color:#15803d}.pcp-cond.max{background:#fee2e2;color:#991b1b}
      .pcp-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 24px;border-top:1px solid #e5e7eb;background:#f8fafc;position:sticky;bottom:0}
      .pcp-tot{background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:10px;padding:10px 18px;display:flex;align-items:center;gap:10px;margin-right:auto}
      .pcp-tot .l{font-size:.8rem;color:#1e40af;font-weight:600}.pcp-tot .v{font-size:1.3rem;font-weight:900;color:#1e40af;font-family:monospace}
      .pcp-sel{border:1.5px solid #d1d5db;border-radius:8px;padding:7px 12px;font-size:.87rem;min-width:210px;background:#fff}.pcp-sel.req{border-color:#f59e0b;background:#fffbeb}
      .pcp-date{border:1.5px solid #d1d5db;border-radius:8px;padding:7px 12px;font-size:.87rem}
      .pcp-obs{border:1.5px solid #d1d5db;border-radius:8px;padding:7px 12px;font-size:.87rem;width:200px}
      .pcp-err{background:#fef2f2;border:1.5px solid #fca5a5;color:#991b1b;border-radius:8px;padding:8px 14px;font-size:.82rem;font-weight:600}
      .pcp-toast{position:fixed;bottom:90px;left:50%;transform:translateX(-50%);padding:11px 26px;border-radius:10px;font-size:.92rem;font-weight:700;z-index:600;display:none;box-shadow:0 8px 24px rgba(0,0,0,.25)}
      .pcp-toast.ok{background:#15803d;color:#fff}.pcp-toast.er{background:#991b1b;color:#fff}
      .pcp-ov{position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:500;display:none;align-items:center;justify-content:center;padding:16px}
      .pcp-ov.open{display:flex}
      .pcp-mbox{background:#fff;border-radius:14px;width:min(560px,100%);max-height:92vh;overflow:auto;box-shadow:0 24px 60px rgba(0,0,0,.3)}
    `;
    document.head.appendChild(st);
  }

  function toast(m, ok) {
    let t = document.getElementById('pcpToast');
    if (!t) { t = document.createElement('div'); t.id = 'pcpToast'; t.className = 'pcp-toast'; document.body.appendChild(t); }
    t.textContent = m; t.className = 'pcp-toast ' + (ok ? 'ok' : 'er'); t.style.display = 'block';
    setTimeout(() => t.style.display = 'none', 4000);
  }

  /* ── Amortización francesa ── */
  function buildSchedule(c) {
    const r = (parseFloat(c.tasa_mensual) || 0) / 100, n = parseInt(c.plazo) || 0, mf = parseFloat(c.monto_financiado) || 0;
    if (!n) return [];
    const cuota = r === 0 ? mf / n : (window.AF_RENT_CORE ? AF_RENT_CORE.cuotaFrancesa(mf, r, n) : mf * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1));
    const base = c.fecha_primera_cuota ? new Date(c.fecha_primera_cuota) : new Date();
    return Array.from({ length: n }, (_, i) => {
      const f = new Date(base); f.setMonth(f.getMonth() + i);
      return { numero: i + 1, fecha: f.toISOString().slice(0, 10), monto: Math.round(cuota) };
    });
  }

  /* ── Mora/gastos: canónico desde el backend ── */
  async function precargarCobranza(idCredito, sched) {
    S.cobranzaMap = new Map();
    try {
      const j = await (await API('/api/cobranza/calcular-cobranza-lote', {
        method: 'POST', body: JSON.stringify({ id_credito: idCredito, cuotas: sched.map(s => ({ numero: s.numero, monto: s.monto, fecha: s.fecha })) }),
      })).json();
      if (j.success && j.data?.cuotas)
        j.data.cuotas.forEach(c => S.cobranzaMap.set(c.numero, { mora: c.interes?.interes || 0, gastos: c.gasto?.gasto_pesos || 0, dias: c.dias_mora || 0 }));
    } catch (_) {}
  }
  const _cob = fechaVenc => { const s = S.schedule.find(x => x.fecha === fechaVenc); return s ? S.cobranzaMap.get(s.numero) : null; };
  function calcMora(monto, fechaVenc) {
    const c = _cob(fechaVenc); if (c) return { monto: c.mora, dias: c.dias };
    const dias = Math.max(0, Math.floor((new Date() - new Date(fechaVenc + 'T12:00:00')) / 86400000));
    return { monto: dias > 0 ? Math.round(monto * (S.tmc / 100 / 365) * dias) : 0, dias };
  }
  function calcGastos(monto, fechaVenc) {
    const c = _cob(fechaVenc); if (c) return { monto: c.gastos, dias: c.dias };
    return { monto: 0, dias: 0 };
  }

  /* ── Carga ── */
  window.PagoCuotas = {
    async montar(host, opts = {}) {
      injectCSS();
      S.host = typeof host === 'string' ? document.getElementById(host) : host;
      S.creditId = opts.creditId; S.onLoad = opts.onLoad || null;
      S.host.innerHTML = `<div style="text-align:center;padding:60px;color:#64748b"><i class="bi bi-hourglass-split" style="font-size:1.6rem"></i><div style="margin-top:8px">Cargando…</div></div>`;
      try {
        const [jC, jP, jCaja, jCu, jT, jU, jSaldo] = await Promise.all([
          API('/api/creditos/' + S.creditId).then(r => r.json()),
          API('/api/pagos-credito/' + S.creditId).then(r => r.json()),
          API('/api/cajas/mi-caja').then(r => r.json()).catch(() => ({ data: null })),
          API('/api/cuentas-bancarias').then(r => r.json()).catch(() => ({ data: [] })),
          API('/api/tasas/vigente').then(r => r.json()).catch(() => ({ data: null })),
          API('/api/uf/vigente').then(r => r.json()).catch(() => ({ data: null })),
          API('/api/cuentas-transitorias/por-credito/' + S.creditId).then(r => r.json()).catch(() => ({ data: null })),
        ]);
        if (!jC.success) throw new Error(jC.error || 'No se pudo cargar el crédito.');
        S.credito = jC.data;
        S.pagos = jP.data || [];
        S.miCaja = jCaja.data || null;
        S.cuentas = (jCu.data || []).filter(c => c.activo);
        S.tmc = jT.data?.tasa_anual_mayor || 0;
        S.ufHoy = jU.data?.valor || 0;
        S.saldoAFavor = (jSaldo.success && jSaldo.data?.saldo_total) || 0;
        S.schedule = buildSchedule(S.credito);
        await precargarCobranza(S.creditId, S.schedule);
        S.sel.clear();
        if (typeof S.onLoad === 'function') { try { S.onLoad(S.credito); } catch (_) {} }
        render();
        ensurePayPanel();
      } catch (e) {
        S.host.innerHTML = `<div style="text-align:center;padding:48px;color:#991b1b"><i class="bi bi-exclamation-triangle" style="font-size:1.6rem"></i><div style="margin-top:8px">${esc(e.message)}</div></div>`;
      }
    },
    toggle, limpiarSeleccion, abrirDetalle, cerrarDetalle, confirmar, verComprobante, cerrarComp,
    onMonto, onBreakdown,
  };

  /* ── Render tabla + stats ── */
  function render() {
    const c = S.credito;
    const pagadasList = S.pagos.filter(p => p.estado_pago === 'PAGADO');
    const pagadas = new Set(pagadasList.map(p => p.numero_cuota));
    const puede = !!S.miCaja?.puede_pagar_cuotas;
    let nPag = 0, nMora = 0, nPend = 0, moraTot = 0;

    const filas = S.schedule.map(s => {
      const esPag = pagadas.has(s.numero);
      const pago = S.pagos.find(p => p.numero_cuota === s.numero && p.estado_pago === 'PAGADO');
      const mora = esPag ? { monto: 0, dias: 0 } : calcMora(s.monto, s.fecha);
      const gastos = esPag ? { monto: 0 } : calcGastos(s.monto, s.fecha);
      const totalHoy = s.monto + mora.monto + gastos.monto;
      const enMora = !esPag && mora.dias > 0;
      if (esPag) nPag++; else if (enMora) { nMora++; moraTot += totalHoy; } else nPend++;
      const sel = S.sel.has(s.numero);
      const cls = esPag ? 'pag' : sel ? 'sel' : (enMora ? 'mora' : '');
      const pill = esPag ? `<span class="pcp-pill pag"><i class="bi bi-check-circle-fill"></i> Pagada</span>`
        : enMora ? `<span class="pcp-pill mora"><i class="bi bi-exclamation-circle-fill"></i> En mora</span>`
          : `<span class="pcp-pill al"><i class="bi bi-clock"></i> Al día</span>`;
      const chk = (!esPag && puede)
        ? `<td class="pcp-c"><input type="checkbox" class="pcp-chk" ${sel ? 'checked' : ''} onchange="PagoCuotas.toggle(${s.numero},this.checked)"></td>`
        : `<td></td>`;
      return `<tr class="${cls}" id="pcp-row-${s.numero}">
        ${chk}
        <td class="pcp-c"><strong>${s.numero}</strong></td>
        <td>${fmtFecha(s.fecha)}</td>
        <td class="pcp-r pcp-amt">${clp(s.monto)}</td>
        <td class="pcp-r pcp-amt ${enMora && mora.monto ? 'pcp-mora' : ''}">${esPag ? (Number(pago?.interes_mora) > 0 ? clp(pago.interes_mora) : '<span class="pcp-mut">—</span>') : (mora.monto ? clp(mora.monto) : '<span class="pcp-mut">—</span>')}</td>
        <td class="pcp-r pcp-amt ${enMora && gastos.monto ? 'pcp-mora' : ''}">${esPag ? (Number(pago?.gastos_cobranza) > 0 ? clp(pago.gastos_cobranza) : '<span class="pcp-mut">—</span>') : (gastos.monto ? clp(gastos.monto) : '<span class="pcp-mut">—</span>')}</td>
        <td class="pcp-r pcp-amt" style="${enMora ? 'color:#dc2626' : ''}">${esPag ? '<span class="pcp-mut">—</span>' : clp(totalHoy)}</td>
        <td class="pcp-r pcp-amt" style="color:#15803d">${pago ? clp(pago.total_pagado) : '<span class="pcp-mut">—</span>'}</td>
        <td>${pago ? fmtFecha(pago.fecha_pago || pago.created_at) : '<span class="pcp-mut">—</span>'}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            ${pill}
            ${esPag && pago ? `<button class="pcp-bcomp" onclick="PagoCuotas.verComprobante(${s.numero})"><i class="bi bi-receipt"></i> Comprobante</button>` : ''}
          </div>
        </td>
      </tr>`;
    }).join('');

    const nocaja = !puede
      ? `<div class="pcp-nocaja"><i class="bi bi-info-circle me-1"></i>${S.miCaja ? 'Tu caja no tiene permiso para cobrar cuotas.' : 'No tienes una caja asignada.'} Puedes <strong>emitir una Orden de Pago</strong> a Tesorería con el botón “Emitir ODP”.</div>`
      : '';

    S.host.innerHTML = `
      ${nocaja}
      <div class="pcp-stats">
        <div class="pcp-stat pag"><div class="l"><i class="bi bi-check-circle me-1"></i>Pagadas</div><div class="v">${nPag}/${S.schedule.length}</div></div>
        <div class="pcp-stat pend"><div class="l"><i class="bi bi-clock me-1"></i>Al día</div><div class="v">${nPend}</div></div>
        <div class="pcp-stat mora" ${nMora === 0 ? 'style="opacity:.55"' : ''}><div class="l"><i class="bi bi-exclamation-circle me-1"></i>${nMora} en mora</div><div class="v" style="font-size:1.1rem">${nMora > 0 ? clp(moraTot) : '—'}</div></div>
        <div class="pcp-stat"><div class="l"><i class="bi bi-bank me-1"></i>Financiado</div><div class="v" style="font-size:1.1rem">${clp(S.credito.monto_financiado)}</div></div>
      </div>
      <div class="pcp-card">
        <div class="pcp-head"><div class="t"><i class="bi bi-table me-1"></i>Cuadro de Pagos</div>
          <span style="font-size:.75rem;color:#6b7280">${esc(S.credito.marca || '')} ${esc(S.credito.modelo || '')} ${S.credito.anio || ''}</span></div>
        <div class="pcp-tw"><table class="pcp-tbl"><thead><tr>
          <th style="width:34px"></th><th class="pcp-c">N°</th><th>Vencimiento</th>
          <th class="pcp-r">Cuota</th><th class="pcp-r">Int. Mora</th><th class="pcp-r">Gtos. Cobr.</th>
          <th class="pcp-r">Total Hoy</th><th class="pcp-r">Total Pagado</th><th>Fecha Pago</th><th>Estado</th>
        </tr></thead><tbody>${filas}</tbody></table></div>
        ${puede ? '<p style="font-size:.75rem;color:#6b7280;padding:10px 18px;margin:0"><i class="bi bi-info-circle me-1"></i>Selecciona una o más cuotas pendientes para registrar el pago.</p>' : ''}
      </div>`;
    actualizarPanel();
  }

  /* ── Panel de pago ── */
  function ensurePayPanel() {
    if (document.getElementById('pcpPay')) return;
    const d = document.createElement('div');
    d.className = 'pcp-pay hidden'; d.id = 'pcpPay';
    d.innerHTML = `
      <div id="pcpPres" class="pcp-pres">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
          <i class="bi bi-check2-square" style="font-size:1.3rem;color:#0f2d6b"></i>
          <div><span id="pcpBadge" style="font-weight:700;font-size:.97rem;color:#111827">0 cuotas</span>
          <span style="font-size:.8rem;color:#6b7280;margin-left:10px">Total: <strong id="pcpTotR">$0</strong></span></div>
        </div>
        <button class="pcp-btn sec" onclick="PagoCuotas.limpiarSeleccion()"><i class="bi bi-x-lg"></i> Cancelar</button>
        <button class="pcp-btn go" onclick="PagoCuotas.abrirDetalle()"><i class="bi bi-cash-coin"></i> Pagar</button>
      </div>
      <div id="pcpDet" style="display:none">
        <div class="pcp-ph"><div style="font-weight:700"><i class="bi bi-cash-coin me-1"></i>Detalle del pago <span id="pcpBadge2" style="opacity:.85;font-size:.85rem"></span></div>
          <button class="pcp-btn sec" style="padding:4px 12px" onclick="PagoCuotas.cerrarDetalle()"><i class="bi bi-chevron-down"></i> Volver</button></div>
        <div class="pcp-pb">
          <div class="pcp-auto">
            <label><i class="bi bi-cash me-1"></i>Monto recibido</label>
            <input type="text" id="pcpMonto" placeholder="$0" inputmode="numeric" oninput="PagoCuotas.onMonto(this)">
            <span class="pcp-hint" id="pcpHint">Ingresa el monto recibido: se condonan primero los gastos de cobranza, luego los intereses por mora (proporcional).</span>
          </div>
          <div style="overflow-x:auto"><table class="pcp-bd">
            <thead><tr><th>N°</th><th>Venc.</th><th class="pcp-r">Cuota</th><th class="pcp-r">Gastos cobr.</th><th class="pcp-r">Int. mora</th><th class="pcp-r">Total</th></tr></thead>
            <tbody id="pcpBd"></tbody><tfoot id="pcpBdF"></tfoot>
          </table></div>
          <div id="pcpErr" style="display:none;margin-bottom:10px"></div>
        </div>
        <div class="pcp-foot">
          <div class="pcp-tot"><span class="l"><i class="bi bi-cash-coin me-1"></i>Total a cobrar</span><span class="v" id="pcpTot">$0</span></div>
          <select id="pcpOrigen" class="pcp-sel" onchange="this.classList.remove('req')">${origenOptions()}</select>
          <input type="date" id="pcpFecha" class="pcp-date">
          <input type="text" id="pcpObs" class="pcp-obs" placeholder="Observación (opcional)">
          <button class="pcp-btn go" id="pcpConf" onclick="PagoCuotas.confirmar()"><i class="bi bi-check2-circle"></i> Confirmar pago</button>
        </div>
      </div>`;
    document.body.appendChild(d);
    // Modal comprobante
    const ov = document.createElement('div'); ov.className = 'pcp-ov'; ov.id = 'pcpCompOv';
    ov.innerHTML = `<div class="pcp-mbox"><div id="pcpCompBody" style="padding:18px"></div>
      <div style="padding:12px 18px;border-top:1px solid #e5e7eb;background:#f8fafc;display:flex;justify-content:flex-end;gap:8px">
        <button class="pcp-btn sec" onclick="PagoCuotas.cerrarComp()">Cerrar</button>
        <button class="pcp-btn go" style="background:#0f2d6b" onclick="window.print()"><i class="bi bi-printer"></i> Imprimir</button></div></div>`;
    ov.addEventListener('click', e => { if (e.target === ov) PagoCuotas.cerrarComp(); });
    document.body.appendChild(ov);
  }

  function origenOptions() {
    let h = `<option value="">— Origen de fondos —</option>
      <optgroup label="Efectivo / Tarjetas / Documentos">
        <option value="Efectivo|">💵 Efectivo (al contado)</option>
        <option value="Tarjeta de Débito|">💳 Tarjeta de Débito</option>
        <option value="Tarjeta de Crédito|">💳 Tarjeta de Crédito</option>
        <option value="Cheque|">📋 Cheque</option>
        <option value="Vale Vista|">🏦 Vale Vista</option>
      </optgroup>`;
    if (S.cuentas.length) {
      h += `<optgroup label="Transferencia / Depósito">`;
      S.cuentas.forEach(c => {
        const banco = c.banco || c.razon_social || 'Cuenta'; const tipo = c.tipo_cuenta ? ` (${c.tipo_cuenta})` : '';
        h += `<option value="Transferencia ${esc(banco)}|${c.id_cuenta}">🏛 ${esc(banco)}${esc(tipo)} — ${esc(c.numero_cuenta || '')}</option>`;
      });
      h += `</optgroup>`;
    }
    return h;
  }

  function toggle(n, ch) { if (ch) S.sel.add(n); else S.sel.delete(n); const r = document.getElementById('pcp-row-' + n); if (r) r.classList.toggle('sel', ch); actualizarPanel(); }
  function limpiarSeleccion() {
    S.sel.clear();
    const p = document.getElementById('pcpPay'); if (p) p.classList.add('hidden');
    const pr = document.getElementById('pcpPres'), de = document.getElementById('pcpDet');
    if (pr) pr.style.display = 'flex'; if (de) de.style.display = 'none';
    document.querySelectorAll('.pcp-chk').forEach(c => c.checked = false);
    document.querySelectorAll('tr.sel').forEach(r => r.classList.remove('sel'));
  }
  function actualizarPanel() {
    const p = document.getElementById('pcpPay'); if (!p) return;
    if (S.sel.size === 0) { p.classList.add('hidden'); return; }
    let total = 0;
    S.sel.forEach(n => { const s = S.schedule.find(x => x.numero === n); if (s) total += s.monto + calcMora(s.monto, s.fecha).monto + calcGastos(s.monto, s.fecha).monto; });
    document.getElementById('pcpBadge').textContent = `${S.sel.size} cuota${S.sel.size !== 1 ? 's' : ''} seleccionada${S.sel.size !== 1 ? 's' : ''}`;
    document.getElementById('pcpTotR').textContent = clp(total);
    p.classList.remove('hidden');
    if (document.getElementById('pcpDet').style.display !== 'none') { document.getElementById('pcpBadge2').textContent = '· ' + document.getElementById('pcpBadge').textContent; renderBreakdown(); }
  }

  function datosSel() {
    return [...S.sel].sort((a, b) => a - b).map(n => {
      const s = S.schedule.find(x => x.numero === n);
      const mora = calcMora(s.monto, s.fecha).monto, gastos = calcGastos(s.monto, s.fecha).monto;
      const moraMin = S.miCaja?.puede_condonar_intereses ? Math.round(mora * (1 - (S.miCaja.tope_intereses || 0) / 100)) : mora;
      const gastosMin = S.miCaja?.puede_condonar_gastos ? Math.round(gastos * (1 - (S.miCaja.tope_gastos || 0) / 100)) : gastos;
      return { n, s, mora, gastos, moraMin, gastosMin };
    });
  }

  function abrirDetalle() {
    document.getElementById('pcpPres').style.display = 'none';
    document.getElementById('pcpDet').style.display = '';
    document.getElementById('pcpBadge2').textContent = '· ' + document.getElementById('pcpBadge').textContent;
    document.getElementById('pcpFecha').value = new Date().toISOString().slice(0, 10);
    document.getElementById('pcpMonto').value = '';
    document.getElementById('pcpHint').textContent = 'Ingresa el monto recibido: se condonan primero los gastos de cobranza, luego los intereses por mora (proporcional).';
    showErr(''); renderBreakdown();
  }
  function cerrarDetalle() { document.getElementById('pcpDet').style.display = 'none'; document.getElementById('pcpPres').style.display = 'flex'; }

  /* ── Pesos en inputs ── */
  function onPeso(el, cb) {
    const raw = el.value.replace(/[^\d]/g, ''); const n = parseInt(raw, 10) || 0;
    el.value = raw === '' ? '' : '$' + n.toLocaleString('es-CL'); el.dataset.raw = n;
    if (cb) cb();
  }
  function getPeso(el) { if (!el) return 0; if (el.dataset.raw !== undefined) return parseInt(el.dataset.raw, 10) || 0; return parseInt(String(el.value).replace(/[^\d]/g, ''), 10) || 0; }

  function renderBreakdown(gOv = {}, mOv = {}) {
    const datos = datosSel(); let sB = 0, sG = 0, sM = 0, sGc = 0, sMc = 0;
    const filas = datos.map(d => {
      const g = gOv[d.n] !== undefined ? gOv[d.n] : d.gastos;
      const m = mOv[d.n] !== undefined ? mOv[d.n] : d.mora;
      const total = d.s.monto + g + m; sB += d.s.monto; sG += g; sM += m;
      const gCond = d.gastos - g, mCond = d.mora - m;
      sGc += Math.max(0, gCond); sMc += Math.max(0, mCond);
      const gCls = g < d.gastosMin ? 'err' : g < d.gastos ? 'warn' : '';
      const mCls = m < d.moraMin ? 'err' : m < d.mora ? 'warn' : '';
      const gPct = d.gastos > 0 ? Math.round(gCond / d.gastos * 100) : 0;
      const mPct = d.mora   > 0 ? Math.round(mCond / d.mora   * 100) : 0;
      const gB = gCond > 0 ? `<span class="pcp-cond ${gCls ? 'max' : 'ok'}" title="Condonación">-${clp(gCond)} (${gPct}%)</span>` : '';
      const mB = mCond > 0 ? `<span class="pcp-cond ${mCls ? 'max' : 'ok'}" title="Condonación">-${clp(mCond)} (${mPct}%)</span>` : '';
      return `<tr>
        <td><strong>N°${d.n}</strong></td><td style="color:#6b7280;font-size:.78rem">${fmtFecha(d.s.fecha)}</td>
        <td class="pcp-r pcp-amt">${clp(d.s.monto)}</td>
        <td class="pcp-r"><input type="text" inputmode="numeric" class="pcp-in ${gCls}" id="pcpg_${d.n}" value="${g > 0 ? '$' + Math.round(g).toLocaleString('es-CL') : '$0'}" data-raw="${Math.round(g)}" ${d.gastos === 0 ? 'disabled' : (!S.miCaja?.puede_condonar_gastos ? 'readonly' : '')} oninput="PagoCuotas.onBreakdown(this)"> ${gB}</td>
        <td class="pcp-r"><input type="text" inputmode="numeric" class="pcp-in ${mCls}" id="pcpm_${d.n}" value="${m > 0 ? '$' + Math.round(m).toLocaleString('es-CL') : '$0'}" data-raw="${Math.round(m)}" ${d.mora === 0 ? 'disabled' : (!S.miCaja?.puede_condonar_intereses ? 'readonly' : '')} oninput="PagoCuotas.onBreakdown(this)"> ${mB}</td>
        <td class="pcp-r pcp-amt" style="font-weight:800" id="pcpt_${d.n}">${clp(total)}</td></tr>`;
    }).join('');
    document.getElementById('pcpBd').innerHTML = filas;
    pintarFooter(datos.length, sB, sG, sM, sGc, sMc);
  }

  // Fila TOTAL del desglose: N° de cuotas, cuota base, gastos (cobrado + condonado),
  // intereses (cobrado + condonado) y total.
  function pintarFooter(n, sB, sG, sM, sGc, sMc) {
    const tg = sB + sG + sM;
    const cd = v => v > 0 ? `<br><span style="font-size:.72rem;color:#15803d;font-weight:700">-${clp(v)} cond.</span>` : '';
    document.getElementById('pcpBdF').innerHTML = `<tr style="border-top:2px solid #e5e7eb;background:#f8fafc">
      <td style="font-weight:700;padding:8px 10px;font-size:.8rem;color:#374151">TOTAL</td>
      <td style="font-weight:700;padding:8px 10px;font-size:.78rem;color:#6b7280">${n} cuota${n !== 1 ? 's' : ''}</td>
      <td class="pcp-r pcp-amt">${clp(sB)}</td>
      <td class="pcp-r pcp-amt">${clp(sG)}${cd(sGc)}</td>
      <td class="pcp-r pcp-amt">${clp(sM)}${cd(sMc)}</td>
      <td class="pcp-r pcp-amt" style="font-weight:900;color:#0f2d6b">${clp(tg)}</td></tr>`;
    document.getElementById('pcpTot').textContent = clp(tg);
  }

  function onBreakdown(el) { onPeso(el); recalcBreakdown(); }
  function recalcBreakdown() {
    let hasErr = false; const datos = datosSel();
    let sB = 0, sG = 0, sM = 0, sGc = 0, sMc = 0;
    datos.forEach(d => {
      const g = getPeso(document.getElementById('pcpg_' + d.n)); const m = getPeso(document.getElementById('pcpm_' + d.n));
      sB += d.s.monto; sG += g; sM += m; sGc += Math.max(0, d.gastos - g); sMc += Math.max(0, d.mora - m);
      const te = document.getElementById('pcpt_' + d.n); if (te) te.textContent = clp(d.s.monto + g + m);
      if (g < d.gastosMin || m < d.moraMin) hasErr = true;
    });
    pintarFooter(datos.length, sB, sG, sM, sGc, sMc);
    showErr(hasErr ? 'La condonación supera el límite permitido en una o más cuotas.' : '');
  }

  function onMonto(el) { onPeso(el); autoAjustar(); }
  // Condona gastos primero, luego intereses, SIEMPRE dentro de las atribuciones de
  // la caja (no baja de gastosMin/moraMin). Si el monto exige condonar más de lo
  // permitido, avisa (requiere atribución mayor).
  function autoAjustar() {
    const T = getPeso(document.getElementById('pcpMonto')) + S.saldoAFavor;
    const datos = datosSel(); if (!datos.length) return;
    const sB = datos.reduce((a, d) => a + d.s.monto, 0);
    const sG = datos.reduce((a, d) => a + d.gastos, 0), sM = datos.reduce((a, d) => a + d.mora, 0);
    const sGmin = datos.reduce((a, d) => a + d.gastosMin, 0), sMmin = datos.reduce((a, d) => a + d.moraMin, 0);
    const maxTotal = sB + sG + sM, minTotal = sB + sGmin + sMmin;
    if (T === 0) { renderBreakdown(); return; }
    if (T < sB) { showErr(`Monto insuficiente. El mínimo es ${clp(sB)} (solo cuotas base, sin gastos ni mora).`); renderBreakdown({}, {}); return; }
    if (T < minTotal - 0.5) {
      showErr(`El monto recibido exige condonar ${clp(maxTotal - T)}, pero tu atribución permite condonar hasta ${clp(maxTotal - minTotal)} (mínimo a cobrar ${clp(minTotal)}). Se requiere una atribución mayor.`);
      const gOv = {}, mOv = {}; datos.forEach(d => { gOv[d.n] = d.gastosMin; mOv[d.n] = d.moraMin; });
      renderBreakdown(gOv, mOv); return;
    }
    showErr('');
    const cond = Math.max(0, maxTotal - T);
    const gMax = sG - sGmin, mMax = sM - sMmin;
    const gCondT = Math.min(cond, gMax), mCondT = Math.min(cond - gCondT, mMax);
    const gOv = {}, mOv = {};
    datos.forEach(d => {
      const gShare = gMax > 0 ? Math.round((d.gastos - d.gastosMin) * gCondT / gMax) : 0;
      gOv[d.n] = Math.max(d.gastosMin, d.gastos - gShare);
      const mShare = mMax > 0 ? Math.round((d.mora - d.moraMin) * mCondT / mMax) : 0;
      mOv[d.n] = Math.max(d.moraMin, d.mora - mShare);
    });
    const condReal = (sG - datos.reduce((a, d) => a + gOv[d.n], 0)) + (sM - datos.reduce((a, d) => a + mOv[d.n], 0));
    const exc = T - maxTotal;
    document.getElementById('pcpHint').textContent = condReal > 0
      ? `Se condona ${clp(condReal)} (dentro de tus atribuciones): gastos de cobranza primero, luego intereses por mora.`
      : exc > 0 ? `Se cobrará el total. El excedente de ${clp(exc)} quedará como Saldo a Favor.` : 'Se cobrará el total sin condonación.';
    renderBreakdown(gOv, mOv);
  }

  function showErr(m) { const e = document.getElementById('pcpErr'); if (!e) return; if (m) { e.style.display = ''; e.innerHTML = `<div class="pcp-err"><i class="bi bi-exclamation-triangle-fill"></i> ${esc(m)}</div>`; } else e.style.display = 'none'; }

  async function confirmar() {
    const datos = datosSel(); const fecha = document.getElementById('pcpFecha').value;
    const obs = document.getElementById('pcpObs').value.trim();
    const origenVal = document.getElementById('pcpOrigen').value;
    if (!origenVal) { document.getElementById('pcpOrigen').classList.add('req'); return showErr('Selecciona el origen de fondos.'); }
    const [origenLabel, cuentaId] = origenVal.split('|');
    if (!fecha) return showErr('Selecciona la fecha de pago.');
    const det = datos.map(d => ({ d, g: getPeso(document.getElementById('pcpg_' + d.n)), m: getPeso(document.getElementById('pcpm_' + d.n)) }));
    for (const p of det) {
      if (p.g < p.d.gastosMin) return showErr(`Cuota N°${p.d.n}: los gastos no pueden ser menores a ${clp(p.d.gastosMin)}.`);
      if (p.m < p.d.moraMin) return showErr(`Cuota N°${p.d.n}: la mora no puede ser menor a ${clp(p.d.moraMin)}.`);
    }
    showErr(''); const btn = document.getElementById('pcpConf'); btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Registrando…';
    try {
      const body = {
        id_credito: S.credito.id_credito, monto_recibido: getPeso(document.getElementById('pcpMonto')),
        fecha_pago: fecha, observacion: obs || null, id_caja: S.miCaja?.id_caja || null,
        origen_fondos: origenLabel || null, id_cuenta_bancaria: cuentaId ? parseInt(cuentaId) : null,
        pagos: det.map(p => ({
          numero_cuota: p.d.n, fecha_vencimiento: p.d.s.fecha, monto_cuota: Math.round(p.d.s.monto),
          interes_mora: Math.round(p.m), gastos_cobranza: Math.round(p.g),
          interes_mora_total: Math.round(p.d.mora), gastos_cobranza_total: Math.round(p.d.gastos),
          total_pagado: Math.round(p.d.s.monto + p.m + p.g),
        })),
      };
      const j = await (await API('/api/pagos-credito/batch', { method: 'POST', body: JSON.stringify(body) })).json();
      if (!j.success) throw new Error(j.error);
      const trx = String(j.data.numero_transaccion).padStart(6, '0');
      toast(`✓ Pago registrado — TRX-${trx}${j.data.transitoria ? ' · saldo a favor ' + clp(j.data.transitoria.monto) : ''}`, true);
      // refrescar
      const jp = await (await API('/api/pagos-credito/' + S.credito.id_credito)).json();
      S.pagos = jp.data || [];
      const js = await (await API('/api/cuentas-transitorias/por-credito/' + S.credito.id_credito)).json().catch(() => ({}));
      S.saldoAFavor = (js.success && js.data?.saldo_total) || 0;
      limpiarSeleccion(); render();
    } catch (e) { showErr(e.message); }
    finally { btn.disabled = false; btn.innerHTML = '<i class="bi bi-check2-circle"></i> Confirmar pago'; }
  }

  function verComprobante(numeroCuota) {
    const ref = S.pagos.find(p => p.numero_cuota === numeroCuota); if (!ref) return;
    const trx = ref.numero_transaccion || null;
    const grupo = (trx ? S.pagos.filter(p => p.numero_transaccion === trx) : [ref]).sort((a, b) => a.numero_cuota - b.numero_cuota);
    let html;
    try { html = (typeof buildRecibo === 'function') ? buildRecibo({ credito: S.credito, pagos: grupo, cajaNombre: S.miCaja?.nombre_caja || null, trxNum: trx, idPago: ref.id_pago }) : reciboSimple(grupo, trx); }
    catch (_) { html = reciboSimple(grupo, trx); }
    document.getElementById('pcpCompBody').innerHTML = html;
    document.getElementById('pcpCompOv').classList.add('open');
  }
  function reciboSimple(grupo, trx) {
    const filas = grupo.map(p => `<tr><td style="padding:4px 8px">N°${p.numero_cuota}</td><td style="padding:4px 8px;text-align:right">${clp(p.total_pagado)}</td></tr>`).join('');
    const tot = grupo.reduce((s, p) => s + Number(p.total_pagado || 0), 0);
    return `<h3 style="margin:0 0 8px;color:#0f2d6b">Comprobante de Pago${trx ? ' · TRX-' + String(trx).padStart(6, '0') : ''}</h3>
      <div style="color:#64748b;font-size:.85rem;margin-bottom:10px">${esc(S.credito.nombre_cliente || '')} · ${fmtRut(S.credito.rut_cliente)}</div>
      <table style="width:100%;border-collapse:collapse;font-size:.88rem"><tbody>${filas}</tbody></table>
      <div style="margin-top:10px;text-align:right;font-weight:900;color:#0f2d6b">TOTAL ${clp(tot)}</div>`;
  }
  function cerrarComp() { document.getElementById('pcpCompOv').classList.remove('open'); }
})();
