/**
 * auth-guard.js — Verificación de sesión en el cliente
 * Incluir con: <script src="/js/auth-guard.js"></script>
 * Se ejecuta inmediatamente al cargar. Redirige a /login.html si:
 *   - No hay token en localStorage
 *   - El token está expirado (decodifica el payload JWT sin verificar firma)
 *   - El token tiene formato inválido
 */
(function () {
  const token   = localStorage.getItem('token');
  const usuario = localStorage.getItem('usuario');

  function redirigir() {
    localStorage.removeItem('token');
    localStorage.removeItem('usuario');
    window.location.href = '/login.html';
  }

  if (!token || !usuario) { redirigir(); return; }

  try {
    // Decodificar el payload (segunda parte del JWT, base64url)
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    // Verificar expiración (exp está en segundos)
    if (payload.exp && Math.floor(Date.now() / 1000) >= payload.exp) {
      redirigir();
    }
  } catch (e) {
    // Token con formato inválido
    redirigir();
  }
})();
