/* ─────────────────────────────────────────────
   AutoFácil — Versión global de la aplicación
   Editar sólo este archivo para cambiar la versión
   ───────────────────────────────────────────── */
const APP_VERSION = 'v5.0';

document.addEventListener('DOMContentLoaded', () => {
  // Actualizar todos los badges de versión en la barra de navegación
  document.querySelectorAll('.version-badge, #versionBadge').forEach(el => {
    el.textContent = APP_VERSION;
  });
  // Actualizar la versión en la pantalla de login
  const loginVer = document.querySelector('.version strong');
  if (loginVer) loginVer.textContent = APP_VERSION;
});
