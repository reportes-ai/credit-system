/* ═══════════════════════════════════════════════════════════════
   AutoFácil — Branding de Inteligencia Artificial (Anthropic)
   window.AF_IA: aviso "Analizando con IA…" + sello "Analizado con IA…".
   Activación y textos son PARAMÉTRICOS (mantenedor IA → /api/ia-config).

   Uso típico en una feature:
     if (await AF_IA.activa('liq_sueldo')) {        // master + funcionalidad ON
       const h = AF_IA.analizando();                // muestra el aviso animado
       ... llamada a IA ...
       h.cerrar();
       contenedorSello.innerHTML = AF_IA.badge();   // sello "Analizado con IA…"
     }
   ═══════════════════════════════════════════════════════════════ */
(function () {
  const LOGO = '/img/anthropic.svg';
  const DEF = {
    activa: false,
    texto_analizando: 'Analizando con Inteligencia Artificial de Anthropic…',
    texto_analizado:  'Analizado con Inteligencia Artificial de Anthropic',
    mostrar_logo: true,
    funcionalidades: [],
  };
  let _cfg = null, _cfgAt = 0, _inflight = null;
  const TTL = 60000;
  const tok = () => sessionStorage.getItem('token');
  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  async function config(force) {
    if (!force && _cfg && (Date.now() - _cfgAt) < TTL) return _cfg;
    if (_inflight) return _inflight;
    _inflight = (async () => {
      try {
        const r = await fetch('/api/ia-config', { headers: { Authorization: 'Bearer ' + tok() } });
        const j = await r.json();
        _cfg = (j && j.success && j.data) ? { ...DEF, ...j.data } : { ...DEF };
      } catch (_) { _cfg = { ...DEF }; }
      _cfgAt = Date.now(); _inflight = null;
      return _cfg;
    })();
    return _inflight;
  }

  // ¿IA activa? (master) y, si se pasa código, también esa funcionalidad.
  async function activa(codigo) {
    const c = await config();
    if (!c.activa) return false;
    if (!codigo) return true;
    const f = (c.funcionalidades || []).find(x => x.codigo === codigo);
    return !!(f && f.activa);
  }

  function injectCSS() {
    if (document.getElementById('af-ia-css')) return;
    const st = document.createElement('style'); st.id = 'af-ia-css';
    st.textContent = `
      .af-ia-ov { position:fixed; inset:0; z-index:1000050; display:flex; align-items:center; justify-content:center;
        background:rgba(15,23,42,.55); backdrop-filter:blur(3px); opacity:0; transition:opacity .25s ease; padding:24px; }
      .af-ia-ov.show { opacity:1; }
      .af-ia-card { background:#fff; border-radius:20px; max-width:420px; width:100%; text-align:center;
        padding:34px 32px 28px; box-shadow:0 30px 70px rgba(0,0,0,.35); position:relative; overflow:hidden;
        transform:scale(.94); transition:transform .25s cubic-bezier(.18,.89,.32,1.28); }
      .af-ia-ov.show .af-ia-card { transform:scale(1); }
      .af-ia-card::before { content:''; position:absolute; top:0; left:0; right:0; height:4px;
        background:linear-gradient(90deg,#D97757,#E8A87C,#D97757); background-size:200% 100%; animation:afIaShimmer 2s linear infinite; }
      @keyframes afIaShimmer { from{background-position:0 0} to{background-position:200% 0} }
      .af-ia-orb { width:74px; height:74px; margin:0 auto 18px; border-radius:50%;
        background:radial-gradient(circle at 32% 28%,#E8A87C,#D97757 60%,#C15F3C);
        display:flex; align-items:center; justify-content:center; color:#fff; font-size:2rem;
        box-shadow:0 10px 26px rgba(217,119,87,.5); animation:afIaPulse 1.6s ease-in-out infinite; }
      @keyframes afIaPulse { 0%,100%{transform:scale(1); box-shadow:0 10px 26px rgba(217,119,87,.5)}
        50%{transform:scale(1.07); box-shadow:0 14px 34px rgba(217,119,87,.7)} }
      .af-ia-orb .bi { animation:afIaSpin 3.5s linear infinite; }
      @keyframes afIaSpin { to{transform:rotate(360deg)} }
      .af-ia-pw { font-size:.72rem; color:#94a3b8; display:flex; align-items:center; justify-content:center; gap:7px; margin-bottom:10px; }
      .af-ia-pw .af-ia-logo { height:20px; vertical-align:middle; }
      .af-ia-msg { font-size:1.08rem; font-weight:700; color:#1f2937; line-height:1.42; }
      .af-ia-dots { display:flex; gap:7px; justify-content:center; margin-top:18px; }
      .af-ia-dots span { width:9px; height:9px; border-radius:50%; background:#D97757; animation:afIaBounce 1.1s ease-in-out infinite; }
      .af-ia-dots span:nth-child(2){ animation-delay:.18s } .af-ia-dots span:nth-child(3){ animation-delay:.36s }
      @keyframes afIaBounce { 0%,80%,100%{transform:scale(.5);opacity:.4} 40%{transform:scale(1);opacity:1} }

      .af-ia-badge { display:inline-flex; align-items:center; gap:8px; background:#fdf3ee; border:1px solid #f2d3c4;
        color:#9a4a2c; border-radius:999px; padding:6px 14px; font-size:.78rem; font-weight:700; line-height:1; }
      .af-ia-badge .bi { color:#D97757; font-size:.95rem; }
      .af-ia-badge .af-ia-badge-logo { height:16px; opacity:.95; margin-left:2px; }
    `;
    document.head.appendChild(st);
  }

  const logoTag = cls => `<img class="${cls}" src="${LOGO}" alt="Anthropic">`;

  /* Aviso animado "Analizando con IA…". Devuelve { cerrar(), el }. */
  function analizando(texto) {
    injectCSS();
    const c = _cfg || DEF;
    const msg = esc(texto || c.texto_analizando || DEF.texto_analizando);
    const ov = document.createElement('div');
    ov.className = 'af-ia-ov';
    ov.innerHTML = `
      <div class="af-ia-card">
        <div class="af-ia-orb"><i class="bi bi-stars"></i></div>
        ${ (c.mostrar_logo !== false) ? `<div class="af-ia-pw">con tecnología de ${logoTag('af-ia-logo')}</div>` : '' }
        <div class="af-ia-msg">${msg}</div>
        <div class="af-ia-dots"><span></span><span></span><span></span></div>
      </div>`;
    document.body.appendChild(ov);
    requestAnimationFrame(() => ov.classList.add('show'));
    return { cerrar() { ov.classList.remove('show'); setTimeout(() => ov.remove(), 280); }, el: ov };
  }

  /* Sello "Analizado con IA de Anthropic" (HTML para innerHTML). Para el texto
     parametrizado, llamar antes await AF_IA.config(). opts: {texto, logo}. */
  function badge(opts) {
    injectCSS();
    const c = _cfg || DEF, o = opts || {};
    const txt = esc(o.texto || c.texto_analizado || DEF.texto_analizado);
    const showLogo = (o.logo != null) ? o.logo : (c.mostrar_logo !== false);
    return `<span class="af-ia-badge"><i class="bi bi-stars"></i><span>${txt}</span>${ showLogo ? logoTag('af-ia-badge-logo') : '' }</span>`;
  }
  function sello(el, opts) { if (el) el.innerHTML = badge(opts); }

  window.AF_IA = { config, activa, analizando, badge, sello, LOGO };
})();
