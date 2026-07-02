/* ─────────────────────────────────────────────────────────────────────────
   Popup mensual del Ranking de Colocaciones 🏆 (v1.0) — cargado global vía
   app-version.js. El día configurado (o hábil siguiente) muestra el PODIO
   1°/2°/3° por créditos otorgados del mes anterior, animado y con fanfarria
   épica estilo Rocky (WebAudio, sin archivos). 1 vez al mes por navegador.
   Prueba desde el mantenedor: window.AF_RANKING.probar(datos)
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.__AF_RANKING__) return; window.__AF_RANKING__ = true;

  /* Fanfarrias sintetizadas (WebAudio). Melodías disponibles:
     rocky     — tema estilo "Gonna Fly Now" extendido (~11s)
     corta     — fanfarria breve de trompetas (~6s, la original)
     olimpica  — estilo fanfarria olímpica / Bugler's Dream (~9s)
     epica     — himno de campeones, acordes ascendentes (~9s) */
  function fanfarria(melodia) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const out = ctx.createGain(); out.gain.value = 0.9; out.connect(ctx.destination);
      const N = { A3: 220.0, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, Bb4: 466.16, C5: 523.25, D5: 587.33, E5: 659.25, F5: 698.46 };
      // "trompeta": sawtooth + octava suave, ataque rápido
      function trumpet(f, t0, dur, vol) {
        [[f, 1, 'sawtooth'], [f * 2, 0.25, 'triangle']].forEach(([fr, mul, tipo]) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = tipo; o.frequency.value = fr; o.connect(g); g.connect(out);
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.linearRampToValueAtTime((vol || 0.16) * mul, t0 + 0.025);
          g.gain.setValueAtTime((vol || 0.16) * mul * 0.85, t0 + dur * 0.7);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
          o.start(t0); o.stop(t0 + dur + 0.03);
        });
      }
      function timbal(t0) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(120, t0); o.frequency.exponentialRampToValueAtTime(50, t0 + 0.25);
        g.gain.setValueAtTime(0.5, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
        o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + 0.32);
      }
      let t = ctx.currentTime + 0.08; const q = 0.30; // negra ~100bpm épico
      let cierre = 11000;
      const m = melodia || 'rocky';
      if (m === 'corta') {
        // Fanfarria breve original: da-da-daaa x2 + escalada + acorde
        trumpet(N.A3, t, q * 0.45); trumpet(N.C4, t + q * 0.5, q * 0.45); trumpet(N.D4, t + q, q * 1.7, 0.2); timbal(t);
        t += q * 3;
        trumpet(N.D4, t, q * 0.45); trumpet(N.F4, t + q * 0.5, q * 0.45); trumpet(N.G4, t + q, q * 1.7, 0.2); timbal(t);
        t += q * 3;
        trumpet(N.G4, t, q * 0.45); trumpet(N.A4, t + q * 0.5, q * 0.45); trumpet(N.Bb4, t + q, q * 0.9, 0.19);
        trumpet(N.C5, t + q * 2, q * 0.9, 0.2); timbal(t + q * 2);
        t += q * 3;
        [N.F4, N.A4, N.C5, N.F5].forEach(f => trumpet(f, t, q * 4.2, 0.12));
        timbal(t); timbal(t + q); timbal(t + q * 2);
        cierre = 6500;
      } else if (m === 'olimpica') {
        // Estilo fanfarria olímpica (Bugler's Dream): llamada solemne de trompetas
        const seq = [[N.C4, 1.5], [N.C4, 0.5], [N.C4, 1], [N.G4, 2], [N.E4, 1], [N.C4, 1], [N.G4, 2.6]];
        for (const [f, d] of seq) { trumpet(f, t, q * d * 0.92, 0.2); timbal(t); t += q * d; }
        t += q * 0.4;
        const seq2 = [[N.C5, 0.75], [N.C5, 0.75], [N.C5, 0.5], [N.G4, 1], [N.A4, 1], [N.C5, 2.6]];
        for (const [f, d] of seq2) { trumpet(f, t, q * d * 0.92, 0.2); t += q * d; }
        [N.C4, N.E4, N.G4, N.C5].forEach(f => trumpet(f, t, q * 4, 0.12));
        timbal(t); timbal(t + q * 1.5);
        cierre = 9500;
      } else if (m === 'epica') {
        // Himno de campeones: acordes ascendentes con remate coral
        const acordes = [[N.C4, N.E4, N.G4], [N.F4, N.A4, N.C5], [N.G4, N.Bb4, N.D5], [N.A4, N.C5, N.E5]];
        for (const ac of acordes) { ac.forEach(f => trumpet(f, t, q * 1.9, 0.11)); timbal(t); t += q * 2; }
        trumpet(N.C5, t, q * 0.7, 0.2); trumpet(N.D5, t + q * 0.8, q * 0.7, 0.2); timbal(t);
        t += q * 1.8;
        [N.F4, N.A4, N.C5, N.F5].forEach(f => trumpet(f, t, q * 5, 0.13));
        timbal(t); timbal(t + q); timbal(t + q * 2); timbal(t + q * 3);
        cierre = 9500;
      } else {
        // ── ROCKY: intro da-da-daaa x2 + gancho "gonna fly now" + clímax ──
        trumpet(N.A3, t, q * 0.45); trumpet(N.C4, t + q * 0.5, q * 0.45); trumpet(N.D4, t + q, q * 1.7, 0.2); timbal(t);
        t += q * 3;
        trumpet(N.D4, t, q * 0.45); trumpet(N.F4, t + q * 0.5, q * 0.45); trumpet(N.G4, t + q, q * 1.7, 0.2); timbal(t);
        t += q * 3;
        trumpet(N.E4, t, q * 0.55); trumpet(N.G4, t + q * 0.66, q * 0.55); trumpet(N.A4, t + q * 1.33, q * 1.4, 0.19); timbal(t);
        t += q * 3;
        trumpet(N.E4, t, q * 0.55); trumpet(N.G4, t + q * 0.66, q * 0.55); trumpet(N.A4, t + q * 1.33, q * 0.8, 0.19);
        trumpet(N.C5, t + q * 2.2, q * 1.2, 0.2); timbal(t); timbal(t + q * 2.2);
        t += q * 3.6;
        trumpet(N.G4, t, q * 0.45); trumpet(N.A4, t + q * 0.5, q * 0.45); trumpet(N.Bb4, t + q, q * 0.9, 0.19);
        trumpet(N.C5, t + q * 2, q * 0.5, 0.2); trumpet(N.D5, t + q * 2.6, q * 0.5, 0.2); timbal(t + q * 2);
        t += q * 3.4;
        [N.F4, N.A4, N.C5, N.F5].forEach(f => trumpet(f, t, q * 4.5, 0.12));
        timbal(t); timbal(t + q); timbal(t + q * 2); timbal(t + q * 3);
        t += q * 5;
        trumpet(N.F5, t, q * 2.4, 0.2); timbal(t);
      }
      setTimeout(() => ctx.close(), cierre);
      return true;
    } catch (e) { return false; }
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function mostrar(d) {
    if (document.getElementById('afRankOverlay')) return;
    const css = document.createElement('style');
    css.textContent =
      '@keyframes afRkSube{from{transform:translateY(140px);opacity:0}to{transform:translateY(0);opacity:1}}' +
      '@keyframes afRkCopa{0%{transform:scale(0) rotate(-20deg)}70%{transform:scale(1.25) rotate(6deg)}100%{transform:scale(1) rotate(0)}}' +
      '@keyframes afRkBrillo{0%,100%{text-shadow:0 0 16px rgba(255,215,64,.9)}50%{text-shadow:0 0 40px rgba(255,215,64,1),0 0 60px rgba(255,150,0,.8)}}' +
      '@keyframes afRkCaer{to{transform:translateY(110vh) rotate(540deg)}}' +
      '@keyframes afRkPop{0%{transform:scale(.5);opacity:0}70%{transform:scale(1.04)}100%{transform:scale(1);opacity:1}}';
    document.head.appendChild(css);
    const top = d.top || [];
    const P = i => top[i] || null;
    const col = (p, lugar, copa, alto, color, delay) => p ? (
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;animation:afRkSube .8s ease ' + delay + 's both">' +
      '<div style="font-size:' + (lugar === 1 ? 64 : 46) + 'px;line-height:1;animation:afRkCopa .9s cubic-bezier(.18,.89,.32,1.4) ' + (delay + 0.5) + 's both">' + copa + '</div>' +
      '<div style="font-weight:900;font-size:' + (lugar === 1 ? '1.05rem' : '.88rem') + ';margin:8px 6px 2px;text-align:center;max-width:170px">' + esc(p.nombre) + '</div>' +
      '<div style="font-size:.8rem;opacity:.85">' + p.n + ' crédito' + (p.n === 1 ? '' : 's') + '</div>' +
      (p.monto ? '<div style="font-size:.76rem;font-weight:700;color:#ffd740;margin:2px 0 10px">$ ' + Math.round(p.monto).toLocaleString('es-CL') + '</div>' : '<div style="margin-bottom:10px"></div>') +
      '<div style="width:120px;height:' + alto + 'px;background:linear-gradient(180deg,' + color + ',rgba(255,255,255,.08));border-radius:10px 10px 0 0;display:flex;align-items:center;justify-content:center;font-size:2rem;font-weight:900;color:rgba(0,0,0,.35)">' + lugar + '</div></div>'
    ) : '<div style="width:120px"></div>';
    const ov = document.createElement('div');
    ov.id = 'afRankOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(1,10,35,.86);z-index:99999;display:flex;align-items:center;justify-content:center;overflow:hidden';
    ov.innerHTML =
      '<div style="background:linear-gradient(160deg,#0a1d4d,#012d70 55%,#0141A2);border-radius:24px;padding:38px 46px 30px;text-align:center;color:#fff;max-width:640px;margin:16px;box-shadow:0 24px 80px rgba(0,0,0,.6);animation:afRkPop .5s ease;position:relative">' +
      '<div style="font-size:1.35rem;font-weight:900;letter-spacing:1px;animation:afRkBrillo 2s ease infinite">' + esc(d.titulo || '🏆 RANKING DE COLOCACIONES') + '</div>' +
      '<div style="font-size:.9rem;opacity:.85;margin-top:6px">' + esc(d.subtitulo || '') + '</div>' +
      '<div style="display:flex;align-items:flex-end;justify-content:center;gap:10px;margin-top:26px;border-bottom:4px solid rgba(255,255,255,.25)">' +
      col(P(1), 2, '🥈', 78, '#c0c7d1', 0.35) + col(P(0), 1, '🏆', 116, '#ffd740', 0.15) + col(P(2), 3, '🥉', 54, '#d29b6c', 0.55) +
      '</div>' +
      '<button id="afRankBtn" style="margin-top:26px;background:#ffd740;color:#012d70;border:none;border-radius:26px;padding:12px 32px;font-weight:900;font-size:.95rem;cursor:pointer;box-shadow:0 4px 18px rgba(255,215,64,.45)">👏 ¡Felicitaciones!</button></div>';
    document.body.appendChild(ov);
    // Lluvia de festejo
    const EMO = ['🎉', '⭐', '🏆', '👏', '✨', '🥇'];
    for (let i = 0; i < 24; i++) {
      const s = document.createElement('div');
      s.textContent = EMO[i % EMO.length];
      s.style.cssText = 'position:absolute;top:-40px;left:' + (Math.random() * 100) + '%;font-size:' + (15 + Math.random() * 20) + 'px;animation:afRkCaer ' + (3 + Math.random() * 2.6) + 's linear ' + (Math.random() * 2.8) + 's infinite;pointer-events:none';
      ov.appendChild(s);
    }
    if (d.musica) fanfarria(d.melodia); // si el navegador bloquea el audio, suena al hacer clic
    let sono = false;
    document.getElementById('afRankBtn').onclick = function () {
      if (d.musica && !sono) { sono = true; fanfarria(d.melodia); this.textContent = '🎺 ¡A romperla este mes!'; setTimeout(() => ov.remove(), 11500); return; }
      ov.remove();
    };
  }

  function hoyKey() { const d = new Date(); return 'afRankChk_' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  async function check() {
    try {
      const token = sessionStorage.getItem('token'); if (!token) return;
      if (localStorage.getItem(hoyKey())) return; // atajo diario
      const r = await fetch('/api/ranking-ventas/popup', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return;
      const j = await r.json(); const d = (j && j.data) || {};
      localStorage.setItem(hoyKey(), '1');
      if (!d.mostrar) return;
      const k = 'afRankVisto_' + d.clave; // 1 vez por MES (por navegador)
      if (localStorage.getItem(k)) return;
      localStorage.setItem(k, '1');
      mostrar(d);
    } catch (e) { /* silencioso */ }
  }

  window.AF_RANKING = { probar: mostrar, fanfarria };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(check, 1200));
  else setTimeout(check, 1200);
})();
