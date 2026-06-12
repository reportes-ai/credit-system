/* ─────────────────────────────────────────────
   AutoFácil — Versión global de la aplicación
   Editar SOLO este archivo para cambiar la versión
   ───────────────────────────────────────────── */
const APP_VERSION = 'v12.3';

document.addEventListener('DOMContentLoaded', () => {

  /* 0 ── Cards de navegación uniformes en toda la app (CSS scopeado) */
  if (!document.getElementById('af-cards-uniform')) {
    const lk = document.createElement('link');
    lk.id = 'af-cards-uniform';
    lk.rel = 'stylesheet';
    lk.href = '/css/cards-uniform.css';
    document.head.appendChild(lk);
  }

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

  // ── Punto de anclaje: junto al chip de usuario, o flotante si no hay topnav
  const chip = document.querySelector('.user-chip');
  const anchor = chip ? chip.parentElement : null;

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
      <div style="padding:11px 16px;font-weight:800;font-size:.85rem;color:#012d70;border-bottom:1px solid #f1f5f9;display:flex;justify-content:space-between;align-items:center">
        Notificaciones
        <button id="afBtnPushOn" style="display:none;border:none;background:#eff6ff;color:#1d4ed8;border-radius:7px;padding:3px 10px;font-size:.7rem;font-weight:700;cursor:pointer"><i class="bi bi-bell-fill"></i> Activar push</button>
      </div>
      <div id="afBellList" style="font-size:.8rem"></div>
    </div>`;
  if (anchor) anchor.insertBefore(wrap, chip);
  else document.body.appendChild(wrap);

  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  let unread = -1;   // -1 = primera carga, no suena

  /* 🛎️ doble ding de campana de hotel */
  function dingDing() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const ding = (t0) => {
        const o1 = ctx.createOscillator(), g1 = ctx.createGain();
        const o2 = ctx.createOscillator(), g2 = ctx.createGain();
        o1.type = 'sine'; o1.frequency.value = 1318;
        o2.type = 'sine'; o2.frequency.value = 1976;
        g1.gain.setValueAtTime(0.5, t0);  g1.gain.exponentialRampToValueAtTime(0.001, t0 + 0.9);
        g2.gain.setValueAtTime(0.18, t0); g2.gain.exponentialRampToValueAtTime(0.001, t0 + 0.6);
        o1.connect(g1).connect(ctx.destination);
        o2.connect(g2).connect(ctx.destination);
        o1.start(t0); o1.stop(t0 + 1); o2.start(t0); o2.stop(t0 + 0.7);
      };
      ding(ctx.currentTime); ding(ctx.currentTime + 0.45);
      setTimeout(() => ctx.close(), 2000);
    } catch (e) {}
  }
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
      if (unread >= 0 && noLeidas > unread) dingDing();
      unread = noLeidas;
      const list = document.getElementById('afBellList');
      list.innerHTML = rows.length ? rows.map(n => `
        <div data-href="${escN(n.href || '')}" class="af-notif-item" style="padding:10px 16px;border-bottom:1px solid #f8fafc;cursor:pointer;${n.leida ? '' : 'background:#eff6ff'}">
          <div style="font-weight:700;color:#0f172a">${escN(n.titulo)}</div>
          <div style="color:#475569;margin:2px 0">${escN(n.mensaje || '')}</div>
          <div style="font-size:.68rem;color:#94a3b8">${new Date(n.created_at).toLocaleString('es-CL')}</div>
        </div>`).join('')
        : '<div style="padding:20px;text-align:center;color:#94a3b8">Sin notificaciones</div>';
      list.querySelectorAll('.af-notif-item').forEach(el => {
        el.addEventListener('click', () => { const h = el.dataset.href; if (h) location.href = h; });
      });
    } catch (e) {}
  }

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
  if ('Notification' in window) {
    if (Notification.permission === 'granted') suscribir();
    else if (Notification.permission === 'default') btnPush.style.display = '';
  }
});
