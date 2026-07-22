/* ─────────────────────────────────────────────────────────────────────────
   📢 AVISOS EN LÍNEA — receptor global (se inyecta desde app-version.js).
   Soporte → Avisos en Línea envía un mensaje broadcast; cada usuario
   conectado lo ve como aviso tipo push con sonido. El retardo y la
   duración vienen configurados EN el aviso (paramétrico, sin hardcode).
   Polling 20s a /api/notif/aviso-linea/vigentes; los ya mostrados se
   recuerdan en localStorage (af_avisos_vistos) para no repetir.
   Sonido: reutiliza window.afPlaySound (motor único de la campanita).
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  const token = sessionStorage.getItem('token');
  if (!token) return;
  if (window.__afAvisoLinea) return;
  window.__afAvisoLinea = true;

  const VISTOS_KEY = 'af_avisos_vistos';
  const vistos = () => { try { return JSON.parse(localStorage.getItem(VISTOS_KEY) || '[]'); } catch (_) { return []; } };
  const marcarVisto = id => {
    try {
      const v = vistos(); v.push(id);
      localStorage.setItem(VISTOS_KEY, JSON.stringify(v.slice(-50)));  // solo los últimos 50
    } catch (_) {}
  };

  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function inyectarEstilos() {
    if (document.getElementById('afAvisoCss')) return;
    const st = document.createElement('style');
    st.id = 'afAvisoCss';
    st.textContent = `
      #afAvisoToast { position:fixed; top:76px; left:50%; transform:translateX(-50%) translateY(-20px); opacity:0;
        z-index:99990; width:min(560px, 92vw); background:linear-gradient(135deg,#012d70,#0141A2 60%,#0255c5);
        color:#fff; border-radius:16px; box-shadow:0 20px 60px rgba(0,0,0,.45); padding:18px 22px;
        display:flex; gap:16px; align-items:flex-start; transition:transform .35s ease, opacity .35s ease;
        border:1px solid rgba(255,255,255,.25); font-family:'Segoe UI',system-ui,sans-serif; }
      #afAvisoToast.show { transform:translateX(-50%) translateY(0); opacity:1; }
      #afAvisoToast .af-av-ico { flex:0 0 46px; height:46px; border-radius:12px; background:rgba(255,255,255,.15);
        display:flex; align-items:center; justify-content:center; font-size:1.5rem; animation:afAvPulse 1.2s ease-in-out infinite; }
      @keyframes afAvPulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.12)} }
      #afAvisoToast .af-av-tit { font-weight:800; font-size:.78rem; letter-spacing:1px; text-transform:uppercase; opacity:.8; margin-bottom:4px; }
      #afAvisoToast .af-av-msg { font-size:1rem; font-weight:600; line-height:1.45; white-space:pre-wrap; }
      #afAvisoToast .af-av-meta { font-size:.72rem; opacity:.65; margin-top:8px; }
      #afAvisoToast .af-av-x { margin-left:auto; flex:0 0 auto; background:rgba(255,255,255,.15); border:none; color:#fff;
        width:28px; height:28px; border-radius:8px; cursor:pointer; font-size:.9rem; line-height:1; }
      #afAvisoToast .af-av-x:hover { background:rgba(255,255,255,.3); }`;
    document.head.appendChild(st);
  }

  let cola = [], mostrando = false;

  function mostrar(av) {
    if (!document.body) { setTimeout(() => mostrar(av), 300); return; }   // script corre en <head>
    mostrando = true;
    inyectarEstilos();
    document.getElementById('afAvisoToast')?.remove();
    const d = document.createElement('div');
    d.id = 'afAvisoToast';
    d.innerHTML = `
      <div class="af-av-ico"><i class="bi bi-megaphone-fill"></i></div>
      <div style="flex:1;min-width:0">
        <div class="af-av-tit">📢 Aviso AutoFácil</div>
        <div class="af-av-msg">${esc(av.mensaje)}</div>
        <div class="af-av-meta">${esc(av.autor || 'Soporte')} · ${new Date(av.created_at).toLocaleTimeString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit' })}</div>
      </div>
      <button class="af-av-x" title="Cerrar">✕</button>`;
    document.body.appendChild(d);
    requestAnimationFrame(() => requestAnimationFrame(() => d.classList.add('show')));
    try { if (window.afPlaySound) window.afPlaySound(av.sonido || 'anuncio'); } catch (_) {}
    // Push del navegador (si el usuario tiene permiso dado): útil si la pestaña no está visible
    try {
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted')
        new Notification('📢 Aviso AutoFácil', { body: av.mensaje, icon: '/img/favicon.png' });
    } catch (_) {}
    const cerrar = () => { d.classList.remove('show'); setTimeout(() => { d.remove(); mostrando = false; procesarCola(); }, 400); };
    d.querySelector('.af-av-x').addEventListener('click', cerrar);
    setTimeout(cerrar, Math.min(300, Math.max(5, av.duracion_seg || 20)) * 1000);
  }

  function procesarCola() {
    if (mostrando || !cola.length) return;
    const av = cola.shift();
    mostrar(av);
  }

  async function revisar() {
    try {
      const r = await fetch('/api/notif/aviso-linea/vigentes', { headers: { Authorization: 'Bearer ' + sessionStorage.getItem('token') } });
      if (!r.ok) return;
      const j = await r.json();
      if (!j.success || !Array.isArray(j.data)) return;
      const v = vistos();
      j.data.slice().reverse().forEach(av => {          // más antiguos primero
        if (v.includes(av.id)) return;
        marcarVisto(av.id);
        const retardo = Math.max(0, av.retardo_seg || 0) * 1000;
        setTimeout(() => { cola.push(av); procesarCola(); }, retardo);
      });
    } catch (_) {}
  }

  // Vista previa local desde Soporte → Avisos en Línea (no toca BD)
  window.AF_AVISO_PREVIA = av => { cola.push(av); procesarCola(); };

  revisar();
  setInterval(revisar, 20000);
})();
