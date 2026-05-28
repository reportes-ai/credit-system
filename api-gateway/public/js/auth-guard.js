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
    window.location.href = '/login.html';
  }

  if (!token || !usuario) { redirigir(); return; }

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

  // Poblar elementos de navbar con datos del usuario (ids estándar usados en todas las páginas)
  try {
    const u = JSON.parse(usuario);
    const nombre = [u.nombre || '', u.apellido || ''].filter(Boolean).join(' ');
    const perfil = u.perfil || u.perfil_nombre || '';
    const inicial = (u.nombre || '?').charAt(0).toUpperCase();

    const elNombre   = document.getElementById('navNombre');
    const elPerfil   = document.getElementById('navPerfil');
    const elAvatar   = document.getElementById('avatarInicial');
    const elNavUser  = document.getElementById('navUser');   // algunas páginas usan este id

    if (elNombre)  elNombre.textContent  = nombre;
    if (elPerfil)  elPerfil.textContent  = perfil;
    if (elAvatar)  elAvatar.textContent  = inicial;
    if (elNavUser) elNavUser.textContent = u.nombre || '';
  } catch (e) {}
})();
