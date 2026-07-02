/* ─────────────────────────────────────────────────────────────────────────
   Mi Día — popup automático (v1.0). Cargado global vía app-version.js. Según
   la config del mantenedor se abre solo: en la primera conexión del día, cada
   N horas y/o en horarios fijos ("cortes"). Muestra saludo + agenda del día +
   tarjetas de pendientes en un overlay. Dedup por navegador/día en localStorage.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.__AF_MIDIA_POP__) return; window.__AF_MIDIA_POP__ = true;

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const hoyStr = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const hhmm = () => { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  // Estado por día en localStorage: { date, lastMs, horarios:[] }
  function estado() {
    try { const s = JSON.parse(localStorage.getItem('afMiDiaPop') || '{}'); if (s.date === hoyStr()) return s; } catch (_) {}
    return { date: hoyStr(), lastMs: 0, horarios: [] };
  }
  function guardar(s) { s.date = hoyStr(); localStorage.setItem('afMiDiaPop', JSON.stringify(s)); }

  // ¿Debe abrirse ahora? Devuelve el motivo o null.
  function decidir(cfg, s) {
    if (!cfg.activo) return null;
    const nada = !s.lastMs;
    if (cfg.primera_conexion && nada) return 'primera';
    if (cfg.cada_horas > 0 && s.lastMs && (Date.now() - s.lastMs) >= cfg.cada_horas * 3600000) return 'intervalo';
    if (cfg.horarios && cfg.horarios.length) {
      const now = hhmm();
      // dispara el horario cuyo minuto ya pasó hoy y aún no se mostró
      const pendiente = cfg.horarios.find(h => now >= h && !(s.horarios || []).includes(h));
      if (pendiente) return 'horario:' + pendiente;
    }
    return null;
  }

  function overlay(d) {
    if (document.getElementById('afMiDiaOverlay')) return;
    const st = document.createElement('style');
    st.textContent = '@keyframes afMdPop{0%{transform:scale(.94);opacity:0}100%{transform:scale(1);opacity:1}}';
    document.head.appendChild(st);
    const cal = d.calendario || {};
    const eventosHtml = (cal.disponible && cal.eventos && cal.eventos.length)
      ? cal.eventos.map(e => `<div style="display:flex;gap:12px;align-items:center;padding:7px 0;border-bottom:1px solid #f1f5f9"><b style="color:#0141A2;min-width:52px">${esc(e.hora)}</b><span style="flex:1;font-size:.88rem">${esc(e.titulo)}</span></div>`).join('')
      : (cal.disponible ? '<div style="color:#94a3b8;font-size:.86rem;padding:4px 0">No tienes eventos hoy 🎉</div>' : '');
    const w = (d.widgets || []).filter(x => x.n > 0 || x.destacado);
    const cards = w.length ? w.map(x => `
      <a href="${esc(x.href || '#')}" style="text-decoration:none;color:inherit;background:${x.destacado ? 'linear-gradient(135deg,#14532d,#16a34a)' : '#f8fafc'};border-radius:12px;padding:12px 14px;display:block;border-left:4px solid ${esc(x.color || '#0141A2')};min-width:150px;flex:1">
        <div style="font-size:1.5rem;font-weight:800;color:${x.destacado ? '#fff' : esc(x.color || '#0141A2')}">${x.n}</div>
        <div style="font-size:.76rem;color:${x.destacado ? 'rgba(255,255,255,.9)' : '#475569'};font-weight:600">${esc(x.nombre)}</div>
      </a>`).join('') : '<div style="color:#94a3b8;font-size:.88rem">Sin pendientes por ahora. ¡A darle! 💪</div>';

    const ov = document.createElement('div');
    ov.id = 'afMiDiaOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(1,10,35,.7);z-index:99998;display:flex;align-items:center;justify-content:center;overflow:auto;padding:16px';
    ov.innerHTML =
      '<div style="background:#fff;border-radius:20px;max-width:680px;width:96vw;max-height:92vh;overflow:auto;box-shadow:0 24px 80px rgba(0,0,0,.5);animation:afMdPop .35s ease">' +
      '<div style="background:linear-gradient(135deg,#012d70,#0141A2 50%,#009AFE);color:#fff;padding:22px 26px;position:relative">' +
      '<div style="font-size:1.4rem;font-weight:800">' + esc(d.saludo || 'Hola') + ' ' + esc(d.nombre || '') + ' 👋</div>' +
      '<div style="opacity:.9;font-size:.85rem;text-transform:capitalize;margin-top:2px">' + esc(d.fecha || '') + '</div>' +
      '<button id="afMdX" style="position:absolute;top:16px;right:18px;background:rgba(255,255,255,.2);border:none;color:#fff;width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:1rem">✕</button>' +
      '</div>' +
      '<div style="padding:20px 26px">' +
      (eventosHtml ? '<div style="font-weight:800;color:#012d70;font-size:.92rem;margin-bottom:6px"><i class="bi bi-calendar-event"></i> Tu agenda de hoy</div>' + eventosHtml + '<div style="height:16px"></div>' : '') +
      '<div style="font-weight:800;color:#012d70;font-size:.92rem;margin-bottom:8px"><i class="bi bi-list-check"></i> Tus pendientes</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:10px">' + cards + '</div>' +
      '<div style="text-align:right;margin-top:20px"><a href="/mi-dia/" style="text-decoration:none;background:#0141A2;color:#fff;border-radius:10px;padding:9px 18px;font-weight:700;font-size:.86rem">Ver Mi Día completo →</a> <button id="afMdOk" style="background:#f1f5f9;border:none;border-radius:10px;padding:9px 18px;font-weight:700;font-size:.86rem;cursor:pointer;margin-left:6px">Entendido</button></div>' +
      '</div></div>';
    document.body.appendChild(ov);
    const cerrar = () => ov.remove();
    document.getElementById('afMdX').onclick = cerrar;
    document.getElementById('afMdOk').onclick = cerrar;
    ov.addEventListener('click', e => { if (e.target === ov) cerrar(); });
  }

  async function check() {
    try {
      const token = sessionStorage.getItem('token'); if (!token) return;
      const H = { Authorization: 'Bearer ' + token };
      const cfg = await (await fetch('/api/mi-dia/popup-cfg', { headers: H })).json().then(j => j.data).catch(() => null);
      if (!cfg || !cfg.activo) return;
      const s = estado();
      const motivo = decidir(cfg, s);
      if (!motivo) return;
      // Registrar el disparo (dedup)
      s.lastMs = Date.now();
      if (motivo.startsWith('horario:')) { s.horarios = s.horarios || []; s.horarios.push(motivo.slice(8)); }
      guardar(s);
      const d = await (await fetch('/api/mi-dia', { headers: H })).json().then(j => j.data).catch(() => null);
      if (d) overlay(d);
    } catch (e) { /* silencioso */ }
  }

  window.AF_MIDIA = { probar: overlay, check };
  // Chequeo al entrar + cada 5 min (cubre los horarios fijos sin recargar)
  const arrancar = () => { setTimeout(check, 2000); setInterval(check, 5 * 60 * 1000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
  else arrancar();
})();
