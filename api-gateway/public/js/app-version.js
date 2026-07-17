/* ─────────────────────────────────────────────
   AutoFácil — Versión global de la aplicación
   Editar SOLO este archivo para cambiar la versión
   ───────────────────────────────────────────── */
const APP_VERSION = 'v134.3';

/* ── Guardián global de sesión ─────────────────────────────────────────
   El auth-guard solo revisa el token al CARGAR la página. Como el token dura
   8h, si vence mientras trabajas la siguiente llamada devuelve 401 y el error
   "Token inválido o expirado" se mostraba inline. Este interceptor de fetch
   detecta ese 401 y te saca a login con aviso, en vez de dejarte atascado.
   No toca el 401 del propio login (credenciales) ni otros errores (permisos). */
(function () {
  if (window.__afSesionGuard) return;
  window.__afSesionGuard = true;
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res = await _fetch(...args);
    try {
      if (res.status === 401 && sessionStorage.getItem('token') &&
          !/login\.html$/.test(location.pathname)) {
        const url = (typeof args[0] === 'string' ? args[0] : args[0] && args[0].url) || '';
        if (!/\/api\/auth\/login/.test(url)) {
          const j = await res.clone().json().catch(() => null);
          if (!j || /token/i.test(j.error || '')) {
            sessionStorage.setItem('sesion_expirada', '1');
            sessionStorage.removeItem('token');
            sessionStorage.removeItem('usuario');
            location.href = '/login.html';
          }
        }
      }
    } catch (e) { /* nunca romper la petición original */ }
    return res;
  };
})();

/* ── PWA: instalable como app de escritorio (ventana propia, sin barras) ──
   Inyecta el manifest y registra el service worker en TODAS las páginas.
   Chrome/Edge muestran "Instalar AutoFácil" → ícono en escritorio + menú inicio. */
(function () {
  try {
    if (!document.querySelector('link[rel="manifest"]')) {
      const l = document.createElement('link');
      l.rel = 'manifest'; l.href = '/manifest.json';
      document.head.appendChild(l);
    }
    if (!document.querySelector('meta[name="theme-color"]')) {
      const m = document.createElement('meta');
      m.name = 'theme-color'; m.content = '#012d70';
      document.head.appendChild(m);
    }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  } catch (e) { /* no bloquear la app si el navegador no soporta PWA */ }
})();

/* ── 🎂 Popup de cumpleaños (RRHH) + 🏆 Ranking mensual — solo con sesión iniciada ── */
(function () {
  try {
    if (!sessionStorage.getItem('token')) return;
    ['/js/cumple-popup.js', '/js/ranking-popup.js', '/js/carrera-popup.js', '/js/mi-dia-popup.js'].forEach(src => {
      if (document.querySelector('script[src="' + src + '"]')) return;
      const s = document.createElement('script');
      s.src = src;
      document.head.appendChild(s);
    });
  } catch (e) {}
})();

document.addEventListener('DOMContentLoaded', () => {

  /* 0b ── Ocultar el chrome global flotante al imprimir/PDF (cinta DESARROLLO,
     campana, ayuda, debug). Cuelgan de <body>, así que el print de cada página
     no los tapa con sus reglas locales y se colaban en el PDF descuadrando el borde. */
  if (!document.getElementById('af-print-hide')) {
    const ph = document.createElement('style');
    ph.id = 'af-print-hide';
    ph.textContent = '@media print{#afDevRibbon,#afBellWrap,#afHelpBtn,#afHelpOverlay,#afHelpPanel{display:none!important}}';
    document.head.appendChild(ph);
  }

  /* 0 ── Cards de navegación uniformes en toda la app (CSS scopeado) */
  if (!document.getElementById('af-cards-uniform')) {
    const lk = document.createElement('link');
    lk.id = 'af-cards-uniform';
    lk.rel = 'stylesheet';
    lk.href = '/css/cards-uniform.css?v=' + encodeURIComponent(APP_VERSION);  // cache-bust por versión
    document.head.appendChild(lk);
  }

  /* 0b ── Avatar con FOTO real (de Credenciales) en vez de la inicial.
     La foto propia se cachea en sessionStorage (af_mi_foto: dataURL o '' si no hay). */
  (function fotoAvatar() {
    const token = sessionStorage.getItem('token');
    if (!token) return;
    const aplicar = (foto) => {
      if (!foto) return;
      // SOLO el avatar propio de la barra superior — nunca los .avatar de las
      // páginas (directorio, fichas, etc.), que son de OTRAS personas.
      document.querySelectorAll('.user-chip .avatar, #avatarInicial').forEach(el => {
        if (el.querySelector('img')) return;
        el.innerHTML = '<img src="' + foto + '" alt="" style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block">';
        el.style.overflow = 'hidden';
        el.style.padding = '0';
      });
    };
    const cached = sessionStorage.getItem('af_mi_foto');
    if (cached !== null) { aplicar(cached); setTimeout(() => aplicar(cached), 900); return; }
    fetch('/api/credenciales/mi-foto', { headers: { Authorization: 'Bearer ' + token } })
      .then(r => r.json())
      .then(j => {
        const foto = (j && j.success && j.data && j.data.foto) || '';
        try { sessionStorage.setItem('af_mi_foto', foto); } catch (_) {}  // fotos muy pesadas: no cachear
        aplicar(foto);
        setTimeout(() => aplicar(foto), 900);   // re-aplica si la página pisó el avatar con la inicial (setters async)
      }).catch(() => {});
  })();

  /* 1 ── Versión en todos los badges de la barra de navegación */
  document.querySelectorAll('.version-badge, #versionBadge').forEach(el => {
    el.textContent = APP_VERSION;
  });

  /* 2 ── Versión en el footer del login */
  const loginVer = document.querySelector('.version strong');
  if (loginVer) loginVer.textContent = APP_VERSION;

  /* 3 ── Normalizar layout del logo en todas las páginas */
  document.querySelectorAll('.topnav-brand').forEach(brand => {
    Object.assign(brand.style, {
      display:        'flex',
      alignItems:     'center',
      gap:            '8px',
      textDecoration: 'none',
    });
    brand.querySelectorAll('a').forEach(a => {
      if (a.querySelector('img')) {
        Object.assign(a.style, { display: 'flex', alignItems: 'center' });
      }
    });
    brand.querySelectorAll('img').forEach(img => {
      Object.assign(img.style, { height: '32px', display: 'inline-block' });
    });
  });

  /* 4 ── Menú de usuario: cambiar contraseña al hacer click en el chip ──── */
  const userChip = document.querySelector('.user-chip');
  if (!userChip) return;

  // Hacer el chip clickeable
  userChip.style.cursor = 'pointer';
  userChip.title = 'Haz click para opciones de cuenta';

  // ── Inyectar estilos del dropdown + modal
  const style = document.createElement('style');
  style.textContent = `
    #afUserMenu {
      position: absolute;
      top: calc(100% + 8px);
      right: 0;
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.18);
      min-width: 220px;
      z-index: 9999;
      overflow: hidden;
      animation: afDropIn 0.15s ease;
    }
    @keyframes afDropIn {
      from { opacity: 0; transform: translateY(-6px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .af-menu-header {
      background: linear-gradient(135deg, #012d70, #0141A2);
      color: #fff;
      padding: 14px 16px 12px;
    }
    .af-menu-header .af-menu-name  { font-weight: 700; font-size: 0.92rem; line-height: 1.3; }
    .af-menu-header .af-menu-perfil { font-size: 0.75rem; opacity: 0.75; margin-top: 2px; }
    .af-menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 11px 16px;
      font-size: 0.87rem;
      color: #1e293b;
      cursor: pointer;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      transition: background 0.15s;
    }
    .af-menu-item:hover { background: #f0f4f8; color: #0141A2; }
    .af-menu-item i { font-size: 1rem; color: #0141A2; width: 18px; }
    .af-menu-divider { border: none; border-top: 1px solid #f1f5f9; margin: 0; }

    /* Modal cambiar contraseña */
    #afModalClave {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.45);
      z-index: 10000;
      align-items: center;
      justify-content: center;
    }
    #afModalClave.show { display: flex; }
    .af-modal-box {
      background: #fff;
      border-radius: 16px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.25);
      animation: afModalIn 0.2s ease;
      overflow: hidden;
    }
    @keyframes afModalIn {
      from { opacity: 0; transform: scale(0.95); }
      to   { opacity: 1; transform: scale(1); }
    }
    .af-modal-header {
      background: linear-gradient(135deg, #012d70, #0141A2 60%, #0255c5);
      color: #fff;
      padding: 20px 24px 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .af-modal-header i { font-size: 1.4rem; }
    .af-modal-header h5 { margin: 0; font-weight: 700; font-size: 1.05rem; }
    .af-modal-body { padding: 24px; }
    .af-field { margin-bottom: 18px; }
    .af-field label {
      display: block;
      font-size: 0.82rem;
      font-weight: 600;
      color: #374151;
      margin-bottom: 6px;
    }
    .af-field-wrap { position: relative; }
    .af-field input {
      width: 100%;
      padding: 10px 38px 10px 12px;
      border: 1.5px solid #d1d5db;
      border-radius: 8px;
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.2s;
      box-sizing: border-box;
    }
    .af-field input:focus { border-color: #0141A2; }
    .af-eye {
      position: absolute;
      right: 10px;
      top: 50%;
      transform: translateY(-50%);
      cursor: pointer;
      color: #94a3b8;
      font-size: 1rem;
      background: none;
      border: none;
      padding: 0;
    }
    .af-eye:hover { color: #0141A2; }
    .af-strength { margin-top: 6px; display: flex; gap: 4px; align-items: center; }
    .af-strength-bar { flex: 1; height: 4px; border-radius: 2px; background: #e5e7eb; transition: background 0.3s; }
    .af-strength-label { font-size: 0.72rem; font-weight: 600; color: #94a3b8; white-space: nowrap; }
    .af-alert {
      background: #fef2f2;
      border: 1px solid #fecaca;
      color: #dc2626;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 0.83rem;
      margin-bottom: 16px;
      display: none;
    }
    .af-alert.ok { background: #f0fdf4; border-color: #bbf7d0; color: #16a34a; }
    .af-modal-footer {
      padding: 16px 24px 20px;
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      border-top: 1px solid #f1f5f9;
    }
    .af-btn {
      padding: 9px 20px;
      border-radius: 8px;
      font-size: 0.88rem;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: background 0.2s;
    }
    .af-btn-cancel { background: #f1f5f9; color: #374151; }
    .af-btn-cancel:hover { background: #e2e8f0; }
    .af-btn-save { background: #0141A2; color: #fff; }
    .af-btn-save:hover { background: #0255c5; }
    .af-btn-save:disabled { background: #93c5fd; cursor: not-allowed; }
  `;
  document.head.appendChild(style);

  // ── Inyectar modal de cambio de contraseña
  const modalHtml = `
    <div id="afModalClave">
      <div class="af-modal-box">
        <div class="af-modal-header">
          <i class="bi bi-shield-lock-fill"></i>
          <h5>Cambiar Contraseña</h5>
        </div>
        <div class="af-modal-body">
          <div id="afClaveAlert" class="af-alert"></div>

          <!-- Campos trampa: Chrome rellena estos (ocultos) en lugar de los campos visibles de la página -->
          <input type="text"     style="position:absolute;opacity:0;height:0;width:0;pointer-events:none;tabindex:-1" autocomplete="username">
          <input type="password" style="position:absolute;opacity:0;height:0;width:0;pointer-events:none;tabindex:-1" autocomplete="current-password">

          <div class="af-field">
            <label>Contraseña actual</label>
            <div class="af-field-wrap">
              <input type="password" id="afClaveActual" placeholder="Tu contraseña actual" autocomplete="new-password">
              <button class="af-eye" type="button" onclick="afToggleEye('afClaveActual',this)"><i class="bi bi-eye"></i></button>
            </div>
          </div>

          <div class="af-field">
            <label>Nueva contraseña</label>
            <div class="af-field-wrap">
              <input type="password" id="afClaveNueva" placeholder="Mínimo 6 caracteres" autocomplete="new-password" oninput="afCheckStrength(this.value)">
              <button class="af-eye" type="button" onclick="afToggleEye('afClaveNueva',this)"><i class="bi bi-eye"></i></button>
            </div>
            <div class="af-strength">
              <div class="af-strength-bar" id="afBar1"></div>
              <div class="af-strength-bar" id="afBar2"></div>
              <div class="af-strength-bar" id="afBar3"></div>
              <div class="af-strength-bar" id="afBar4"></div>
              <span class="af-strength-label" id="afStrengthLabel"></span>
            </div>
          </div>

          <div class="af-field">
            <label>Confirmar nueva contraseña</label>
            <div class="af-field-wrap">
              <input type="password" id="afClaveConfirm" placeholder="Repite la nueva contraseña" autocomplete="new-password">
              <button class="af-eye" type="button" onclick="afToggleEye('afClaveConfirm',this)"><i class="bi bi-eye"></i></button>
            </div>
          </div>
        </div>
        <div class="af-modal-footer">
          <button class="af-btn af-btn-cancel" onclick="afCloseModal()">Cancelar</button>
          <button class="af-btn af-btn-save" id="afBtnGuardar" onclick="afGuardarClave()">
            <i class="bi bi-check-lg me-1"></i>Guardar
          </button>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);

  // ── Crear contenedor relativo para el dropdown
  const chipParent = userChip.parentElement;
  chipParent.style.position = 'relative';

  // ── Funciones globales del menú
  window.afToggleEye = function(inputId, btn) {
    const inp = document.getElementById(inputId);
    const icon = btn.querySelector('i');
    if (inp.type === 'password') {
      inp.type = 'text';
      icon.className = 'bi bi-eye-slash';
    } else {
      inp.type = 'password';
      icon.className = 'bi bi-eye';
    }
  };

  window.afCheckStrength = function(val) {
    let score = 0;
    if (val.length >= 6)  score++;
    if (val.length >= 10) score++;
    if (/[A-Z]/.test(val) && /[0-9]/.test(val)) score++;
    if (/[^A-Za-z0-9]/.test(val)) score++;

    const colors = ['', '#ef4444', '#f59e0b', '#3b82f6', '#10b981'];
    const labels = ['', 'Débil', 'Regular', 'Buena', 'Muy fuerte'];
    for (let i = 1; i <= 4; i++) {
      document.getElementById('afBar' + i).style.background = i <= score ? colors[score] : '#e5e7eb';
    }
    document.getElementById('afStrengthLabel').textContent = val.length ? labels[score] : '';
    document.getElementById('afStrengthLabel').style.color  = colors[score] || '#94a3b8';
  };

  window.afOpenModal = function() {
    // Resetear campos
    ['afClaveActual','afClaveNueva','afClaveConfirm'].forEach(id => {
      const el = document.getElementById(id);
      el.value = '';
      el.type = 'password';
    });
    document.querySelectorAll('.af-eye i').forEach(i => i.className = 'bi bi-eye');
    for (let i = 1; i <= 4; i++) document.getElementById('afBar' + i).style.background = '#e5e7eb';
    document.getElementById('afStrengthLabel').textContent = '';
    const alert = document.getElementById('afClaveAlert');
    alert.style.display = 'none';
    alert.className = 'af-alert';
    document.getElementById('afBtnGuardar').disabled = false;
    document.getElementById('afModalClave').classList.add('show');
  };

  window.afCloseModal = function() {
    document.getElementById('afModalClave').classList.remove('show');
  };

  window.afGuardarClave = async function() {
    const actual   = document.getElementById('afClaveActual').value.trim();
    const nueva    = document.getElementById('afClaveNueva').value;
    const confirma = document.getElementById('afClaveConfirm').value;
    const alert    = document.getElementById('afClaveAlert');
    const btn      = document.getElementById('afBtnGuardar');

    const showErr = (msg) => {
      alert.textContent = msg;
      alert.className = 'af-alert';
      alert.style.display = 'block';
    };

    if (!actual || !nueva || !confirma) return showErr('Completa todos los campos.');
    if (nueva.length < 6) return showErr('La nueva contraseña debe tener al menos 6 caracteres.');
    if (nueva !== confirma) return showErr('Las contraseñas no coinciden.');

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Guardando…';

    try {
      const token = sessionStorage.getItem('token');
      const r = await fetch('/api/auth/cambiar-clave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ password_actual: actual, password_nuevo: nueva })
      });
      const data = await r.json();
      if (data.success) {
        alert.textContent = '✓ Contraseña actualizada correctamente.';
        alert.className = 'af-alert ok';
        alert.style.display = 'block';
        btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Guardar';
        btn.disabled = false;
        setTimeout(() => afCloseModal(), 1800);
      } else {
        showErr(data.error || 'Error al cambiar la contraseña.');
        btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Guardar';
        btn.disabled = false;
      }
    } catch (e) {
      showErr('Error de conexión. Intenta nuevamente.');
      btn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Guardar';
      btn.disabled = false;
    }
  };

  // Cerrar modal al click fuera
  document.getElementById('afModalClave').addEventListener('click', function(e) {
    if (e.target === this) afCloseModal();
  });

  // ── Abrir/cerrar dropdown al click en el chip
  userChip.addEventListener('click', function(e) {
    e.stopPropagation();
    let menu = document.getElementById('afUserMenu');
    if (menu) { menu.remove(); return; }

    const yo = JSON.parse(sessionStorage.getItem('usuario') || 'null');

    menu = document.createElement('div');
    menu.id = 'afUserMenu';
    menu.innerHTML = `
      <div class="af-menu-header">
        <div class="af-menu-name">${yo?.nombre || ''} ${yo?.apellido || ''}</div>
        <div class="af-menu-perfil">${yo?.perfil || ''}</div>
      </div>
      <button class="af-menu-item" onclick="window.location.href='/dashboard';document.getElementById('afUserMenu')?.remove()">
        <i class="bi bi-bar-chart-line"></i> Dashboard Analytics
      </button>
      <button class="af-menu-item" onclick="afOpenModal();document.getElementById('afUserMenu')?.remove()">
        <i class="bi bi-shield-lock"></i> Cambiar contraseña
      </button>
      ${yo?.perfil === 'Administrador' ? `
      <button class="af-menu-item" onclick="afToggleDebug();document.getElementById('afUserMenu')?.remove()">
        <i class="bi bi-bug"></i> Modo debug <span id="afDebugState" style="margin-left:auto;font-size:.72rem;color:#94a3b8">${localStorage.getItem('af_debug')==='1'?'ON':'OFF'}</span>
      </button>` : ''}
      ${window.__AF_ESBG ? `
      <button class="af-menu-item" onclick="window.location.href='/juegos/';document.getElementById('afUserMenu')?.remove()">
        <i class="bi bi-controller"></i> Humoradas <span style="margin-left:auto">🎮</span>
      </button>` : ''}
      <hr class="af-menu-divider">
      <button class="af-menu-item" style="color:#dc2626" onclick="sessionStorage.removeItem('token');sessionStorage.removeItem('usuario');window.location.href='/login.html'">
        <i class="bi bi-box-arrow-right" style="color:#dc2626"></i> Cerrar sesión
      </button>
    `;
    chipParent.appendChild(menu);
  });

  // Cerrar dropdown al click fuera
  document.addEventListener('click', function() {
    document.getElementById('afUserMenu')?.remove();
  });

});

/* ═══════════════════════════════════════════════════════════════
   🔔 NOTIFICACIONES GLOBALES — campanita en TODAS las páginas
   Se auto-inyecta en la barra superior. Polling 30s, doble ding de
   hotel al llegar nuevas, dropdown con historial y push opcional.
   ═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const token = sessionStorage.getItem('token');
  if (!token) return;                                  // login u otras sin sesión
  if (document.getElementById('bellBtn')) return;      // página con campana propia (Aprobaciones)

  // ── Punto de anclaje: junto al chip de usuario; si no hay chip, junto al botón
  //    Volver/Salir de la barra (agrupándolos para no romper el space-between);
  //    si no hay barra, flotante arriba a la derecha.
  const chip = document.querySelector('.user-chip');
  let anchor = null, before = null;
  if (chip) { anchor = chip.parentElement; before = chip; }
  else {
    const nav = document.querySelector('nav.topnav, .topnav');
    // Control de la derecha: botón/link de Volver/Salir (por clase, por onclick, o cualquier botón)
    const ctrl = nav && (
      nav.querySelector('.btn-logout, .btn-volver, .btn-salir, .btn-back')
      || nav.querySelector('[onclick*="logout"], [onclick*="salir"], [onclick*="volver"]')
      || nav.querySelector('button'));
    if (nav && ctrl) {
      if (ctrl.parentElement === nav) {            // control suelto en barra space-between → agrupar
        const grp = document.createElement('div');
        grp.style.cssText = 'display:flex;align-items:center;gap:10px';
        nav.insertBefore(grp, ctrl); grp.appendChild(ctrl);
        anchor = grp; before = ctrl;
      } else { anchor = ctrl.parentElement; before = ctrl; }  // ya está en un grupo a la derecha
    }
  }

  const wrap = document.createElement('div');
  wrap.id = 'afBellWrap';
  wrap.style.cssText = anchor
    ? 'position:relative;display:inline-flex;align-items:center;margin-right:10px'
    : 'position:fixed;top:14px;right:14px;z-index:9000';
  wrap.innerHTML = `
    <button id="afBellBtn" title="Notificaciones" style="position:relative;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);color:#fff;border-radius:8px;padding:6px 11px;cursor:pointer;${anchor?'':'background:#0141A2;box-shadow:0 4px 14px rgba(0,0,0,.3)'}">
      <i class="bi bi-bell" style="font-size:1.05rem"></i>
      <span id="afBellCount" style="display:none;position:absolute;top:-7px;right:-7px;background:#dc2626;color:#fff;font-size:.66rem;font-weight:800;border-radius:10px;min-width:19px;height:19px;align-items:center;justify-content:center;padding:0 5px;border:2px solid #0255c5">0</span>
    </button>
    <div id="afBellDrop" style="display:none;position:absolute;right:0;top:44px;background:#fff;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);width:330px;max-height:420px;overflow-y:auto;z-index:9500;color:#1e293b;text-align:left">
      <div style="padding:11px 16px;font-weight:800;font-size:.85rem;color:#012d70;border-bottom:1px solid #f1f5f9;display:flex;justify-content:space-between;align-items:center;gap:8px">
        Notificaciones
        <div style="display:flex;gap:6px;align-items:center">
          <button id="afBtnPushOn" style="display:none;border:none;background:#eff6ff;color:#1d4ed8;border-radius:7px;padding:3px 10px;font-size:.7rem;font-weight:700;cursor:pointer"><i class="bi bi-bell-fill"></i> Activar push</button>
          <button id="afBtnBorrarTodas" title="Borrar todas" style="border:none;background:#fef2f2;color:#b91c1c;border-radius:7px;padding:3px 10px;font-size:.7rem;font-weight:700;cursor:pointer"><i class="bi bi-trash"></i> Borrar todas</button>
        </div>
      </div>
      <div id="afBellList" style="font-size:.8rem"></div>
    </div>`;
  if (anchor) anchor.insertBefore(wrap, before);
  else document.body.appendChild(wrap);

  // Animación de "shake" para alertas de prioridad alta
  const shakeSt = document.createElement('style');
  shakeSt.textContent = `
    @keyframes afShake { 0%,100%{transform:rotate(0)} 15%{transform:rotate(16deg)} 30%{transform:rotate(-14deg)} 45%{transform:rotate(11deg)} 60%{transform:rotate(-8deg)} 75%{transform:rotate(4deg)} }
    #afBellBtn.af-shake { animation:afShake .8s ease-in-out infinite; transform-origin:50% 0; background:#dc2626 !important; border-color:#fca5a5 !important; }
    #afBellBtn.af-shake .bi { color:#fff; }`;
  document.head.appendChild(shakeSt);

  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  let unread = -1;   // -1 = primera carga, no suena
  let ringEveryMs = 0, ringUntil = 0, lastRing = 0, ringTipo = 'campana'; // sonido insistente por alerta

  /* ── Sonidos sintetizados (Web Audio, sin archivos) ── */
  function sCampana(ctx) { // doble ding de campana de hotel
    const ding = (t0) => {
      const o1 = ctx.createOscillator(), g1 = ctx.createGain();
      const o2 = ctx.createOscillator(), g2 = ctx.createGain();
      o1.type = 'sine'; o1.frequency.value = 1318;
      o2.type = 'sine'; o2.frequency.value = 1976;
      g1.gain.setValueAtTime(0.5, t0);  g1.gain.exponentialRampToValueAtTime(0.001, t0 + 0.9);
      g2.gain.setValueAtTime(0.18, t0); g2.gain.exponentialRampToValueAtTime(0.001, t0 + 0.6);
      o1.connect(g1).connect(ctx.destination); o2.connect(g2).connect(ctx.destination);
      o1.start(t0); o1.stop(t0 + 1); o2.start(t0); o2.stop(t0 + 0.7);
    };
    ding(ctx.currentTime); ding(ctx.currentTime + 0.45);
  }
  function sDingDong(ctx) { // timbre de puerta
    const t = ctx.currentTime;
    [[659.25, t], [523.25, t + 0.42]].forEach(([f, t0]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.45, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.55);
      o.connect(g).connect(ctx.destination); o.start(t0); o.stop(t0 + 0.6);
    });
  }
  function sAlarma(ctx) { // sirena tipo alarma
    const t = ctx.currentTime, dur = 1.6;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.setValueAtTime(440, t);
    for (let i = 0; i < 4; i++) {
      o.frequency.linearRampToValueAtTime(900, t + i * 0.4 + 0.2);
      o.frequency.linearRampToValueAtTime(440, t + i * 0.4 + 0.4);
    }
    g.gain.setValueAtTime(0.22, t); g.gain.setValueAtTime(0.22, t + dur - 0.1); g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + dur);
  }
  function sAplausos(ctx) { // ráfaga de ruido filtrado = aplausos
    const dur = 1.8, t0 = ctx.currentTime;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.6;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 0.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.5, t0 + 0.15);
    g.gain.setValueAtTime(0.5, t0 + 1.2); g.gain.linearRampToValueAtTime(0, t0 + dur);
    src.connect(bp).connect(g).connect(ctx.destination); src.start(t0); src.stop(t0 + dur);
  }
  function sAnuncio(ctx) { // chime tipo PA de aeropuerto: 4 "bong" de campana con eco/reverb
    const now = ctx.currentTime;
    // Bus principal con filtro (suaviza) → salida
    const master = ctx.createGain(); master.gain.value = 0.9;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200;
    master.connect(lp); lp.connect(ctx.destination);
    // Eco: delay con realimentación (los "rebotes" tipo terminal grande)
    const delay = ctx.createDelay(1.5); delay.delayTime.value = 0.34;
    const fb = ctx.createGain(); fb.gain.value = 0.4;            // cuánto se repite
    const echoMix = ctx.createGain(); echoMix.gain.value = 0.45; // volumen del eco
    lp.connect(delay); delay.connect(fb); fb.connect(delay); delay.connect(echoMix); echoMix.connect(ctx.destination);
    // Cola de reverb corta (2º delay más denso)
    const rev = ctx.createDelay(0.2); rev.delayTime.value = 0.08;
    const revFb = ctx.createGain(); revFb.gain.value = 0.5; const revMix = ctx.createGain(); revMix.gain.value = 0.18;
    lp.connect(rev); rev.connect(revFb); revFb.connect(rev); rev.connect(revMix); revMix.connect(ctx.destination);
    // Notas: descendente G5·E5·C5·G4 (el clásico "dong-dong" de anuncio)
    const notas = [783.99, 659.25, 523.25, 392.00];
    const paso = 0.46;
    notas.forEach((f, i) => {
      const t0 = now + i * paso;
      // tono de campana: fundamental + 2 parciales con decaimiento largo
      [[f, 0.55, 1.8], [f * 2.01, 0.13, 1.0], [f * 3.01, 0.05, 0.6]].forEach(([freq, amp, dec]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(amp, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0005, t0 + dec);
        o.connect(g).connect(master); o.start(t0); o.stop(t0 + dec + 0.05);
      });
    });
  }
  function reproducir(tipo) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (tipo === 'dingdong') sDingDong(ctx);
      else if (tipo === 'alarma') sAlarma(ctx);
      else if (tipo === 'aplausos') sAplausos(ctx);
      else if (tipo === 'anuncio') sAnuncio(ctx);
      else sCampana(ctx);
      setTimeout(() => ctx.close(), tipo === 'anuncio' ? 5500 : 2500);
    } catch (e) {}
  }
  const dingDing = () => reproducir(ringTipo);
  window.afPlaySound = reproducir; // para previsualizar desde el mantenedor
  const escN = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  async function cargar() {
    try {
      const r = await fetch('/api/notif', { headers: H });
      if (r.status === 401) return;
      const j = await r.json();
      if (!j.success) return;
      const { rows, noLeidas } = j.data;
      const badge = document.getElementById('afBellCount');
      badge.textContent = noLeidas;
      badge.style.display = noLeidas ? 'flex' : 'none';
      // Sonar al llegar nuevas solo si alguna no leída tiene el sonido activado
      const unreadSonoras = (rows || []).filter(n => !n.leida && n.sonar !== 0);
      const haySonido = unreadSonoras.length > 0;
      // Tipo de sonido a usar: el de la alerta ALTA sonora más reciente, o la sonora más reciente
      const masNueva = arr => arr.slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      ringTipo = ((masNueva(unreadSonoras.filter(n => n.prioridad === 'alta')) || masNueva(unreadSonoras) || {}).son_tipo) || 'campana';
      if (unread >= 0 && noLeidas > unread && haySonido) dingDing();
      unread = noLeidas;

      // Alertas de prioridad alta: campanita "shake" (visual) + sonido insistente configurable
      const btnBell = document.getElementById('afBellBtn');
      const hiPri = (rows || []).filter(n => !n.leida && n.prioridad === 'alta');
      btnBell.classList.toggle('af-shake', hiPri.length > 0);
      // Entre las alertas alta con sonido: menor intervalo y mayor ventana
      const sonoras = hiPri.filter(n => n.sonar !== 0);
      if (sonoras.length) {
        ringEveryMs = Math.min(...sonoras.map(n => (n.son_cada || 30) * 1000));
        ringUntil   = Math.max(...sonoras.map(n => (new Date(n.created_at).getTime() || 0) + (n.son_max || 5) * 60000));
      } else { ringEveryMs = 0; ringUntil = 0; }
      const list = document.getElementById('afBellList');
      list.innerHTML = rows.length ? rows.map(n => `
        <div data-href="${escN(n.href || '')}" class="af-notif-item" style="padding:10px 34px 10px 16px;border-bottom:1px solid #f8fafc;cursor:pointer;position:relative;${n.leida ? '' : 'background:#eff6ff'}">
          <button class="af-notif-x" data-del="${n.id}" title="Borrar" style="position:absolute;top:8px;right:8px;background:none;border:none;color:#cbd5e1;cursor:pointer;font-size:.9rem;line-height:1;padding:2px 5px;border-radius:5px">✕</button>
          <div style="display:flex;align-items:center;gap:7px;margin-right:18px">
            <span style="font-weight:700;color:#0f172a;flex:1">${escN(n.titulo)}</span>
            ${n.prioridad === 'alta'
              ? '<span title="Prioridad alta" style="font-size:.58rem;font-weight:800;letter-spacing:.3px;color:#fff;background:#dc2626;border-radius:8px;padding:1px 7px">ALTA</span>'
              : '<span title="Prioridad normal" style="font-size:.58rem;font-weight:800;letter-spacing:.3px;color:#64748b;background:#e2e8f0;border-radius:8px;padding:1px 7px">NORMAL</span>'}
          </div>
          <div style="color:#475569;margin:2px 0">${escN(n.mensaje || '')}</div>
          <div style="font-size:.68rem;color:#94a3b8">${new Date(n.created_at).toLocaleString('es-CL',{timeZone:'America/Santiago'})}</div>
        </div>`).join('')
        : '<div style="padding:20px;text-align:center;color:#94a3b8">Sin notificaciones</div>';
      list.querySelectorAll('.af-notif-item').forEach(el => {
        el.addEventListener('click', () => { const h = el.dataset.href; if (h) location.href = h; });
      });
      list.querySelectorAll('.af-notif-x').forEach(b => {
        b.addEventListener('click', async (e) => {
          e.stopPropagation();
          try { await fetch('/api/notif/' + b.dataset.del, { method: 'DELETE', headers: H }); } catch (e) {}
          cargar();
        });
      });
    } catch (e) {}
  }

  document.getElementById('afBtnBorrarTodas').addEventListener('click', async (e) => {
    e.stopPropagation();
    try { await fetch('/api/notif/todas', { method: 'DELETE', headers: H }); } catch (e) {}
    unread = 0;
    document.getElementById('afBellCount').style.display = 'none';
    cargar();
  });

  document.getElementById('afBellBtn').addEventListener('click', async (e) => {
    e.stopPropagation();
    const d = document.getElementById('afBellDrop');
    const abierto = d.style.display !== 'none';
    d.style.display = abierto ? 'none' : 'block';
    if (!abierto) {
      try { await fetch('/api/notif/leidas', { method: 'PUT', headers: H }); } catch (e) {}
      unread = 0;
      document.getElementById('afBellCount').style.display = 'none';
    }
  });
  document.addEventListener('click', (e) => {
    const d = document.getElementById('afBellDrop');
    if (d && d.style.display !== 'none' && !e.target.closest('#afBellWrap')) d.style.display = 'none';
  });

  /* ── Web Push ── */
  const b64ToU8 = s => {
    const pad = '='.repeat((4 - s.length % 4) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
  };
  async function suscribir() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    try {
      const reg = await navigator.serviceWorker.register('/sw-notif.js');
      const rk = await fetch('/api/notif/vapid-key', { headers: H });
      const jk = await rk.json();
      if (!jk.success) return false;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(jk.data.publicKey) });
      const s = sub.toJSON();
      await fetch('/api/notif/subscribe', { method: 'POST', headers: H, body: JSON.stringify({ endpoint: s.endpoint, keys: s.keys }) });
      return true;
    } catch (e) { return false; }
  }
  const btnPush = document.getElementById('afBtnPushOn');
  btnPush.addEventListener('click', async () => {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { alert('Debes permitir las notificaciones en el navegador.'); return; }
    if (await suscribir()) btnPush.style.display = 'none';
  });

  cargar();
  setInterval(cargar, 30000);
  // Sonido insistente para alertas alta: ~3 veces/min mientras estén sin leer y dentro de la ventana de 5 min
  setInterval(() => {
    if (ringUntil && Date.now() < ringUntil && unread > 0 && (Date.now() - lastRing) >= ringEveryMs) {
      dingDing(); lastRing = Date.now();
    }
  }, 5000);
  if ('Notification' in window) {
    if (Notification.permission === 'granted') suscribir();
    else if (Notification.permission === 'default') btnPush.style.display = '';
  }
});

/* ═══════════════════════════════════════════════════════════════
   💓 HEARTBEAT DE SESIÓN — para el informe de Desempeño Analistas.
   Marca presencia cada 60s; el logout se deriva del último latido.
   ═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const token = sessionStorage.getItem('token');
  if (!token) return;
  const ping = () => fetch('/api/desempeno/ping', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }).catch(() => {});
  ping();
  setInterval(ping, 60000);
});

/* ═══════════════════════════════════════════════════════════════
   ❔ AYUDA CONTEXTUAL — botón "?" flotante en cada página.
   Lee el contenido desde /api/ayuda según la ruta actual. Solo
   aparece si esa página tiene ayuda cargada en BD (editable, sin
   hardcode). El contenido vive en la tabla ayuda_paginas.
   ═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  const token = sessionStorage.getItem('token');
  if (!token) return;                               // login u otras sin sesión
  if (document.getElementById('afHelpBtn')) return; // evitar duplicados

  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // Estilos
  const st = document.createElement('style');
  st.textContent = `
    #afHelpBtn { position:fixed; right:18px; bottom:18px; z-index:9600; width:38px; height:38px; border-radius:50%;
      background:linear-gradient(135deg,#0141A2,#0255c5); color:#fff; border:none; cursor:pointer;
      box-shadow:0 4px 14px rgba(1,65,162,.35); font-size:1.05rem; display:flex; align-items:center; justify-content:center;
      opacity:.9; transition:transform .15s, opacity .15s; }
    #afHelpBtn:hover { transform:scale(1.1); opacity:1; }
    #afHelpOverlay { position:fixed; inset:0; background:rgba(0,0,0,.35); z-index:9700; display:none; }
    #afHelpOverlay.show { display:block; }
    #afHelpPanel { position:fixed; top:0; right:0; height:100%; width:400px; max-width:92vw; background:#fff; z-index:9800;
      box-shadow:-8px 0 32px rgba(0,0,0,.2); transform:translateX(100%); transition:transform .25s ease; overflow-y:auto;
      font-family:'Segoe UI',system-ui,sans-serif; }
    #afHelpPanel.show { transform:translateX(0); }
    .afh-head { background:linear-gradient(135deg,#012d70,#0141A2 60%,#0255c5); color:#fff; padding:20px 22px; display:flex; align-items:center; gap:12px; position:sticky; top:0; }
    .afh-head i { font-size:1.7rem; }
    .afh-head h3 { margin:0; font-weight:800; font-size:1.15rem; }
    .afh-head .afh-x { margin-left:auto; background:rgba(255,255,255,.15); border:none; color:#fff; width:30px; height:30px; border-radius:8px; cursor:pointer; font-size:1rem; }
    .afh-body { padding:18px 22px 40px; }
    .afh-sec { margin-bottom:22px; }
    .afh-sec h4 { font-size:.78rem; text-transform:uppercase; letter-spacing:.5px; color:#0141A2; font-weight:800; margin:0 0 8px; display:flex; align-items:center; gap:7px; }
    .afh-sec p { font-size:.88rem; color:#374151; line-height:1.55; margin:0; }
    .afh-step { display:flex; gap:11px; margin-bottom:13px; }
    .afh-step .n { flex:0 0 24px; height:24px; border-radius:50%; background:#0141A2; color:#fff; font-weight:800; font-size:.78rem; display:flex; align-items:center; justify-content:center; }
    .afh-step .tx b { display:block; font-size:.86rem; color:#0f172a; margin-bottom:2px; }
    .afh-step .tx span { font-size:.83rem; color:#475569; line-height:1.5; }
    .afh-sub { border:1px solid #eef2f7; border-radius:10px; padding:10px 12px; margin-bottom:8px; }
    .afh-sub b { font-size:.84rem; color:#0f172a; }
    .afh-sub span { display:block; font-size:.8rem; color:#64748b; margin-top:2px; line-height:1.45; }
    .afh-next { background:#eff6ff; border-left:4px solid #0141A2; border-radius:8px; padding:12px 14px; font-size:.85rem; color:#1e3a5f; line-height:1.55; }
  `;
  document.head.appendChild(st);

  // Infraestructura (siempre presente; el botón se muestra solo si hay ayuda para la clave actual)
  const overlay = document.createElement('div'); overlay.id = 'afHelpOverlay';
  const panel = document.createElement('div'); panel.id = 'afHelpPanel';
  const btn = document.createElement('button'); btn.id = 'afHelpBtn'; btn.title = 'Ayuda de esta página';
  btn.innerHTML = '<i class="bi bi-question-lg"></i>'; btn.style.display = 'none';
  document.body.appendChild(overlay); document.body.appendChild(panel); document.body.appendChild(btn);

  const open = () => { overlay.classList.add('show'); panel.classList.add('show'); };
  const close = () => { overlay.classList.remove('show'); panel.classList.remove('show'); };
  btn.addEventListener('click', open);
  overlay.addEventListener('click', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  function pintar(data) {
    const pasosHTML = (data.pasos||[]).map((p,i) =>
      `<div class="afh-step"><div class="n">${i+1}</div><div class="tx"><b>${esc(p.titulo)}</b><span>${esc(p.detalle)}</span></div></div>`).join('');
    const subsHTML = (data.submodulos||[]).map(s =>
      `<div class="afh-sub"><b>${esc(s.nombre)}</b><span>${esc(s.para_que)}</span></div>`).join('');
    panel.innerHTML = `
      <div class="afh-head"><i class="bi ${esc(data.icono||'bi-question-circle')}"></i>
        <h3>${esc(data.titulo)}</h3>
        <button class="afh-x" title="Cerrar">✕</button></div>
      <div class="afh-body">
        ${data.descripcion ? `<div class="afh-sec"><h4><i class="bi bi-info-circle"></i> Para qué sirve</h4><p>${esc(data.descripcion)}</p></div>` : ''}
        ${pasosHTML ? `<div class="afh-sec"><h4><i class="bi bi-list-check"></i> Cómo se usa</h4>${pasosHTML}</div>` : ''}
        ${subsHTML ? `<div class="afh-sec"><h4><i class="bi bi-grid"></i> Submódulos</h4>${subsHTML}</div>` : ''}
        ${data.siguiente ? `<div class="afh-sec"><h4><i class="bi bi-signpost-2"></i> ¿Y después?</h4><div class="afh-next">${esc(data.siguiente)}</div></div>` : ''}
      </div>`;
    panel.querySelector('.afh-x').addEventListener('click', close);
  }

  // Carga la ayuda de una "clave" (ruta o ruta+pestaña). Páginas SPA llaman window.afAyudaSet('/x/tab').
  async function cargarAyuda(key) {
    try {
      const r = await fetch('/api/ayuda?ruta=' + encodeURIComponent(key), { headers: { Authorization: 'Bearer ' + token } });
      const j = await r.json();
      if (j.success && j.data) { pintar(j.data); btn.style.display = 'flex'; }
      else { btn.style.display = 'none'; close(); }
    } catch (e) { btn.style.display = 'none'; }
  }
  window.afAyudaSet = cargarAyuda;
  cargarAyuda(location.pathname);
});

/* ═══════════════════════════════════════════════════════════════
   🐞 MODO DEBUG — solo Administrador (toggle en el menú de usuario).
   Muestra permisos recibidos y las cards en pantalla con su
   visibilidad (👁️ visible / 🚫 oculta). Persistente en localStorage.
   ═══════════════════════════════════════════════════════════════ */
async function afRenderDebug() {
  let p = document.getElementById('afDebugPanel');
  if (!p) {
    p = document.createElement('div'); p.id = 'afDebugPanel';
    p.style.cssText = 'position:fixed;bottom:10px;left:10px;z-index:99998;background:#0b1220;color:#cbd5e1;font:11px/1.45 monospace;padding:10px 12px;border-radius:8px;max-width:400px;max-height:62vh;overflow:auto;box-shadow:0 8px 28px rgba(0,0,0,.45);border:1px solid #1e293b';
    document.body.appendChild(p);
  }
  const yo = JSON.parse(sessionStorage.getItem('usuario') || 'null');
  const token = sessionStorage.getItem('token');
  const esc = s => String(s).replace(/</g, '&lt;');
  let funcs = [];
  try {
    const r = await fetch('/api/auth/mis-permisos?_=' + Date.now(), { cache: 'no-store', headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json(); funcs = j.funcionalidades || [];
  } catch (e) {}
  const cardsEl = [...document.querySelectorAll('.module-card,.ap-card,.report-card')];
  const cards = cardsEl.map(c => ({ vis: getComputedStyle(c).display !== 'none', id: c.id || (c.getAttribute('href') || '(card)') }))
    .sort((a, b) => (a.vis === b.vis) ? 0 : (a.vis ? 1 : -1)); // ocultas primero
  const nVis = cards.filter(c => c.vis).length, nOcu = cards.length - nVis;
  p.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
       <b style="color:#4fc3f7">🐞 DEBUG ${typeof APP_VERSION !== 'undefined' ? APP_VERSION : ''}</b>
       <span><button onclick="afRenderDebug()" title="Refrescar" style="background:#1e293b;border:none;color:#cbd5e1;border-radius:5px;padding:2px 7px;cursor:pointer">↻</button>
       <button onclick="afToggleDebug()" title="Cerrar" style="background:#7f1d1d;border:none;color:#fff;border-radius:5px;padding:2px 7px;cursor:pointer;margin-left:4px">✕</button></span>
     </div>
     <div><b>Usuario:</b> ${esc((yo?.nombre || '') + ' ' + (yo?.apellido || ''))}</div>
     <div><b>Perfil:</b> ${esc(yo?.perfil || '')}${yo?.perfil === 'Administrador' ? ' (admin)' : ''}</div>
     <div><b>Ruta:</b> ${esc(location.pathname)}</div>
     <div style="margin-top:7px"><b>Funcionalidades (${funcs.length}):</b>
       <input id="afDbgFiltro" placeholder="filtrar…" style="width:100%;margin:4px 0;background:#0f1830;border:1px solid #1e293b;color:#cbd5e1;border-radius:5px;padding:3px 7px;font:11px monospace;box-sizing:border-box">
       <div id="afDbgFuncs">${funcs.length ? funcs.map(f => `<span class="afdbg-f">${esc(f)}</span>`).join(' ') : '<i>ninguna</i>'}</div>
     </div>
     <div style="margin-top:7px"><b>Cards en pantalla</b> <span style="color:#94a3b8">(👁️ ${nVis} / 🚫 ${nOcu}):</span><br>
       ${cards.length ? cards.map(c => `<span style="color:${c.vis ? '#86efac' : '#fca5a5'}">${c.vis ? '👁️' : '🚫'} ${esc(c.id)}</span>`).join('<br>') : '<i>—</i>'}</div>`;
  const fi = p.querySelector('#afDbgFiltro');
  if (fi) fi.addEventListener('input', () => {
    const q = fi.value.toLowerCase();
    p.querySelectorAll('.afdbg-f').forEach(s => s.style.display = s.textContent.toLowerCase().includes(q) ? '' : 'none');
  });
}
function afToggleDebug() {
  const on = localStorage.getItem('af_debug') === '1';
  localStorage.setItem('af_debug', on ? '0' : '1');
  if (on) document.getElementById('afDebugPanel')?.remove();
  else afRenderDebug();
}
window.afRenderDebug = afRenderDebug;
window.afToggleDebug = afToggleDebug;
document.addEventListener('DOMContentLoaded', () => {
  const yo = JSON.parse(sessionStorage.getItem('usuario') || 'null');
  if (yo?.perfil === 'Administrador' && localStorage.getItem('af_debug') === '1') setTimeout(afRenderDebug, 700);
});

/* ═══════════════════════════════════════════════════════════════
   🔀 REORDENAR CARDS — botón universal en landings que no tienen el
   suyo propio. Solo Administrador puede reordenar; el orden guardado
   se aplica a TODOS los usuarios. Persiste en config_ui por ruta.
   ═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const token = sessionStorage.getItem('token');
  if (!token) return;
  if (document.getElementById('btnReordenar')) return;   // la página ya tiene su reorder propio

  // Buscar la grilla de cards (parent común de ≥2 module/ap/report-card)
  const cardSel = '.module-card, .ap-card, .report-card';
  const firstCard = document.querySelector(cardSel);
  if (!firstCard) return;
  const grid = firstCard.parentElement;
  const cardsOf = () => [...grid.children].filter(c => c.matches(cardSel));
  if (cardsOf().length < 2) return;

  const clave = 'cardorder:' + location.pathname.replace(/\/+$/,'') + '/';
  const keyOf = c => c.id || c.getAttribute('href') || (c.querySelector('h5,h6,.card-title')?.textContent || '').trim();
  const AUTH = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

  // Aplicar orden guardado (para todos los usuarios)
  (async () => {
    try {
      const r = await fetch('/api/config/ui/' + encodeURIComponent(clave), { headers: AUTH });
      const j = await r.json();
      const order = j.data;
      if (Array.isArray(order) && order.length) {
        const cards = cardsOf();
        const inOrden = order.map(k => cards.find(c => keyOf(c) === k)).filter(Boolean);
        const resto   = cards.filter(c => !order.includes(keyOf(c)));
        [...inOrden, ...resto].forEach(c => grid.appendChild(c));
      }
    } catch (e) {}
  })();

  // Solo Administrador ve los botones de reordenar
  const yo = JSON.parse(sessionStorage.getItem('usuario') || 'null');
  if (yo?.perfil !== 'Administrador') return;

  const ancla = document.querySelector('.btn-logout') || document.querySelector('.user-chip');
  if (!ancla) return;

  const mk = (txt, bg) => {
    const b = document.createElement('button');
    b.style.cssText = `background:${bg};border:1px solid rgba(255,255,255,.25);color:#fff;border-radius:8px;padding:5px 13px;font-size:.82rem;font-weight:600;cursor:pointer;margin-right:8px`;
    b.innerHTML = txt;
    return b;
  };
  const btnR = mk('<i class="bi bi-arrows-move me-1"></i>Reordenar', 'rgba(255,255,255,.12)');
  const btnG = mk('<i class="bi bi-floppy me-1"></i>Guardar orden', '#16a34a');
  btnG.style.display = 'none';
  ancla.parentElement.insertBefore(btnR, ancla);
  ancla.parentElement.insertBefore(btnG, ancla);

  let sortable = null, modo = false;
  const ensureSortable = cb => {
    if (window.Sortable) return cb();
    const s = document.createElement('script'); s.src = '/js/Sortable.min.js'; s.onload = cb; document.head.appendChild(s);
  };
  btnR.addEventListener('click', () => {
    modo = !modo;
    if (modo) {
      btnR.innerHTML = '<i class="bi bi-x-circle me-1"></i>Cancelar';
      btnR.style.background = '#f59e0b'; btnG.style.display = '';
      grid.querySelectorAll(cardSel).forEach(c => { c.style.cursor = 'grab'; c.style.outline = '2px dashed #cbd5e1'; });
      ensureSortable(() => {
        sortable = new Sortable(grid, { animation: 180, draggable: cardSel,
          onStart: () => grid.querySelectorAll('.module-card').forEach(c => { c.dataset._h = c.getAttribute('href')||''; c.removeAttribute('href'); }),
          onEnd:   () => grid.querySelectorAll('.module-card').forEach(c => { if (c.dataset._h) c.setAttribute('href', c.dataset._h); }),
        });
      });
    } else {
      btnR.innerHTML = '<i class="bi bi-arrows-move me-1"></i>Reordenar';
      btnR.style.background = 'rgba(255,255,255,.12)'; btnG.style.display = 'none';
      grid.querySelectorAll(cardSel).forEach(c => { c.style.cursor = ''; c.style.outline = ''; if (c.dataset._h) c.setAttribute('href', c.dataset._h); });
      if (sortable) { sortable.destroy(); sortable = null; }
    }
  });
  btnG.addEventListener('click', async () => {
    btnG.disabled = true; btnG.innerHTML = 'Guardando…';
    try {
      const order = cardsOf().map(keyOf);
      const r = await fetch('/api/config/ui/' + encodeURIComponent(clave), { method:'PUT', headers: AUTH, body: JSON.stringify({ valor: order }) });
      const j = await r.json();
      if (!j.success) throw new Error(j.error||'Error');
      btnR.click(); // salir del modo
    } catch (e) { alert('Error al guardar orden: ' + e.message); }
    btnG.disabled = false; btnG.innerHTML = '<i class="bi bi-floppy me-1"></i>Guardar orden';
  });
});

/* ═══════════════════════════════════════════════════════════════
   🛠️ AVISO DE MANTENCIÓN — overlay global activado por BG-ADMIN.
   Se muestra a TODOS los usuarios (menos BG-ADMIN, que puede operar
   y apagarlo) al ingresar o cambiar de pantalla. Fail-open.
   ═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  const token = sessionStorage.getItem('token');
  if (!token) return;                                          // sin sesión (login)
  // Cinta "DESARROLLO" diagonal sobre el logo cuando el Modo Desarrollo está activo.
  function afMostrarCintaDesarrollo() {
    if (document.getElementById('afDevRibbon')) return;
    const st = document.createElement('style');
    st.textContent = `#afDevRibbon{position:fixed;top:13px;left:-46px;z-index:100000;transform:rotate(-45deg);background:#f59e0b;color:#1f2937;font-weight:800;font-size:10px;letter-spacing:2px;padding:4px 54px;box-shadow:0 2px 8px rgba(0,0,0,.4);pointer-events:none;font-family:'Segoe UI',system-ui,sans-serif;border-top:1px solid #fcd34d;border-bottom:1px solid #b45309}`;
    document.head.appendChild(st);
    const d = document.createElement('div'); d.id = 'afDevRibbon'; d.textContent = 'DESARROLLO';
    document.body.appendChild(d);
  }

  let data;
  try {
    const r = await fetch('/api/mantenimiento', { headers: { Authorization: 'Bearer ' + token } });
    const j = await r.json();
    if (!j.success) return;
    if (j.data.dev_activo) afMostrarCintaDesarrollo();         // cinta DESARROLLO (independiente de la mantención)
    if (!j.data.activo || j.data.es_bg) return;                // overlay solo si mantención activa y no BG-ADMIN
    data = j.data;
  } catch (e) { return; }                                      // si falla, no bloquea

  const st = document.createElement('style');
  st.textContent = `
    #afMntOverlay { position:fixed; inset:0; z-index:1000000; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:32px;
      background:#ffffff; animation:afMntFade .25s ease; padding:24px; overflow:auto; }
    @keyframes afMntFade { from{opacity:0} to{opacity:1} }
    #afMntOverlay .bs-logo { width:min(1140px,90vw); height:auto; }
    #afMntOverlay .box { background:#fff; border-radius:20px; max-width:480px; width:100%; text-align:center;
      padding:30px 34px 26px; box-shadow:0 24px 60px rgba(0,0,0,.22); border-top:7px solid #d97706;
      animation:afMntPop .3s cubic-bezier(.18,.89,.32,1.28); }
    @keyframes afMntPop { from{opacity:0;transform:scale(.9) translateY(10px)} to{opacity:1;transform:none} }
    #afMntOverlay .ico { width:70px; height:70px; margin:0 auto 16px; border-radius:50%;
      background:linear-gradient(135deg,#f59e0b,#d97706); display:flex; align-items:center; justify-content:center;
      color:#fff; font-size:2.1rem; box-shadow:0 8px 22px rgba(217,119,6,.45); }
    #afMntOverlay .kicker { font-size:.74rem; font-weight:800; letter-spacing:.2em; text-transform:uppercase; color:#d97706; margin-bottom:8px; }
    #afMntOverlay .msg { font-family:Georgia,'Times New Roman',serif; font-size:1.45rem; line-height:1.42; color:#1f2937; font-weight:600; }
    #afMntOverlay .ok { margin-top:22px; background:#0141A2; color:#fff; border:none; border-radius:10px; padding:10px 26px; font-size:.9rem; font-weight:700; cursor:pointer; }
    #afMntOverlay .ok:hover { background:#0255c5; }`;
  document.head.appendChild(st);

  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  document.body.style.overflow = 'hidden';                       // bloquea el scroll del fondo
  const ov = document.createElement('div');
  ov.id = 'afMntOverlay';
  ov.innerHTML = `
      <img class="bs-logo" src="/img/logo-bs.png" alt="AutoFácil Business Suite">
      <div class="box">
        <div class="ico"><i class="bi bi-cone-striped"></i></div>
        <div class="kicker">Aviso</div>
        <div class="msg">${esc(data.mensaje)}</div>
        <button class="ok">Entendido</button>
      </div>`;
  document.body.appendChild(ov);
  // "Entendido" colapsa el mensaje pero deja la pantalla gris con el logo (sigue bloqueado).
  ov.querySelector('.ok').addEventListener('click', () => { const b = ov.querySelector('.box'); if (b) b.remove(); });
});

/* ═══════════════════════════════════════════════════════════════
   🎮 HUMORADAS — juego flotante lanzado por BG-ADMIN a toda la app.
   Poll a /api/mantenimiento (mismo estado que la mantención): si hay
   un juego activo, carga /js/juegos.js y lo lanza en pantalla; si se
   apaga, lo cierra. También guarda es_bg para el menú de usuario.
   ═══════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  const token = sessionStorage.getItem('token');
  if (!token) return;
  let actual = null, armarFn = null;
  function cargarJuegos(cb) {
    if (window.AF_JUEGOS) return cb();
    const s = document.createElement('script'); s.src = '/js/juegos.js'; s.onload = cb; document.head.appendChild(s);
  }
  // La humorada se "arma" y se dispara con el PRIMER CLIC del usuario → así nos
  // aseguramos de que esté frente al computador (no le pasa estando ausente).
  function desarmar() { if (armarFn) { document.removeEventListener('click', armarFn, true); armarFn = null; } }
  function armar(nombre, mensaje, key) {
    desarmar();
    armarFn = function (e) {
      // Consumir el clic que dispara la humorada: si no, ese mismo clic navega/actúa
      // y la humorada aparece por una milésima y se va al recargar.
      if (e) { try { e.preventDefault(); e.stopPropagation(); if (e.stopImmediatePropagation) e.stopImmediatePropagation(); } catch (_) {} }
      desarmar(); sessionStorage.setItem('af_consumido', key);
      cargarJuegos(() => window.AF_JUEGOS && window.AF_JUEGOS.lanzar(nombre, mensaje));
    };
    document.addEventListener('click', armarFn, { capture: true, once: true });
  }
  // Prueba local (BG-ADMIN apretó "Probar aquí" en una humorada de pantalla → llega al Inicio).
  // "vidrio" persiste entre páginas hasta completar sus 10 quiebres; el resto es de una página.
  const probar = sessionStorage.getItem('af_probar');
  if (probar) {
    window.__AF_ESBG = true;   // a "Probar" solo llega el BG-ADMIN → muestra el chip de control
    sessionStorage.removeItem('af_probar');
    cargarJuegos(() => window.AF_JUEGOS && window.AF_JUEGOS.lanzar(probar, 'Modo prueba (solo tú lo ves)'));
  }
  // Banner "push" que baja desde arriba. Se apilan en un contenedor (arriba-centro).
  const escAn = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function afStack() {
    let s = document.getElementById('afPushStack');
    if (!s) {
      s = document.createElement('div'); s.id = 'afPushStack';
      s.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483600;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;';
      document.body.appendChild(s);
    }
    return s;
  }
  function bannerPush(texto, opts) {
    opts = opts || {};
    const bg = opts.bg || '#0a0a0a', fg = opts.fg || '#ffffff';
    const ancho = Math.min(100, Math.max(15, parseInt(opts.ancho) || 33));
    const b = document.createElement('div');
    b.style.cssText = 'pointer-events:auto;width:' + ancho + 'vw;min-width:300px;max-width:640px;background:' + bg + ';color:' + fg + ';'
      + 'border-radius:0 0 16px 16px;box-shadow:0 14px 44px rgba(0,0,0,.55);padding:15px 20px;display:flex;align-items:center;gap:13px;'
      + "font-family:'Segoe UI',system-ui,sans-serif;transform:translateY(-160%);transition:transform .6s cubic-bezier(.18,.89,.32,1.28);";
    b.innerHTML = '<span style="font-size:1.6rem;line-height:1">' + (opts.icon || '🎉') + '</span>'
      + '<div style="flex:1;font-size:.97rem;font-weight:600;letter-spacing:.2px">' + escAn(texto) + '</div>';
    let cerrado = false;
    function cerrar() { if (cerrado) return; cerrado = true; b.style.transform = 'translateY(-160%)'; setTimeout(() => b.remove(), 700); }
    if (opts.permanente) {
      const x = document.createElement('button');
      x.innerHTML = '&times;'; x.title = 'Cerrar';
      x.style.cssText = 'pointer-events:auto;background:transparent;border:none;color:' + fg + ';opacity:.65;font-size:1.4rem;line-height:1;cursor:pointer;padding:0 2px';
      x.onclick = () => { if (opts.onClose) try { opts.onClose(); } catch (_) {} cerrar(); };
      b.appendChild(x);
    }
    afStack().appendChild(b);
    requestAnimationFrame(() => { b.style.transform = 'translateY(0)'; });
    if (!opts.permanente) setTimeout(cerrar, Math.min(120, Math.max(2, parseInt(opts.dur) || 6)) * 1000);
    return { cerrar };
  }
  function mostrarAnuncio(texto, opts) { bannerPush(texto, opts); }
  window.afMostrarAnuncio = mostrarAnuncio;   // "Probar" desde el mantenedor de Alertas

  // ── Comunicados manuales dirigidos ──
  const COM_ON = {};   // id → handle de banner permanente en pantalla
  function comSeen() { try { return JSON.parse(localStorage.getItem('af_com_seen') || '[]'); } catch (_) { return []; } }
  function comMark(id) { const s = comSeen(); if (!s.includes(id)) { s.push(id); localStorage.setItem('af_com_seen', JSON.stringify(s.slice(-300))); } }
  function manejarComunicados(coms) {
    coms = Array.isArray(coms) ? coms : [];
    const ids = coms.map(c => c.id);
    // Cerrar permanentes que el admin desactivó (ya no vienen en la lista)
    Object.keys(COM_ON).forEach(id => { if (!ids.includes(parseInt(id, 10))) { COM_ON[id].cerrar(); delete COM_ON[id]; } });
    const seen = comSeen();
    const sonar = c => { if (c.sonido && c.sonido !== 'none') { try { if (window.afPlaySound) window.afPlaySound(c.sonido); } catch (e) {} } };
    coms.forEach(c => {
      if (c.permanente) {
        if (COM_ON[c.id] || seen.includes(c.id)) return;  // ya en pantalla o ya cerrado por el usuario
        sonar(c);
        COM_ON[c.id] = bannerPush(c.mensaje, { bg: c.bg, fg: c.fg, ancho: c.ancho, permanente: true, icon: '📣',
          onClose: () => { comMark(c.id); delete COM_ON[c.id]; } });
      } else {
        if (seen.includes(c.id)) return;
        comMark(c.id);
        sonar(c);
        bannerPush(c.mensaje, { bg: c.bg, fg: c.fg, ancho: c.ancho, dur: c.dur, icon: '📣' });
      }
    });
  }
  async function chk() {
    try {
      const r = await fetch('/api/mantenimiento?_=' + Date.now(), { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
      const j = await r.json();
      if (!j.success) return;
      window.__AF_ESBG = !!j.data.es_bg;
      // Anuncio push global (p.ej. "Juan Pérez acaba de colocar un nuevo crédito").
      // Sonido tipo aeropuerto y, 2s después, baja el banner. Dedup por nonce (1 vez por navegador).
      const an = j.data.anuncio;
      if (an && an.nonce && localStorage.getItem('af_anuncio_nonce') !== String(an.nonce)) {
        localStorage.setItem('af_anuncio_nonce', String(an.nonce));
        const o = an.opts || {};
        const antes = Math.min(10, Math.max(0, parseInt(o.antes) != null ? parseInt(o.antes) : 2)) * 1000;
        if (o.sonido && o.sonido !== 'none') { try { if (window.afPlaySound) window.afPlaySound(o.sonido); } catch (e) {} }
        setTimeout(() => mostrarAnuncio(an.texto, o), antes);
      }
      // Comunicados manuales dirigidos (persona/área/perfil/empresa)
      manejarComunicados(j.data.comunicados);
      const g = j.data.juego, nombre = g && g.nombre;
      const key = nombre ? (nombre + '|' + (g.nonce || '')) : null;
      if (key && key !== actual) {
        actual = key;
        // Dispara una vez por LANZAMIENTO (nombre+nonce): no re-dispara al navegar dentro del
        // mismo lanzamiento, pero si el BG relanza (nonce nuevo) vuelve a armar.
        if (sessionStorage.getItem('af_consumido') !== key) armar(nombre, g.mensaje, key);
      } else if (!nombre && actual) { actual = null; desarmar(); if (window.AF_JUEGOS) window.AF_JUEGOS.cerrar(); }
    } catch (e) {}
  }
  chk();
  setInterval(chk, 12000);
});
