/* ─────────────────────────────────────────────
   AutoFácil — Versión global de la aplicación
   Editar SOLO este archivo para cambiar la versión
   ───────────────────────────────────────────── */
const APP_VERSION = 'v5.0';

document.addEventListener('DOMContentLoaded', () => {

  /* 1 ── Versión en todos los badges de la barra de navegación */
  document.querySelectorAll('.version-badge, #versionBadge').forEach(el => {
    el.textContent = APP_VERSION;
  });

  /* 2 ── Versión en el footer del login */
  const loginVer = document.querySelector('.version strong');
  if (loginVer) loginVer.textContent = APP_VERSION;

  /* 3 ── Normalizar layout del logo en todas las páginas
           Problema: algunas páginas tienen <div class="topnav-brand">
           sin display:flex, y el <a> interno con img display:block
           empuja el badge de versión hacia abajo.
           Solución: forzar flex en .topnav-brand y normalizar img a 32px */
  document.querySelectorAll('.topnav-brand').forEach(brand => {
    Object.assign(brand.style, {
      display:        'flex',
      alignItems:     'center',
      gap:            '8px',
      textDecoration: 'none',
    });
    /* El <a> interno que solo envuelve el logo también debe ser flex */
    brand.querySelectorAll('a').forEach(a => {
      if (a.querySelector('img')) {
        Object.assign(a.style, { display: 'flex', alignItems: 'center' });
      }
    });
    /* Altura uniforme 32px y sin display:block que rompe el flujo */
    brand.querySelectorAll('img').forEach(img => {
      Object.assign(img.style, { height: '32px', display: 'inline-block' });
    });
  });

});
