# Receta: migrar navbar propia → componente topnav (ola 2)

Referencia terminada: `api-gateway/public/reporteria/cartera-creditos/index.html`. Docs del componente: encabezado de `api-gateway/public/js/topnav.js`. Cambios QUIRÚRGICOS: nunca reescribir el archivo completo.

1. Reemplazar ÍNTEGRO el bloque `<nav class="topnav">…</nav>` por:
```html
<div id="af-topnav"></div>
<script>window.AF_TOPNAV={breadcrumb:[...]};</script>
```
   - Breadcrumb = réplica EXACTA de la miga del nav viejo: `{label:'Inicio',href:'/'}`, niveles intermedios con href, último `{label:'Título',icon:'bi-…',current:true}` (icon del span final; si no tenía, sin icon).
   - Si el nav viejo NO tenía breadcrumb, construirlo según la ubicación real de la página (ej. `Inicio › Mantenedores › X`), regla de migas del proyecto: toda página con miga completa.
   - Botones EXTRA del nav (Volver, Imprimir, config, etc.) → `actions:[{label,icon,onclick|href,id?,title?}]`. Si el JS los muestra/oculta por `style.display` o los toca por id: conservar el id en la action y mover ese acceso a un listener `load`/`DOMContentLoaded` con null-check (el componente renderiza en DOMContentLoaded; acceso en parse-time = TypeError). Si nacían ocultos, agregar CSS por id `#idBoton{display:none}` para evitar flash.
   - NO usar `dashboard:false` aunque el nav viejo no tuviera link a Dashboard: el componente lo gatea por permiso (conducta estándar del sitio).

2. Scripts: `<script src="/js/topnav.js"></script>` SIEMPRE antes de `/js/app-version.js`. Si app-version.js ya está, insertar justo antes (donde esté). Si falta, agregar ambos antes de `</body>`.

3. Escrituras del JS de la página a `navNombre` / `navPerfil` / `avatarInicial`: eliminar solo esas líneas (el componente pinta identidad); si están enredadas en una función, null-check. NUNCA eliminar `logout()` (el botón del componente llama `window.logout`). Si la página no tiene `logout()` (Salir inline), crear `function logout(){ … }` replicando la conducta EXACTA del inline viejo.

4. NO borrar el CSS local `.topnav`. NO tocar footers "Qué afecta este mantenedor" ni ninguna otra lógica.

5. Versión: bump del comentario `<!-- vX.Y -->` si existe; si la versión vivía solo en el span del nav, agregar el comentario bumpeado junto al `<title>`.

6. SPA: si la página cambia de VISTA interna sin navegar (pantallas con identidad propia), cablear `AF_TOPNAV_HOJA('Vista')` en la función central de cambio y `AF_TOPNAV_HOJA(null)` al volver al home interno. Tabs que son FILTROS de la misma tabla, drawers o modales NO cambian la miga. Si es ambiguo: no tocar y reportar.

7. NO hacer commit. NO tocar `/cartas-aprobacion/` ni `api-gateway/public/index.html` (home). NO subir APP_VERSION global (lo hace el caller).

Reporte final por página: breadcrumb, actions rescatadas, escrituras eliminadas, HOJA cableado/no aplica/pendiente, anomalías.
