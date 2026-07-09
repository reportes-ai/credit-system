/* ─────────────────────────────────────────────────────────────────────────────
   Reportería Cobranzas — shell y utilidades compartidas para los 6 informes.
   Uso en cada página:  REP.init({ titulo, icono, subtitulo });
   Provee: REP.fmt / REP.fmtN / REP.api / REP.COLORS / REP.chart / REP.exportCSV
   ───────────────────────────────────────────────────────────────────────────── */
(function () {
  const token = sessionStorage.getItem('token');
  const yo    = JSON.parse(sessionStorage.getItem('usuario') || 'null');
  if (!token || !yo) { window.location.href = '/login.html'; return; }

  const CSS = `
    :root{--navy:#0141A2;--navy-dark:#012d70;--navy-light:#0255c5;--accent:#009AFE;--bg:#f0f4f8;}
    body{background:var(--bg);font-family:'Segoe UI',system-ui,sans-serif;margin:0;min-height:100vh;color:#1e293b;}
    .topnav{background:linear-gradient(90deg,var(--navy-dark),var(--navy-light));color:#fff;height:60px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;box-shadow:0 2px 8px rgba(0,0,0,.3);}
    .topnav-brand{display:flex;align-items:center;gap:8px;text-decoration:none;}
    .topnav-brand img{height:32px;filter:brightness(0) invert(1);}
    .bc{color:rgba(255,255,255,.6);font-size:.85rem;display:flex;align-items:center;gap:6px;margin-left:16px;}
    .bc a{color:rgba(255,255,255,.75);text-decoration:none;} .bc .sep{color:rgba(255,255,255,.35);}
    .user-chip{background:rgba(255,255,255,.12);border-radius:24px;padding:5px 12px;display:flex;align-items:center;gap:8px;font-size:.85rem;}
    .avatar{width:28px;height:28px;background:#90caf9;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--navy);font-weight:700;font-size:.75rem;}
    .btn-logout{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:8px;padding:5px 12px;font-size:.82rem;cursor:pointer;}
    .wrap{padding:26px 34px;max-width:1240px;margin:0 auto;}
    .banner{background:linear-gradient(135deg,var(--navy-dark),var(--navy) 50%,var(--navy-light));border-radius:16px;padding:20px 28px;color:#fff;margin-bottom:22px;display:flex;align-items:center;gap:18px;}
    .banner i{font-size:2.2rem;opacity:.85;} .banner h1{font-size:1.3rem;font-weight:800;margin:0 0 3px;} .banner p{margin:0;opacity:.8;font-size:.85rem;}
    .filtros{background:#fff;border-radius:12px;padding:14px 18px;box-shadow:0 1px 6px rgba(0,0,0,.07);margin-bottom:20px;display:flex;flex-wrap:wrap;gap:14px;align-items:end;}
    .filtros label{display:block;font-size:.72rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;}
    .filtros input,.filtros select{border:1.5px solid #d1d5db;border-radius:8px;padding:7px 11px;font-size:.86rem;outline:none;background:#fff;}
    .btn-p{background:var(--navy);color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:.85rem;font-weight:600;cursor:pointer;}
    .btn-g{background:#166534;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-size:.85rem;font-weight:600;cursor:pointer;}
    .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:20px;}
    .kpi{background:#fff;border-radius:12px;padding:14px 18px;box-shadow:0 1px 6px rgba(0,0,0,.07);border-left:4px solid var(--navy);}
    .kpi .l{font-size:.7rem;color:#9ca3af;font-weight:700;text-transform:uppercase;letter-spacing:.5px;}
    .kpi .v{font-size:1.35rem;font-weight:800;color:#0f172a;margin-top:2px;}
    .card{background:#fff;border-radius:14px;padding:18px 20px;box-shadow:0 1px 6px rgba(0,0,0,.07);margin-bottom:20px;}
    .card h3{font-size:.95rem;font-weight:700;color:#334155;margin:0 0 14px;display:flex;align-items:center;gap:8px;}
    .grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px;}
    @media(max-width:900px){.grid2{grid-template-columns:1fr;}}
    table.rep{width:100%;border-collapse:collapse;font-size:.84rem;}
    table.rep thead th{background:#012d70;color:#fff;padding:8px 10px;text-align:right;font-weight:600;white-space:nowrap;position:sticky;top:0;}
    table.rep thead th:first-child,table.rep thead th.l{text-align:left;}
    table.rep tbody td{padding:6px 10px;border-bottom:1px solid #f1f5f9;text-align:right;white-space:nowrap;}
    table.rep tbody td:first-child,table.rep tbody td.l{text-align:left;}
    table.rep tbody tr:hover{background:#f5f8ff;}
    .scroll{max-height:520px;overflow:auto;border-radius:10px;}
    .empty{text-align:center;color:#94a3b8;padding:40px;}
    .badge{padding:2px 8px;border-radius:10px;font-size:.72rem;font-weight:700;}
  `;

  const COLORS = ['#0141A2','#009AFE','#16a34a','#f59e0b','#dc2626','#8b5cf6','#0891b2','#db2777','#65a30d','#64748b'];

  function init(opts = {}) {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const nav = document.createElement('nav'); nav.className = 'topnav';
    nav.innerHTML = `
      <div style="display:flex;align-items:center">
        <a href="/" class="topnav-brand"><img src="/img/logo.png" alt="AutoFácil"></a>
        <div class="bc"><a href="/">Inicio</a><span class="sep">›</span><a href="/cobranza">Cobranza</a><span class="sep">›</span>
          <a href="/cobranza/reporteria">Reportería</a><span class="sep">›</span>
          <span style="color:#fff;font-weight:600">${opts.titulo || ''}</span></div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div class="user-chip"><div class="avatar">${(yo.nombre||'?').charAt(0).toUpperCase()}</div>
          <div style="font-weight:600;color:#fff">${(yo.nombre||'')} ${(yo.apellido||'')}</div></div>
        <button class="btn-logout" onclick="sessionStorage.clear();location.href='/login.html'"><i class="bi bi-box-arrow-right"></i></button>
      </div>`;
    document.body.prepend(nav);
    const b = document.getElementById('banner');
    if (b) b.innerHTML = `<div class="banner"><i class="bi ${opts.icono||'bi-clipboard-data'}"></i>
      <div><h1>${opts.titulo||''}</h1><p>${opts.subtitulo||''}</p></div></div>`;
  }

  const fmt  = v => '$' + Math.round(Number(v || 0)).toLocaleString('es-CL');
  const fmtN = v => Number(v || 0).toLocaleString('es-CL');

  async function api(path) {
    const r = await fetch('/api/cobranza' + path, { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Error');
    return j.data;
  }

  const charts = {};
  function chart(id, cfg) {
    const el = document.getElementById(id); if (!el) return;
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(el, cfg);
    return charts[id];
  }

  function exportCSV(nombre, headers, rows) {
    const esc = v => { v = v == null ? '' : String(v); return /[",\n;]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const csv = [headers.map(esc).join(';'), ...rows.map(r => r.map(esc).join(';'))].join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nombre + '.csv'; a.click();
    URL.revokeObjectURL(a.href);
  }

  // rango de fechas por defecto (últimos 6 meses) para inputs
  function rangoDefault() {
    const h = new Date(); const d = new Date(); d.setMonth(d.getMonth() - 6);
    return { desde: d.toISOString().slice(0, 10), hasta: h.toISOString().slice(0, 10) };
  }

  window.REP = { init, fmt, fmtN, api, chart, exportCSV, COLORS, rangoDefault, token };
})();
