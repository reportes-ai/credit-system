/**
 * alertas-vencimiento.js
 * Muestra popup al administrador cuando UF o Tasas requieren actualización.
 * Solo una vez por sesión de browser (sessionStorage).
 */
(function () {
  const STORAGE_KEY = 'alertas_venc_mostradas';
  const token = sessionStorage.getItem('token');
  if (!token) return;                              // no autenticado
  if (sessionStorage.getItem(STORAGE_KEY)) return; // ya se mostró en esta sesión

  // Esperar a que el DOM esté listo
  function init() {
    fetch('/api/alertas/vencimientos', {
      headers: { Authorization: 'Bearer ' + token }
    })
      .then(r => r.ok ? r.json() : null)
      .then(json => {
        if (!json || !json.success || !json.data.tiene_alertas) return;
        sessionStorage.setItem(STORAGE_KEY, '1');
        mostrarPopup(json.data);
      })
      .catch(() => {}); // silencioso — no interrumpir la app
  }

  function mostrarPopup(data) {
    // Estilos inline para ser independiente de cualquier CSS de la página
    const overlay = document.createElement('div');
    overlay.id = 'av-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;background:rgba(0,0,0,.55);
      z-index:99999;display:flex;align-items:center;justify-content:center;
      font-family:'Segoe UI',sans-serif;
    `;

    const criticas    = data.alertas.filter(a => a.nivel === 'critico');
    const advertencias = data.alertas.filter(a => a.nivel === 'advertencia');
    const tieneCriticas = criticas.length > 0;
    const colorHeader = tieneCriticas ? '#b71c1c' : '#e65100';
    const iconHeader  = tieneCriticas ? '🚨' : '⚠️';
    const titulo      = tieneCriticas ? 'Datos críticos requieren actualización' : 'Datos próximos a vencer';

    const itemsHTML = data.alertas.map(a => {
      const esCritico = a.nivel === 'critico';
      const bg    = esCritico ? '#fff5f5' : '#fffbf0';
      const borde = esCritico ? '#f5c6cb' : '#ffe082';
      const color = esCritico ? '#b71c1c' : '#e65100';
      const icon  = esCritico ? '🔴' : '🟡';
      return `
        <div style="background:${bg};border:1px solid ${borde};border-radius:10px;
                    padding:14px 16px;margin-bottom:10px">
          <div style="font-weight:700;color:${color};font-size:.95rem;margin-bottom:4px">
            ${icon} ${a.titulo}
          </div>
          <div style="font-size:.85rem;color:#444;line-height:1.5;margin-bottom:10px">
            ${a.mensaje}
          </div>
          <a href="${a.url}" onclick="cerrarAlertaVenc()"
             style="display:inline-block;background:${color};color:#fff;
                    border-radius:6px;padding:6px 16px;font-size:.82rem;
                    font-weight:700;text-decoration:none">
            ${a.boton} →
          </a>
        </div>`;
    }).join('');

    overlay.innerHTML = `
      <div style="background:#fff;border-radius:16px;padding:0;
                  max-width:480px;width:92%;box-shadow:0 8px 32px rgba(0,0,0,.25);
                  overflow:hidden">
        <!-- Header -->
        <div style="background:${colorHeader};color:#fff;padding:18px 24px;
                    display:flex;align-items:center;gap:12px">
          <span style="font-size:1.6rem">${iconHeader}</span>
          <div>
            <div style="font-weight:800;font-size:1rem">${titulo}</div>
            <div style="font-size:.78rem;opacity:.85;margin-top:2px">
              Sistema AutoFácil · ${new Date().toLocaleDateString('es-CL')}
            </div>
          </div>
        </div>
        <!-- Body -->
        <div style="padding:20px 24px">
          <p style="font-size:.85rem;color:#555;margin:0 0 14px">
            Los siguientes datos requieren tu atención antes de continuar operando:
          </p>
          ${itemsHTML}
        </div>
        <!-- Footer -->
        <div style="padding:12px 24px 20px;display:flex;justify-content:flex-end;
                    border-top:1px solid #f0f0f0;gap:10px">
          <button onclick="cerrarAlertaVenc()"
                  style="background:#f5f5f5;color:#555;border:none;border-radius:8px;
                         padding:9px 22px;font-weight:600;font-size:.88rem;cursor:pointer">
            Recordar más tarde
          </button>
          <button onclick="cerrarAlertaVencHoy()"
                  style="background:#1a237e;color:#fff;border:none;border-radius:8px;
                         padding:9px 22px;font-weight:700;font-size:.88rem;cursor:pointer">
            Entendido, no mostrar hoy
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    // Cerrar al hacer click fuera del modal
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) cerrarAlertaVenc();
    });
  }

  window.cerrarAlertaVenc = function () {
    const el = document.getElementById('av-overlay');
    if (el) el.remove();
    // Limpiar la clave para que aparezca de nuevo la próxima vez que naveguen
    sessionStorage.removeItem(STORAGE_KEY);
  };

  window.cerrarAlertaVencHoy = function () {
    const el = document.getElementById('av-overlay');
    if (el) el.remove();
    // Ya está guardado en sessionStorage — no aparecerá en toda la sesión
  };

  // Ejecutar tras 1.5s para no interferir con la carga inicial de la página
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1500));
  } else {
    setTimeout(init, 1500);
  }
})();
