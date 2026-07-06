'use strict';
/* ── Simulador Rápido de Cuotas (popup reutilizable) ──────────────────────────
   Un monto a financiar → opciones 12/24/36/48 meses con cuota y CAE.
   El cálculo es 100% server-side (motor único shared/cotizador.js); este
   componente solo pinta. Uso:
     AF_SIM_RAPIDO.abrir({ url: '/api/cotizaciones/simulador-rapido', token: '...' })
   (portal dealer usa url '/api/portal-dealer/simulador' con su JWT de dealer) */
(function () {
  const fmt = n => '$' + Math.round(n).toLocaleString('es-CL');
  const PLAZOS = {
    12: { bg: 'linear-gradient(135deg,#059669,#10b981)', badge: 'Corto Plazo' },
    24: { bg: 'linear-gradient(135deg,#1d4ed8,#3b82f6)', badge: 'Recomendado' },
    36: { bg: 'linear-gradient(135deg,#7c3aed,#a78bfa)', badge: 'Cuota Baja' },
    48: { bg: 'linear-gradient(135deg,#d97706,#f59e0b)', badge: 'Más Plazo' },
  };

  const CSS = `
  #afsim-dlg { border:none; border-radius:20px; padding:0; width:min(760px,96vw); max-height:96vh; box-shadow:0 30px 80px rgba(0,0,0,.45); }
  #afsim-dlg::backdrop { background:rgba(10,18,38,.6); backdrop-filter:blur(3px); }
  .afsim-body { background:linear-gradient(160deg,#4f5bd5,#6d5bd0 55%,#7b5fc9); padding:14px 16px 16px; font-family:'Segoe UI',system-ui,sans-serif; overflow-y:auto; max-height:96vh; box-sizing:border-box; }
  .afsim-body *, .afsim-body *::before { box-sizing:border-box; }
  .afsim-top { display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; }
  .afsim-logo { background:#fff; border-radius:8px; padding:5px 12px; display:flex; align-items:center; }
  .afsim-logo img { height:26px; display:block; }
  .afsim-tit { text-align:center; }
  .afsim-h1 { color:#fff; font-size:1.15rem; font-weight:800; margin:0; }
  .afsim-h2 { color:rgba(255,255,255,.85); font-size:.75rem; margin:0; }
  .afsim-x { background:rgba(255,255,255,.18); border:none; color:#fff; border-radius:10px; width:32px; height:32px; font-size:1rem; cursor:pointer; }
  .afsim-card { background:#fff; border-radius:14px; padding:12px 14px; }
  .afsim-lbl { font-weight:700; color:#1e293b; font-size:.85rem; margin-bottom:6px; }
  .afsim-inp { display:flex; align-items:center; gap:8px; border:2px solid #d7dfee; border-radius:12px; padding:6px 12px; }
  .afsim-inp span { color:#94a3b8; font-size:1.15rem; }
  .afsim-inp input { border:none; outline:none; width:100%; font-size:1.25rem; font-weight:700; color:#111; min-width:0; }
  .afsim-inc { margin-top:8px; font-size:.72rem; color:#64748b; line-height:1.5; overflow-wrap:anywhere; }
  .afsim-inc b { color:#334155; }
  .afsim-inc .it { white-space:nowrap; margin-right:8px; }
  .afsim-inc .it::before { content:'✓ '; color:#94a3b8; }
  .afsim-secc { color:#fff; font-weight:800; font-size:.9rem; margin:10px 0 8px; }
  .afsim-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .afsim-op { border-radius:14px; padding:10px 14px; color:#fff; position:relative; }
  .afsim-op .pl { font-size:.8rem; font-weight:600; opacity:.95; }
  .afsim-op .ct { font-size:1.45rem; font-weight:800; margin:1px 0; }
  .afsim-op .pm { display:inline; font-size:.75rem; opacity:.9; }
  .afsim-op .cae { display:inline; font-size:.72rem; opacity:.85; margin-left:10px; }
  .afsim-op .bd { position:absolute; top:10px; right:12px; background:rgba(255,255,255,.25); border-radius:999px; padding:3px 10px; font-size:.66rem; font-weight:700; }
  .afsim-cond { background:#fff; border-radius:12px; padding:10px 14px; font-size:.72rem; color:#475569; margin-top:10px; line-height:1.5; }
  .afsim-cond b { color:#1e293b; }
  .afsim-cond .fine { font-style:italic; color:#94a3b8; }
  .afsim-hint { color:rgba(255,255,255,.85); text-align:center; font-size:.85rem; padding:22px 10px 6px; }
  .afsim-err { color:#ffd4d4; text-align:center; font-size:.85rem; padding:14px 10px 2px; }
  @media(max-width:560px){ .afsim-grid { grid-template-columns:1fr; } }`;

  const INCLUYE = ['Seguro de Desgravamen', 'Seguro RDH', 'Seguro de Cesantía', 'Reparaciones Menores', 'Gastos de Prenda e Inscripción'];

  let cfg = null, t = null;

  function html() {
    return `<div class="afsim-body">
      <div class="afsim-top">
        <div class="afsim-logo"><img src="/img/logo-autofacil.png" alt="AutoFácil"></div>
        <div class="afsim-tit"><div class="afsim-h1">Simulador de Cuotas</div><div class="afsim-h2">AutoFácil Chile</div></div>
        <button class="afsim-x" onclick="document.getElementById('afsim-dlg').close()">✕</button>
      </div>
      <div class="afsim-card">
        <div class="afsim-lbl">Saldo Precio a Financiar</div>
        <div class="afsim-inp"><span>$</span><input id="afsim-monto" inputmode="numeric" placeholder="Ingrese el monto"></div>
        <div class="afsim-inc"><b>🛡 Incluye:</b> ${INCLUYE.map(x => `<span class="it">${x}</span>`).join('')}</div>
      </div>
      <div id="afsim-out"><div class="afsim-hint">📈 Ingrese el monto a financiar para ver las opciones de cuotas</div></div>
    </div>`;
  }

  async function simular(monto) {
    const out = document.getElementById('afsim-out');
    if (!(monto >= 1000000)) { out.innerHTML = '<div class="afsim-hint">📈 Ingrese el monto a financiar para ver las opciones de cuotas</div>'; return; }
    out.innerHTML = '<div class="afsim-hint">Calculando…</div>';
    try {
      const r = await fetch(cfg.url + '?monto=' + monto, { headers: { Authorization: 'Bearer ' + (typeof cfg.token === 'function' ? cfg.token() : cfg.token) } });
      const j = await r.json();
      if (!j.success) { out.innerHTML = `<div class="afsim-err">${j.error || 'No se pudo simular'}</div>`; return; }
      const d = j.data;
      out.innerHTML = `<div class="afsim-secc">📅 Opciones de Pago</div><div class="afsim-grid">` +
        d.opciones.map(o => {
          const s = PLAZOS[o.plazo] || PLAZOS[48];
          return `<div class="afsim-op" style="background:${s.bg}">
            <div class="pl">${o.plazo} Meses</div><div class="bd">${s.badge}</div>
            <div class="ct">${fmt(o.cuota)}</div><div><span class="pm">por mes</span>
            ${o.cae != null ? `<span class="cae">CAE: ${o.cae.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</span>` : ''}</div>
          </div>`;
        }).join('') + `</div>` +
        `<div class="afsim-cond"><b>Condiciones:</b>
          <div>· Tasa: ${Number(d.condiciones.tasa).toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% mensual ${d.condiciones.mayor200 != null ? `<span style="color:#94a3b8">(Monto ${d.condiciones.mayor200 ? '>' : '≤'} 200 UF)</span>` : ''}</div>
          ${d.condiciones.uf ? `<div>· Valor UF: ${fmt(d.condiciones.uf)} (${d.condiciones.fecha.split('-').reverse().join('/')})</div>` : ''}
          <div>· Incluye todos los seguros y gastos operacionales</div>
          <div class="fine">Valores referenciales, con primera cuota a 30 días.</div>
        </div>`;
    } catch (e) { out.innerHTML = '<div class="afsim-err">Error de conexión</div>'; }
  }

  function abrir(opciones) {
    cfg = opciones || {};
    let dlg = document.getElementById('afsim-dlg');
    if (!dlg) {
      const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
      dlg = document.createElement('dialog'); dlg.id = 'afsim-dlg'; document.body.appendChild(dlg);
    }
    dlg.innerHTML = html();
    dlg.showModal();
    const inp = document.getElementById('afsim-monto');
    inp.addEventListener('input', () => {
      const raw = inp.value.replace(/\D/g, '').slice(0, 9);
      inp.value = raw ? Number(raw).toLocaleString('es-CL') : '';
      clearTimeout(t); t = setTimeout(() => simular(Number(raw)), 500);
    });
    inp.focus();
  }

  window.AF_SIM_RAPIDO = { abrir };
})();
