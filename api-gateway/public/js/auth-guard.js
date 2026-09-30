/**
 * auth-guard.js — Verificación de sesión en el cliente
 * Incluir con: <script src="/js/auth-guard.js"></script>
 * Se ejecuta inmediatamente al cargar. Redirige a /login.html si:
 *   - No hay token en localStorage
 *   - El token está expirado (decodifica el payload JWT sin verificar firma)
 *   - El token tiene formato inválido
 */
(function () {
  const token   = sessionStorage.getItem('token');
  const usuario = sessionStorage.getItem('usuario');

  function redirigir() {
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('usuario');
    /* Conservar el DESTINO: al llegar por un link (ej. desde un correo) sin
       sesión, el login devuelve a esta misma página vía ?next= en vez del home.
       Solo rutas locales (login.html ya valida que empiece con "/"). */
    const next = location.pathname + location.search;
    window.location.href = next && next !== '/' && !next.startsWith('/login')
      ? '/login.html?next=' + encodeURIComponent(next)
      : '/login.html';
  }

  /* ── Una pestaña nueva HEREDA la sesión de otra pestaña del mismo navegador (Pato, 28-09-2026) ──
     El token vive en sessionStorage (por pestaña, muere al cerrar el navegador). Sin esto, cada pestaña
     nueva pedía login, creaba una sesión más y el tope de 2 sesiones simultáneas cerraba una pestaña viva:
     Carmen hizo 8 logins en una mañana en cascada. Mecanismo: la pestaña nueva pide por localStorage
     ('af_pedir_sesion'); una pestaña con sesión responde escribiendo 'af_sesion' y borrándola en el mismo
     tick (queda solo el evento storage, nada en disco); la nueva copia token y usuario y recarga.
     Si nadie responde en 600 ms, va al login como siempre. */
  /* Con varias cuentas abiertas responden varias pestañas: gana la que el usuario USÓ más recientemente
     (foco), no la que escribió primero. Una pestaña "Ver como" nunca responde (su token es de solo lectura
     y sin el banner la pestaña nueva parecería una sesión normal). Una pestaña cuyo token ya murió por el
     tope de sesiones (af_token_muerto) tampoco ofrece ese token (code-review 30-09-2026). */
  if (!token || !usuario) {
    let resuelto = false, mejor = null, cierre = null;
    const adoptar = () => {
      if (resuelto || !mejor) return;
      resuelto = true;
      window.removeEventListener('storage', onStorage);
      sessionStorage.setItem('token', mejor.token);
      sessionStorage.setItem('usuario', mejor.usuario);
      location.reload();
    };
    const onStorage = (ev) => {
      if (ev.key !== 'af_sesion' || !ev.newValue || resuelto) return;
      try {
        const s = JSON.parse(ev.newValue);
        if (!s || !s.token || !s.usuario) return;
        if (!mejor || Number(s.foco || 0) > Number(mejor.foco || 0)) mejor = s;
        if (!cierre) cierre = setTimeout(adoptar, 250);   // ventana corta para que alcancen a responder las demás
      } catch (_) {}
    };
    window.addEventListener('storage', onStorage);
    try { localStorage.setItem('af_pedir_sesion', String(Date.now())); localStorage.removeItem('af_pedir_sesion'); } catch (_) {}
    setTimeout(() => { if (!resuelto) { if (mejor) adoptar(); else { window.removeEventListener('storage', onStorage); redirigir(); } } }, 700);
    return;
  }
  // Última vez que el usuario USÓ esta pestaña (decide quién responde cuando hay varias cuentas)
  window.__afFoco = Date.now();
  ['focus', 'pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, () => { window.__afFoco = Date.now(); }, true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) window.__afFoco = Date.now(); });
  // Esta pestaña tiene sesión: responde a las pestañas nuevas que la pidan
  window.addEventListener('storage', (ev) => {
    if (ev.key !== 'af_pedir_sesion' || !ev.newValue) return;
    try {
      if (sessionStorage.getItem('ver_como') === '1') return;
      const t = sessionStorage.getItem('token'), u = sessionStorage.getItem('usuario');
      if (!t || !u || sessionStorage.getItem('af_token_muerto') === t) return;
      localStorage.setItem('af_sesion', JSON.stringify({ token: t, usuario: u, foco: window.__afFoco || 0 }));
      localStorage.removeItem('af_sesion');
    } catch (_) {}
  });
  // Otra pestaña supo que ESTE token murió (tope de sesiones, cierre desde Usuarios): no volver a ofrecerlo
  window.addEventListener('storage', (ev) => {
    if (ev.key !== 'af_token_muerto' || !ev.newValue) return;
    try { if (ev.newValue === sessionStorage.getItem('token')) sessionStorage.setItem('af_token_muerto', ev.newValue); } catch (_) {}
  });
  /* "Salir" cierra SOLO esta pestaña (Pato, 29-09-2026: necesita varias cuentas en el mismo navegador).
     El login NUNCA hereda sesión: quien llega a login.html quiere elegir cuenta. Solo las pestañas
     nuevas abiertas sobre páginas de la Suite heredan (bloque de arriba). */

  try {
    // Decodificar el payload (segunda parte del JWT, base64url)
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    // Verificar expiración (exp está en segundos)
    if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) {
      redirigir();
      return;
    }
  } catch (e) {
    // Token con formato inválido
    redirigir();
    return;
  }

  // Poblar navbar — espera al DOM si los elementos aún no existen
  function poblarNav() {
    try {
      const u = JSON.parse(usuario);
      const nombre = [u.nombre || '', u.apellido || ''].filter(Boolean).join(' ');
      const perfil = u.perfil || u.perfil_nombre || '';
      const inicial = (u.nombre || '?').charAt(0).toUpperCase();
      const set = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
      set('navNombre', nombre);
      set('navPerfil', perfil);
      set('avatarInicial', inicial);
      set('navUser', u.nombre || '');
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', poblarNav);
  } else {
    poblarNav();
  }
})();
