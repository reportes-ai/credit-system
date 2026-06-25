/* ─────────────────────────────────────────────────────────────────────────────
   ODP de Cuotas — modal de emisión reutilizable (sin dependencias).
   Uso:
     <script src="/js/odp-emitir.js"></script>
     ODP.abrir(idCredito, { preCuotas?: [...], onDone?: fn });

   `preCuotas` (opcional) son las cuotas ya seleccionadas en otra pantalla
   (ej. /tesoreria/caja): [{ numero_cuota, fecha_vencimiento, monto_cuota,
   interes_mora, gastos_cobranza, total_pagado }]. Si no se pasan, el modal
   carga el calendario del crédito y deja elegir con checkboxes.
   POST → /api/odp-cuotas  (estado PENDIENTE → cola de Tesorería).
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.ODP) return; // evita doble carga

  const token = () => sessionStorage.getItem('token');
  const API = (path, opts = {}) =>
    fetch(path, { headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' }, ...opts });
  const clp = v => '$' + Math.round(Number(v) || 0).toLocaleString('es-CL');
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtFecha = f => { if (!f) return '—'; try { return new Date(f).toLocaleDateString('es-CL', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '—'; } };
  const fmtRut = v => { v = String(v || '').replace(/[^0-9kK]/g, '').toUpperCase(); if (v.length < 2) return String(v || ''); const dv = v.slice(-1); return v.slice(0, -1).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + dv; };

  let _modalEl = null;
  let _state = { credito: null, cuotas: [], cuentas: [], sel: new Set(), onDone: null, busy: false };

  /* ── Estilos (una sola vez) ── */
  function injectStyles() {
    if (document.getElementById('odp-styles')) return;
    const s = document.createElement('style');
    s.id = 'odp-styles';
    s.textContent = `
      .odp-overlay{position:fixed;inset:0;background:rgba(15,23,42,.6);z-index:9000;display:none;align-items:center;justify-content:center;padding:16px}
      .odp-overlay.open{display:flex}
      .odp-box{background:#fff;border-radius:16px;width:min(760px,100%);max-height:92vh;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.3);overflow:hidden;font-family:'Segoe UI',system-ui,sans-serif}
      .odp-head{background:linear-gradient(135deg,#012d70,#0141A2 55%,#0255c5);color:#fff;padding:16px 22px;display:flex;align-items:center;justify-content:space-between;gap:10px}
      .odp-head h5{margin:0;font-size:1rem;font-weight:800;display:flex;align-items:center;gap:8px}
      .odp-head .odp-sub{font-size:.8rem;opacity:.85;margin-top:2px}
      .odp-x{background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:1rem;line-height:1}
      .odp-body{padding:18px 22px;overflow-y:auto}
      .odp-tbl{width:100%;border-collapse:collapse;font-size:.83rem}
      .odp-tbl th{background:#f1f5f9;color:#374151;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;padding:8px 10px;border-bottom:2px solid #e5e7eb;white-space:nowrap}
      .odp-tbl td{padding:7px 10px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
      .odp-tbl tr.sel td{background:#eff6ff}
      .odp-r{text-align:right} .odp-c{text-align:center}
      .odp-amt{font-family:monospace;font-weight:700}
      .odp-mora{color:#dc2626}
      .odp-chk{width:17px;height:17px;cursor:pointer;accent-color:#0141A2}
      .odp-field{display:flex;flex-direction:column;gap:4px}
      .odp-label{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:#64748b}
      .odp-input,.odp-select{border:1.5px solid #d1d5db;border-radius:8px;padding:8px 11px;font-size:.88rem;font-family:inherit;width:100%;background:#fff}
      .odp-input:focus,.odp-select:focus{outline:none;border-color:#0141A2;box-shadow:0 0 0 3px rgba(1,65,162,.1)}
      .odp-select.req{border-color:#f59e0b;background:#fffbeb}
      .odp-foot{padding:14px 22px;border-top:1px solid #e5e7eb;background:#f8fafc;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
      .odp-total{background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:10px;padding:9px 16px;margin-right:auto}
      .odp-total .l{font-size:.72rem;color:#1e40af;font-weight:700;text-transform:uppercase}
      .odp-total .v{font-size:1.25rem;font-weight:900;color:#1e40af;font-family:monospace}
      .odp-btn{border:none;border-radius:9px;padding:10px 22px;font-size:.9rem;font-weight:800;cursor:pointer;display:flex;align-items:center;gap:7px}
      .odp-btn.go{background:linear-gradient(135deg,#0141A2,#0255c5);color:#fff}
      .odp-btn.go:disabled{opacity:.55;cursor:default}
      .odp-btn.cancel{background:#eef2f7;color:#334155}
      .odp-err{background:#fef2f2;border:1.5px solid #fca5a5;color:#991b1b;border-radius:8px;padding:8px 14px;font-size:.82rem;font-weight:600;width:100%;display:none}
      .odp-note{font-size:.78rem;color:#64748b;margin:0 0 10px}
      .odp-toast{position:fixed;bottom:26px;left:50%;transform:translateX(-50%);padding:11px 26px;border-radius:10px;font-size:.92rem;font-weight:700;z-index:9100;display:none;box-shadow:0 8px 24px rgba(0,0,0,.25)}
      .odp-toast.ok{background:#15803d;color:#fff}.odp-toast.err{background:#991b1b;color:#fff}
      @media(max-width:640px){.odp-foot{flex-direction:column;align-items:stretch}.odp-total{margin-right:0}}
    `;
    document.head.appendChild(s);
  }

  function ensureModal() {
    if (_modalEl) return _modalEl;
    injectStyles();
    const ov = document.createElement('div');
    ov.className = 'odp-overlay';
    ov.id = 'odpOverlay';
    ov.innerHTML = `
      <div class="odp-box">
        <div class="odp-head">
          <div>
            <h5><i class="bi bi-cash-stack"></i>Emitir Orden de Pago de Cuotas</h5>
            <div class="odp-sub" id="odpSub">—</div>
          </div>
          <button class="odp-x" onclick="ODP.cerrar()" title="Cerrar">&times;</button>
        </div>
        <div class="odp-body" id="odpBody"></div>
        <div class="odp-foot">
          <div class="odp-err" id="odpErr"></div>
          <div class="odp-total"><div class="l">Total a solicitar</div><div class="v" id="odpTotal">$0</div></div>
          <button class="odp-btn cancel" onclick="ODP.cerrar()">Cancelar</button>
          <button class="odp-btn go" id="odpGo" onclick="ODP.enviar()"><i class="bi bi-send"></i>Emitir ODP</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    let toast = document.createElement('div');
    toast.className = 'odp-toast'; toast.id = 'odpToast';
    document.body.appendChild(toast);
    ov.addEventListener('click', e => { if (e.target === ov) ODP.cerrar(); });
    _modalEl = ov;
    return ov;
  }

  function toast(msg, ok) {
    const t = document.getElementById('odpToast');
    t.textContent = msg; t.className = 'odp-toast ' + (ok ? 'ok' : 'err');
    t.style.display = 'block'; setTimeout(() => t.style.display = 'none', 3500);
  }
  function showErr(msg) {
    const e = document.getElementById('odpErr');
    if (msg) { e.style.display = 'block'; e.textContent = msg; } else { e.style.display = 'none'; }
  }

  /* ── Amortización francesa (consistente con /tesoreria/caja y /pagar-cuotas) ── */
  function buildSchedule(c) {
    const r = (parseFloat(c.tasa_mensual) || 0) / 100, n = parseInt(c.plazo) || 0, mf = parseFloat(c.monto_financiado) || 0;
    if (!n) return [];
    const cuota = r === 0 ? mf / n : mf * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
    const base = c.fecha_primera_cuota ? new Date(c.fecha_primera_cuota) : new Date();
    let saldo = mf;
    return Array.from({ length: n }, (_, i) => {
      const interes = saldo * r, capital = cuota - interes;
      const f = new Date(base); f.setMonth(f.getMonth() + i);
      saldo -= capital;
      return { numero: i + 1, fecha: f.toISOString().slice(0, 10), monto: Math.round(cuota) };
    });
  }

  /* ── Origen de fondos: opciones (estáticas + transferencia por cuenta) ── */
  function origenOptions(cuentas) {
    let html = `<option value="">— Origen de fondos —</option>
      <optgroup label="Efectivo / Tarjetas / Documentos">
        <option value="Efectivo|">💵 Efectivo (al contado)</option>
        <option value="Tarjeta de Débito|">💳 Tarjeta de Débito</option>
        <option value="Tarjeta de Crédito|">💳 Tarjeta de Crédito</option>
        <option value="Cheque|">📋 Cheque</option>
        <option value="Vale Vista|">🏦 Vale Vista</option>
      </optgroup>`;
    const act = (cuentas || []).filter(c => c.activo);
    if (act.length) {
      html += `<optgroup label="Transferencia / Depósito">`;
      act.forEach(c => {
        const banco = c.banco || c.razon_social || 'Cuenta';
        const tipo = c.tipo_cuenta ? ` (${c.tipo_cuenta})` : '';
        html += `<option value="Transferencia ${esc(banco)}|${c.id_cuenta}">🏛 ${esc(banco)}${esc(tipo)} — ${esc(c.numero_cuenta || '')}</option>`;
      });
      html += `</optgroup>`;
    }
    return html;
  }

  /* ── Render del cuerpo del modal ── */
  function render() {
    const c = _state.credito;
    document.getElementById('odpSub').textContent =
      `${c.nombre_cliente || '—'} · N° ${c.numero_credito || c.id_credito} · ${fmtRut(c.rut_cliente)}`;

    const filas = _state.cuotas.map(q => {
      const sel = _state.sel.has(q.numero_cuota);
      return `<tr class="${sel ? 'sel' : ''}" id="odp-row-${q.numero_cuota}">
        <td class="odp-c"><input type="checkbox" class="odp-chk" ${sel ? 'checked' : ''} onchange="ODP.toggle(${q.numero_cuota},this.checked)"></td>
        <td class="odp-c"><strong>${q.numero_cuota}</strong></td>
        <td>${fmtFecha(q.fecha_vencimiento)}</td>
        <td class="odp-r odp-amt">${clp(q.monto_cuota)}</td>
        <td class="odp-r odp-amt ${q.interes_mora ? 'odp-mora' : ''}">${q.interes_mora ? clp(q.interes_mora) : '—'}</td>
        <td class="odp-r odp-amt ${q.gastos_cobranza ? 'odp-mora' : ''}">${q.gastos_cobranza ? clp(q.gastos_cobranza) : '—'}</td>
        <td class="odp-r odp-amt">${clp(q.total_pagado)}</td>
      </tr>`;
    }).join('');

    document.getElementById('odpBody').innerHTML = `
      <p class="odp-note"><i class="bi bi-info-circle"></i> Selecciona las cuotas a incluir. La ODP queda <strong>pendiente</strong> hasta que Tesorería la apruebe; al aprobarla se registra el pago y se envía el comprobante al cliente.</p>
      <div style="overflow-x:auto;border:1px solid #eef2f7;border-radius:10px">
        <table class="odp-tbl">
          <thead><tr>
            <th class="odp-c" style="width:34px"></th>
            <th class="odp-c">N°</th><th>Vencimiento</th>
            <th class="odp-r">Cuota</th><th class="odp-r">Int. Mora</th>
            <th class="odp-r">Gtos. Cobr.</th><th class="odp-r">Total</th>
          </tr></thead>
          <tbody>${filas || `<tr><td colspan="7" class="odp-c" style="padding:24px;color:#64748b">Sin cuotas pendientes.</td></tr>`}</tbody>
        </table>
      </div>
      <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:12px;margin-top:16px">
        <div class="odp-field">
          <span class="odp-label">Origen de fondos</span>
          <select class="odp-select" id="odpOrigen">${origenOptions(_state.cuentas)}</select>
        </div>
        <div class="odp-field">
          <span class="odp-label">Fecha de pago</span>
          <input type="date" class="odp-input" id="odpFecha" value="${new Date().toISOString().slice(0,10)}">
        </div>
        <div class="odp-field" style="grid-column:1/-1">
          <span class="odp-label">Observación (opcional)</span>
          <input type="text" class="odp-input" id="odpObs" placeholder="Ej: cliente pagará por transferencia el viernes…">
        </div>
      </div>`;
    recalc();
  }

  function recalc() {
    let total = 0;
    _state.cuotas.forEach(q => { if (_state.sel.has(q.numero_cuota)) total += q.total_pagado; });
    document.getElementById('odpTotal').textContent = clp(total);
    const go = document.getElementById('odpGo');
    if (go) go.disabled = _state.sel.size === 0 || _state.busy;
  }

  /* ── API pública ── */
  window.ODP = {
    async abrir(idCredito, opts = {}) {
      ensureModal();
      _state = { credito: null, cuotas: [], cuentas: [], sel: new Set(), onDone: opts.onDone || null, busy: false };
      document.getElementById('odpBody').innerHTML =
        `<div style="text-align:center;padding:48px;color:#64748b"><i class="bi bi-hourglass-split" style="font-size:1.6rem"></i><div style="margin-top:8px">Cargando crédito…</div></div>`;
      document.getElementById('odpSub').textContent = '—';
      showErr(''); document.getElementById('odpTotal').textContent = '$0';
      _modalEl.classList.add('open');

      try {
        const [jC, jP, jCu] = await Promise.all([
          API('/api/creditos/' + idCredito).then(r => r.json()),
          API('/api/pagos-credito/' + idCredito).then(r => r.json()),
          API('/api/cuentas-bancarias').then(r => r.json()).catch(() => ({ data: [] })),
        ]);
        if (!jC.success) throw new Error(jC.error || 'No se pudo cargar el crédito.');
        _state.credito = jC.data;
        _state.cuentas = jCu.data || [];
        const pagados = new Set((jP.data || []).filter(p => p.estado_pago === 'PAGADO').map(p => p.numero_cuota));

        // Cuotas candidatas = pendientes del calendario francés
        const sched = buildSchedule(_state.credito).filter(s => !pagados.has(s.numero));

        // Mora + gastos desde el backend (paramétrico). Fallback: 0.
        let cob = new Map();
        try {
          const jb = await (await API('/api/cobranza/calcular-cobranza-lote', {
            method: 'POST',
            body: JSON.stringify({ id_credito: idCredito, cuotas: sched.map(s => ({ numero: s.numero, monto: s.monto, fecha: s.fecha })) }),
          })).json();
          if (jb.success && jb.data?.cuotas)
            jb.data.cuotas.forEach(c => cob.set(c.numero, { mora: c.interes?.interes || 0, gastos: c.gasto?.gasto_pesos || 0 }));
        } catch (_) {}

        _state.cuotas = sched.map(s => {
          const k = cob.get(s.numero) || { mora: 0, gastos: 0 };
          return {
            numero_cuota: s.numero, fecha_vencimiento: s.fecha, monto_cuota: s.monto,
            interes_mora: Math.round(k.mora), gastos_cobranza: Math.round(k.gastos),
            total_pagado: Math.round(s.monto + k.mora + k.gastos),
          };
        });

        // Preselección desde otra pantalla (caja): respeta sus montos exactos
        if (Array.isArray(opts.preCuotas) && opts.preCuotas.length) {
          const byNum = new Map(_state.cuotas.map(q => [q.numero_cuota, q]));
          opts.preCuotas.forEach(p => {
            const n = parseInt(p.numero_cuota);
            const monto = Math.round(parseFloat(p.monto_cuota) || 0);
            const mora = Math.round(parseFloat(p.interes_mora) || 0);
            const gastos = Math.round(parseFloat(p.gastos_cobranza) || 0);
            const total = Math.round(parseFloat(p.total_pagado) || (monto + mora + gastos));
            byNum.set(n, { numero_cuota: n, fecha_vencimiento: p.fecha_vencimiento || (byNum.get(n)?.fecha_vencimiento) || null, monto_cuota: monto, interes_mora: mora, gastos_cobranza: gastos, total_pagado: total });
            _state.sel.add(n);
          });
          // reordena por número
          _state.cuotas = [...byNum.values()].sort((a, b) => a.numero_cuota - b.numero_cuota);
        }

        render();
      } catch (e) {
        document.getElementById('odpBody').innerHTML =
          `<div style="text-align:center;padding:40px;color:#991b1b"><i class="bi bi-exclamation-triangle" style="font-size:1.6rem"></i><div style="margin-top:8px">${esc(e.message)}</div></div>`;
      }
    },

    toggle(numero, checked) {
      if (checked) _state.sel.add(numero); else _state.sel.delete(numero);
      const row = document.getElementById('odp-row-' + numero);
      if (row) row.classList.toggle('sel', checked);
      recalc();
    },

    cerrar() { if (_modalEl) _modalEl.classList.remove('open'); },

    async enviar() {
      if (_state.busy) return;
      showErr('');
      const origenEl = document.getElementById('odpOrigen');
      const origenVal = origenEl ? origenEl.value : '';
      if (_state.sel.size === 0) return showErr('Selecciona al menos una cuota.');
      if (!origenVal) { if (origenEl) origenEl.classList.add('req'); return showErr('Selecciona el origen de fondos.'); }
      const [origenLabel, cuentaId] = origenVal.split('|');
      const fecha = document.getElementById('odpFecha')?.value || null;
      const obs = (document.getElementById('odpObs')?.value || '').trim();

      const cuotas = _state.cuotas.filter(q => _state.sel.has(q.numero_cuota));
      _state.busy = true;
      const go = document.getElementById('odpGo');
      go.disabled = true; go.innerHTML = '<i class="bi bi-hourglass-split"></i>Emitiendo…';
      try {
        const j = await (await API('/api/odp-cuotas', {
          method: 'POST',
          body: JSON.stringify({
            id_credito: _state.credito.id_credito,
            origen_fondos: origenLabel || null,
            id_cuenta_bancaria: cuentaId ? parseInt(cuentaId) : null,
            fecha_pago: fecha, observacion: obs || null,
            cuotas: cuotas.map(q => ({
              numero_cuota: q.numero_cuota, fecha_vencimiento: q.fecha_vencimiento,
              monto_cuota: q.monto_cuota, interes_mora: q.interes_mora,
              gastos_cobranza: q.gastos_cobranza, total_pagado: q.total_pagado,
            })),
          }),
        })).json();
        if (!j.success) throw new Error(j.error || 'No se pudo emitir la ODP.');
        this.cerrar();
        toast(`✓ ODP #${j.data.id_odp} emitida — ${cuotas.length} cuota(s), ${clp(j.data.monto_total)}. En cola de Tesorería.`, true);
        if (typeof _state.onDone === 'function') { try { _state.onDone(j.data); } catch (_) {} }
      } catch (e) {
        showErr(e.message);
      } finally {
        _state.busy = false;
        go.disabled = false; go.innerHTML = '<i class="bi bi-send"></i>Emitir ODP';
      }
    },
  };
})();
