/* ─────────────────────────────────────────────────────────────────────────
   AutoFácil — Barra superior ÚNICA (componente)
   Fuente de verdad de la navbar: el markup y el CSS viven aquí, no en cada
   página. Así todas las páginas tienen exactamente la misma barra y se edita
   en un solo lugar (filosofía anti-hardcode del sistema).

   Uso por página:
     1) Colocar el placeholder donde va la barra:   <div id="af-topnav"></div>
     2) (opcional) Configurar breadcrumb y botones de acción ANTES de incluir
        este script:
          <script>window.AF_TOPNAV = {
            breadcrumb: [
              { label:'Inicio', href:'/' },
              { label:'Créditos', href:'/creditos' },
              { label:'Validación de Firma', icon:'bi-shield-check', current:true }
            ],
            actions: [
              { label:'Ver Firma Cédula', icon:'bi-person-vcard-fill', onclick:'toggleCedPanel()' },
              { label:'Volver', icon:'bi-arrow-left', href:'/creditos' }
            ],
            dashboard: true      // muestra el acceso a Dashboard (default true)
          };</script>
     3) Incluir este script ANTES de app-version.js:
          <script src="/js/topnav.js"></script>
          <script src="/js/app-version.js"></script>

   La VERSIÓN, la CAMPANA de notificaciones y el MENÚ de usuario (cambiar
   contraseña, etc.) los completa app-version.js sobre los elementos
   .version-badge / .user-chip que genera este componente.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function injectCSS() {
    if (document.getElementById('af-topnav-css')) return;
    const st = document.createElement('style');
    st.id = 'af-topnav-css';
    st.textContent = `
      .topnav{background:linear-gradient(90deg,#012d70,#0141A2);color:#fff;height:60px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:200;box-shadow:0 2px 8px rgba(0,0,0,.3)}
      .topnav-left{display:flex;align-items:center;gap:16px;min-width:0}
      .topnav-brand{display:flex;align-items:center;gap:8px;text-decoration:none;flex:0 0 auto}
      .topnav-brand img{height:32px;display:block;filter:brightness(0) invert(1)}
      .version-badge{background:rgba(255,255,255,.15);color:rgba(255,255,255,.75);font-size:.65rem;font-weight:700;border-radius:6px;padding:2px 8px;letter-spacing:.5px;white-space:nowrap}
      .breadcrumb-nav{color:rgba(255,255,255,.6);font-size:.85rem;display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;white-space:nowrap}
      .breadcrumb-nav a{color:rgba(255,255,255,.75);text-decoration:none}
      .breadcrumb-nav a:hover{color:#fff}
      .breadcrumb-nav .sep{color:rgba(255,255,255,.35)}
      .breadcrumb-nav .cur{color:#fff;font-weight:600;overflow:hidden;text-overflow:ellipsis}
      .topnav-right{display:flex;align-items:center;gap:10px;flex:0 0 auto}
      .topnav-right .af-act{display:inline-flex;align-items:center;gap:6px;color:#fff;text-decoration:none;font-size:.82rem;font-weight:600;padding:6px 13px;border-radius:8px;border:1px solid rgba(255,255,255,.25);background:rgba(255,255,255,.1);cursor:pointer;white-space:nowrap}
      .topnav-right .af-act:hover{background:rgba(255,255,255,.2)}
      .topnav-right .af-act.primary{background:#fff;color:#0141A2;border-color:#fff}
      .topnav-right .af-dash{display:inline-flex;align-items:center;gap:5px;color:rgba(255,255,255,.85);text-decoration:none;font-size:12px;font-weight:500;padding:5px 10px;border:1px solid rgba(255,255,255,.25);border-radius:6px;white-space:nowrap}
      .topnav-right .af-dash:hover{background:rgba(255,255,255,.1)}
      .user-chip{background:rgba(255,255,255,.12);border-radius:24px;padding:5px 12px;display:flex;align-items:center;gap:8px;font-size:.85rem;color:#fff}
      .user-chip .avatar{width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.25);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:.8rem;flex:0 0 auto}
      .user-chip .perfil-badge{font-size:.66rem;opacity:.78;line-height:1.2}
      .btn-logout{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;border-radius:8px;padding:6px 12px;font-size:.82rem;cursor:pointer;white-space:nowrap}
      .btn-logout:hover{background:rgba(255,255,255,.2)}
      @media print{.topnav{display:none !important}}
    `;
    document.head.appendChild(st);
  }

  function breadcrumbHTML(items) {
    if (!items || !items.length) return '';
    return '<div class="breadcrumb-nav">' + items.map((it, i) => {
      const sep = i > 0 ? '<span class="sep">›</span>' : '';
      const ic = it.icon ? '<i class="bi ' + esc(it.icon) + ' me-1"></i>' : '';
      const isCur = it.current || (!it.href && i === items.length - 1);
      return isCur
        ? sep + '<span class="cur">' + ic + esc(it.label) + '</span>'
        : sep + '<a href="' + esc(it.href || '#') + '">' + ic + esc(it.label) + '</a>';
    }).join('') + '</div>';
  }

  function actionHTML(a) {
    const ic = a.icon ? '<i class="bi ' + esc(a.icon) + '"></i>' : '';
    const cls = 'af-act' + (a.variant === 'primary' ? ' primary' : '');
    const title = a.title ? ' title="' + esc(a.title) + '"' : '';
    const id = a.id ? ' id="' + esc(a.id) + '"' : '';
    return a.href
      ? '<a' + id + ' class="' + cls + '" href="' + esc(a.href) + '"' + title + '>' + ic + esc(a.label) + '</a>'
      : '<button type="button"' + id + ' class="' + cls + '" onclick="' + esc(a.onclick || '') + '"' + title + '>' + ic + esc(a.label) + '</button>';
  }

  // Secciones (pantallas) → crumb padre. Refleja PLACEMENT_SECTIONS de placement-manifest.js.
  // 'home' = card de nivel superior → el breadcrumb queda solo "Inicio › Título".
  var SECTIONS = {
    clientes:     { label: 'Clientes',             href: '/clientes/' },
    cotizaciones: { label: 'Cotizaciones',         href: '/cotizaciones/' },
    creditos:     { label: 'Créditos',             href: '/creditos/' },
    tesoreria:    { label: 'Tesorería',            href: '/tesoreria/' },
    crm:          { label: 'CRM',                  href: '/crm/' },
    cobranza:     { label: 'Cobranza',             href: '/cobranza/' },
    reporteria:   { label: 'Reportería',           href: '/reporteria/' },
    comisiones:   { label: 'Comisión Ejecutivos',  href: '/comisiones/' },
    mantenedores: { label: 'Mantenedores',         href: '/mantenedores/' },
    usuarios:     { label: 'Usuarios',             href: '/usuarios/' },
    cartas:       { label: 'Cartas de Aprobación', href: '/aprobaciones/' },
    politica:     { label: 'Política',             href: '/politica/' },
    simulador:    { label: 'Simulador',            href: '/simulador/' },
    carga_masiva: { label: 'Carga Masiva',         href: '/carga-masiva/' },
  };

  // Construye el breadcrumb desde self + la sección resuelta: Inicio › [Sección] › Título › [extra…]
  function selfCrumbs(self, section) {
    var items = [{ label: 'Inicio', href: '/' }];
    var sec = SECTIONS[section];
    if (sec) items.push({ label: sec.label, href: sec.href });
    var extra = self.extra && self.extra.length ? self.extra : null;
    items.push(extra
      ? { label: self.title, icon: self.icon, href: self.selfHref || '#' }
      : { label: self.title, icon: self.icon, current: true });
    if (extra) extra.forEach(function (e, i) {
      items.push({ label: e.label, icon: e.icon, href: e.href, current: i === extra.length - 1 });
    });
    return items;
  }

  // Resuelve la sección donde está colocado el card (placement_v2 manda; defaultSection si no está).
  function resolveSection(self, cb) {
    var def = self.defaultSection || 'home';
    var token = null; try { token = sessionStorage.getItem('token'); } catch (_) {}
    if (!token) return cb(def);
    fetch('/api/config/ui/placement_v2', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var p = (j && j.success && j.data && typeof j.data === 'object') ? j.data : {};
        var keys = [self.key, self.selfHref].filter(Boolean);
        for (var sec in p) {                                  // formato nuevo: { seccion: [keys] }
          if (Array.isArray(p[sec]) && p[sec].some(function (k) { return keys.indexOf(k) >= 0; })) return cb(sec);
        }
        for (var i = 0; i < keys.length; i++) {               // formato viejo: { key: 'seccion' }
          if (typeof p[keys[i]] === 'string') return cb(p[keys[i]]);
        }
        cb(def);
      })
      .catch(function () { cb(def); });
  }

  function render() {
    const mount = document.getElementById('af-topnav');
    if (!mount) return;                       // página aún no migrada → no hace nada
    injectCSS();
    const cfg = window.AF_TOPNAV || {};
    let yo = null;
    try { yo = JSON.parse(sessionStorage.getItem('usuario') || 'null'); } catch (_) {}
    const nombre = yo ? ((yo.nombre || '') + ' ' + (yo.apellido || '')).trim() : '';
    const inicial = (nombre || '?').trim().charAt(0).toUpperCase() || '?';
    const dash = cfg.dashboard === false ? ''
      : '<a class="af-dash" href="/dashboard" title="Dashboard Analytics"><i class="bi bi-bar-chart-line" style="font-size:15px"></i> Dashboard</a>';
    const actions = (cfg.actions || []).map(actionHTML).join('');

    // Breadcrumb: estático si la página lo define; si declara self, se arma desde el placement
    // (provisional con defaultSection y se refina al resolver placement_v2 — sigue al card si se mueve).
    let bcItems = cfg.breadcrumb;
    if (!bcItems && cfg.self) bcItems = selfCrumbs(cfg.self, cfg.self.defaultSection || 'home');

    mount.outerHTML =
      '<nav class="topnav">' +
        '<div class="topnav-left">' +
          '<a href="' + esc(cfg.brandHref || '/') + '" class="topnav-brand">' +
            '<img src="/img/logo.png" alt="AutoFácil">' +
            '<span class="version-badge" id="versionBadge">v—</span>' +
          '</a>' +
          breadcrumbHTML(bcItems) +
        '</div>' +
        '<div class="topnav-right">' +
          actions + dash +
          '<div class="user-chip">' +
            '<div class="avatar" id="avatarInicial">' + esc(inicial) + '</div>' +
            '<div>' +
              '<div style="font-weight:600;line-height:1.3;color:#fff" id="navNombre">' + esc(nombre || '—') + '</div>' +
              '<div class="perfil-badge" id="navPerfil">' + esc((yo && yo.perfil) || '—') + '</div>' +
            '</div>' +
          '</div>' +
          '<button type="button" class="btn-logout" onclick="(window.logout||window.afLogout)()"><i class="bi bi-box-arrow-right me-1"></i>Salir</button>' +
        '</div>' +
      '</nav>';

    // Refina el breadcrumb con la sección real del placement (cuando la página declara self).
    if (!cfg.breadcrumb && cfg.self) {
      resolveSection(cfg.self, function (sec) {
        const html = breadcrumbHTML(selfCrumbs(cfg.self, sec));
        const el = document.querySelector('.topnav .breadcrumb-nav');
        if (el) el.outerHTML = html;
        else { const left = document.querySelector('.topnav .topnav-left'); if (left) left.insertAdjacentHTML('beforeend', html); }
      });
    }
  }

  // Logout estándar (si la página no define el suyo).
  window.afLogout = function () {
    try { sessionStorage.removeItem('token'); sessionStorage.removeItem('usuario'); } catch (_) {}
    location.href = '/login.html';
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
