/* ─────────────────────────────────────────────────────────────────────────
   Carrera de Colocaciones 🏃 (v1.0) — popup diario con la pista de atletismo
   vista desde arriba: un carril por ejecutivo, el corredor avanza según sus
   créditos otorgados del mes vs la meta (línea de llegada a cuadros).
   Cargado global vía app-version.js; 1 vez al día por navegador desde la hora
   configurada. Prueba desde el mantenedor: window.AF_CARRERA.probar(datos)
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.__AF_CARRERA__) return; window.__AF_CARRERA__ = true;

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const clp = n => '$' + Math.round(Number(n) || 0).toLocaleString('es-CL');

  function mostrar(d) {
    if (document.getElementById('afCarreraOverlay')) return;
    const css = document.createElement('style');
    css.textContent =
      '@keyframes afCrPop{0%{transform:scale(.5);opacity:0}70%{transform:scale(1.03)}100%{transform:scale(1);opacity:1}}' +
      '@keyframes afCrCorre{0%,100%{transform:translateY(-50%) rotate(-3deg)}50%{transform:translateY(-56%) rotate(3deg)}}' +
      '.af-cr-runner{transition:left 1.6s cubic-bezier(.25,.9,.35,1)}';
    document.head.appendChild(css);

    const corredores = (d.corredores || []).slice(0, 12);
    const meta = Math.max(1, Number(d.meta) || 1);
    const laneColors = ['#c2410c', '#b45309']; // tartán alternado
    const carril = (c, i) => {
      const pct = Math.min(1, c.ops / meta);
      const emoji = c.ops >= meta ? '🏆' : (i === 0 && c.ops > 0 ? '🏃‍♂️' : '🏃');
      return `
      <div style="position:relative;height:31px;background:${laneColors[i % 2]};border-bottom:2px dashed rgba(255,255,255,.55)">
        <div style="position:absolute;left:10px;top:50%;transform:translateY(-50%);z-index:2;font-size:10px;font-weight:800;color:#fff;text-shadow:0 1px 3px rgba(0,0,0,.55);max-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${i + 1}. ${esc(c.nombre)}</div>
        <div class="af-cr-runner" data-pct="${pct}" style="position:absolute;left:0%;top:50%;transform:translateY(-50%);z-index:3;font-size:18px;animation:afCrCorre ${(0.5 + Math.random() * 0.3).toFixed(2)}s ease-in-out infinite;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4))">${emoji}</div>
        <div class="af-cr-chip" style="position:absolute;left:0%;top:50%;transform:translate(24px,-50%);z-index:3;background:rgba(0,0,0,.55);color:#fff;border-radius:10px;padding:1px 7px;font-size:9.5px;font-weight:800;white-space:nowrap">${c.ops} <span style="font-weight:600;opacity:.8">/ ${meta}</span>${c.monto ? ` · <span style="color:#ffd740">${clp(c.monto)}</span>` : ''}</div>
      </div>`;
    };
    // Línea de meta a cuadros
    const cuadros = 'repeating-conic-gradient(#111 0% 25%, #fff 0% 50%) 0 0/12px 12px';
    const ov = document.createElement('div');
    ov.id = 'afCarreraOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(1,10,35,.86);z-index:99999;display:flex;align-items:center;justify-content:center;overflow:auto';
    ov.innerHTML =
      '<div style="background:linear-gradient(160deg,#0a1d4d,#012d70 60%,#0141A2);border-radius:20px;padding:20px 24px 16px;color:#fff;max-width:640px;width:92vw;max-height:92vh;overflow:auto;margin:16px;box-shadow:0 24px 80px rgba(0,0,0,.6);animation:afCrPop .5s ease">' +
      '<div style="text-align:center;font-size:1.08rem;font-weight:900;letter-spacing:.6px">' + esc(d.titulo || '🏃 CARRERA DE COLOCACIONES') + '</div>' +
      '<div style="text-align:center;font-size:.78rem;opacity:.85;margin:4px 0 12px">' + esc(d.subtitulo || '') + '</div>' +
      // Pista: pasto + carriles tartán + partida y meta
      '<div style="background:#14532d;border-radius:12px;padding:10px 9px">' +
      '<div style="position:relative;border-radius:8px;overflow:hidden;border:3px solid #fff3">' +
      '<div style="position:absolute;left:24px;top:0;bottom:0;width:3px;background:#fff;opacity:.8;z-index:4"></div>' +   // partida
      '<div style="position:absolute;right:14px;top:0;bottom:0;width:14px;background:' + cuadros + ';z-index:4;opacity:.95"></div>' + // meta a cuadros
      corredores.map(carril).join('') +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:9.5px;color:#bbf7d0;margin-top:5px;padding:0 4px"><span>PARTIDA</span><span>META: ' + meta + ' créditos 🏁</span></div>' +
      '</div>' +
      '<div style="text-align:center;margin-top:14px"><button id="afCarreraBtn" style="background:#ffd740;color:#012d70;border:none;border-radius:24px;padding:9px 26px;font-weight:900;font-size:.88rem;cursor:pointer;box-shadow:0 4px 18px rgba(255,215,64,.45)">💪 ¡A correr!</button></div></div>';
    document.body.appendChild(ov);
    document.getElementById('afCarreraBtn').onclick = () => ov.remove();
    // Animación: los corredores parten de la línea y avanzan a su posición
    setTimeout(() => {
      ov.querySelectorAll('.af-cr-runner').forEach(r => {
        const pct = Number(r.dataset.pct) || 0;
        const left = 3 + pct * 85; // 3% partida → 88% meta
        r.style.left = left + '%';
        const chip = r.parentElement.querySelector('.af-cr-chip');
        if (chip) { chip.style.transition = 'left 1.6s cubic-bezier(.25,.9,.35,1)'; chip.style.left = left + '%'; }
      });
    }, 350);
  }

  function hoyKey() { const d = new Date(); return 'afCarrera_' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  async function check() {
    try {
      const token = sessionStorage.getItem('token'); if (!token) return;
      if (localStorage.getItem(hoyKey())) return; // 1 vez al día
      const r = await fetch('/api/carrera/popup', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return;
      const j = await r.json(); const d = (j && j.data) || {};
      if (!d.mostrar) return;
      localStorage.setItem(hoyKey(), '1');
      mostrar(d);
    } catch (e) { /* silencioso */ }
  }

  window.AF_CARRERA = { probar: mostrar };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(check, 1600));
  else setTimeout(check, 1600);
})();
