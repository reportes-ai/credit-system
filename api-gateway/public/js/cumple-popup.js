/* ─────────────────────────────────────────────────────────────────────────
   Popup de cumpleaños 🎂 (v1.0) — se carga en TODAS las páginas vía app-version.js.
   Si el usuario logueado está de cumpleaños HOY (según usuarios.fecha_nacimiento),
   muestra un popup animado con los textos del mantenedor RRHH (rh_config) y
   toca "Cumpleaños Feliz" con WebAudio. Se muestra 1 vez al día por navegador.
   Prueba desde el mantenedor: window.AF_CUMPLE.probar(datos)
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.__AF_CUMPLE__) return; window.__AF_CUMPLE__ = true;

  function hoyKey() { const d = new Date(); return 'afCumple_' + d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

  /* Cumpleaños Feliz con WebAudio (sin archivos externos) */
  function tocarCumpleanos() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const N = { C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, B4: 493.88, C5: 523.25, F5: 698.46, E5: 659.25, D5: 587.33, Bb4: 466.16 };
      // Happy Birthday en Fa mayor: [nota, duración en corcheas]
      const mel = [['C4',1],['C4',1],['D4',2],['C4',2],['F4',2],['E4',4],
                   ['C4',1],['C4',1],['D4',2],['C4',2],['G4',2],['F4',4],
                   ['C4',1],['C4',1],['C5',2],['A4',2],['F4',2],['E4',2],['D4',4],
                   ['Bb4',1],['Bb4',1],['A4',2],['F4',2],['G4',2],['F4',6]];
      let t = ctx.currentTime + 0.1; const q = 0.22;
      for (const [n, d] of mel) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'triangle'; o.frequency.value = N[n]; o.connect(g); g.connect(ctx.destination);
        const dur = d * q;
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.22, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.92);
        o.start(t); o.stop(t + dur); t += dur;
      }
      return true;
    } catch (e) { return false; }
  }

  function confeti(cont) {
    const EMO = ['🎈', '🎉', '🎊', '⭐', '🎂', '🥳', '🎁'];
    for (let i = 0; i < 26; i++) {
      const s = document.createElement('div');
      s.textContent = EMO[i % EMO.length];
      s.style.cssText = 'position:absolute;top:-40px;left:' + (Math.random() * 100) + '%;font-size:' + (16 + Math.random() * 20) + 'px;' +
        'animation:afCumpleCaer ' + (2.8 + Math.random() * 2.4) + 's linear ' + (Math.random() * 2.5) + 's infinite;pointer-events:none';
      cont.appendChild(s);
    }
  }

  function mostrar(d) {
    if (document.getElementById('afCumpleOverlay')) return;
    const css = document.createElement('style');
    css.textContent = '@keyframes afCumpleCaer{to{transform:translateY(110vh) rotate(360deg)}}' +
      '@keyframes afCumplePop{0%{transform:scale(.4);opacity:0}70%{transform:scale(1.06)}100%{transform:scale(1);opacity:1}}' +
      '@keyframes afCumpleGlow{0%,100%{text-shadow:0 0 18px rgba(255,215,64,.8)}50%{text-shadow:0 0 34px rgba(255,120,180,.9)}}';
    document.head.appendChild(css);
    const ov = document.createElement('div');
    ov.id = 'afCumpleOverlay';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(1,15,45,.72);z-index:99999;display:flex;align-items:center;justify-content:center;overflow:hidden';
    ov.innerHTML =
      '<div style="background:linear-gradient(150deg,#012d70,#0141A2 55%,#009AFE);border-radius:22px;padding:44px 52px;text-align:center;color:#fff;max-width:520px;margin:16px;box-shadow:0 22px 70px rgba(0,0,0,.5);animation:afCumplePop .55s ease;position:relative">' +
      '<div style="font-size:56px;line-height:1;margin-bottom:12px">🎂</div>' +
      '<div style="font-size:1.5rem;font-weight:900;letter-spacing:.5px;animation:afCumpleGlow 2.2s ease infinite">' + (d.titulo || '') + '</div>' +
      '<div style="font-size:1.02rem;margin-top:14px;opacity:.95">' + (d.linea1 || '') + '</div>' +
      '<div style="font-size:.88rem;margin-top:8px;opacity:.8;font-style:italic">' + (d.linea2 || '') + '</div>' +
      '<button id="afCumpleBtn" style="margin-top:26px;background:#ffd740;color:#012d70;border:none;border-radius:26px;padding:12px 30px;font-weight:900;font-size:.95rem;cursor:pointer;box-shadow:0 4px 16px rgba(255,215,64,.4)">🥳 ¡Gracias!</button></div>';
    document.body.appendChild(ov);
    confeti(ov);
    if (d.musica) tocarCumpleanos(); // si el navegador lo bloquea, suena al hacer clic
    let sono = false;
    document.getElementById('afCumpleBtn').onclick = function () {
      if (d.musica && !sono) { sono = true; tocarCumpleanos(); this.textContent = '🎶 ¡Que lo cumplas feliz!'; setTimeout(() => ov.remove(), 6500); return; }
      ov.remove();
    };
  }

  async function check() {
    try {
      const token = sessionStorage.getItem('token'); if (!token) return;
      if (localStorage.getItem(hoyKey())) return; // atajo: ya consultado/mostrado hoy
      const r = await fetch('/api/rrhh/cumple/estado', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return;
      const j = await r.json(); const d = (j && j.data) || {};
      if (!d.es_cumple) return;
      // Dedup por CUMPLEAÑOS (d.fecha): si cayó en fin de semana se saluda la próxima
      // conexión dentro del tope, pero una sola vez por cumpleaños.
      const k = 'afCumpleVisto_' + d.fecha;
      if (localStorage.getItem(k)) return;
      localStorage.setItem(k, '1'); localStorage.setItem(hoyKey(), '1');
      mostrar(d);
    } catch (e) { /* silencioso */ }
  }

  /* Banner a los COMPAÑEROS: mismo banner push de los anuncios ("X acaba de
     colocar un crédito"), 1 vez al día por cumpleañero y navegador. */
  function bannerConAnuncio(texto) {
    let intentos = 0;
    (function go() { // afMostrarAnuncio lo define app-version.js en DOMContentLoaded
      if (window.afMostrarAnuncio) return window.afMostrarAnuncio(texto, { bg: '#012d70', fg: '#ffffff', ancho: 38, dur: 9, icon: '🎂' });
      if (++intentos < 20) setTimeout(go, 500);
    })();
  }
  async function checkCompaneros() {
    try {
      const token = sessionStorage.getItem('token'); if (!token) return;
      const r = await fetch('/api/rrhh/cumple/hoy', { headers: { Authorization: 'Bearer ' + token } });
      if (!r.ok) return;
      const j = await r.json(); const avisos = (j && j.data && j.data.avisos) || [];
      for (const a of avisos) {
        const k = 'afCumpleAviso_' + a.fecha + '_' + a.id;
        if (localStorage.getItem(k)) continue;
        localStorage.setItem(k, '1');
        bannerConAnuncio(a.texto);
      }
    } catch (e) { /* silencioso */ }
  }
  window.AF_CUMPLE_BANNER = bannerConAnuncio; // prueba desde el mantenedor

  window.AF_CUMPLE = { probar: mostrar, tocar: tocarCumpleanos };
  const arrancar = () => { setTimeout(check, 800); setTimeout(checkCompaneros, 1500); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
  else arrancar();
})();
