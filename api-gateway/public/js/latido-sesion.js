/* ═══════════════════════════════════════════════════════════════
   💓 LATIDO DE SESIÓN — motor único (30-09-2026).
   Marca presencia cada 60 s en /api/desempeno/ping, SOLO si hubo actividad real (mouse, teclado,
   toque, scroll o volver a la pestaña) en los últimos 10 minutos: así last_seen refleja al usuario
   y no a una pestaña olvidada, y el motor sesiones-inactivas cierra la sesión según "Tiempo de
   inactividad" (Usuarios → Seguridad).
   Antes vivía dentro de app-version.js, y las páginas que no lo cargan (Cuadro de Mando TV, las PWA
   de terreno, el Generador de Cartas, Diseño de Consulta, Cierre Contable, Asistencia, Horarios
   Analistas) no latían: el motor las cerraba a los 60 min aunque estuvieran en uso. Ahora lo cargan
   todas (app-version.js lo inyecta; las demás lo incluyen a mano).
   · window.AF_LATIDO_SIEMPRE = true (antes de cargar esto): late sin exigir actividad — pantallas sin
     operador, como la TV del Cuadro de Mando.
   · Token: sessionStorage (staff) y, si no hay, localStorage (PWA).
   ═══════════════════════════════════════════════════════════════ */
(function () {
  if (window.__afLatidoSesion) return;   // una sola vez por pestaña aunque lo carguen dos scripts
  window.__afLatidoSesion = true;
  const token = () => { try { return sessionStorage.getItem('token') || localStorage.getItem('token') || ''; } catch (_) { return ''; } };
  let ultimaActividad = Date.now();
  const marcar = () => { ultimaActividad = Date.now(); };
  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'focus'].forEach(ev => window.addEventListener(ev, marcar, { passive: true }));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) marcar(); });
  const ping = () => {
    const t = token();
    if (!t) return;
    if (!window.AF_LATIDO_SIEMPRE && Date.now() - ultimaActividad > 10 * 60000) return;
    fetch('/api/desempeno/ping', { method: 'POST', headers: { Authorization: 'Bearer ' + t } }).catch(() => {});
  };
  const arrancar = () => { ping(); setInterval(ping, 60000); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrancar);
  else arrancar();
})();
