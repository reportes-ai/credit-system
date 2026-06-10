/* ─────────────────────────────────────────────
   AutoFácil — Versión global de la aplicación
   Editar SOLO este archivo para cambiar la versión
   ───────────────────────────────────────────── */
const APP_VERSION = 'v8.3';

document.addEventListener('DOMContentLoaded', () => {

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
