// Alerta por correo cuando ocurre un 500 en producción (objetivo tipo Sentry, sin servicio externo).
// Destino: env ALERTA_ERRORES_MAIL (si no está definida, solo queda el console.error de siempre).
// Throttle: máx 1 correo por ruta cada 10 min; los repetidos se acumulan y se informan en el siguiente.
// Usa shared/mailer → respeta Modo Desarrollo (el correo se redirige a las casillas de prueba).

const DESTINO   = process.env.ALERTA_ERRORES_MAIL || '';
const VENTANA_MS = 10 * 60 * 1000;

const rutas = new Map(); // rutaBase -> { ultimoMail: ts, acumulados: n }

function rutaBase(url) {
  // Agrupa /api/creditos/123 y /api/creditos/456 como la misma ruta
  return (url || '').split('?')[0].replace(/\/\d+(\b|$)/g, '/:id').slice(0, 120);
}

function alertar500(req, detalle) {
  if (!DESTINO) return;
  try {
    const clave = `${req.method} ${rutaBase(req.originalUrl)}`;
    const ahora = Date.now();
    const r = rutas.get(clave) || { ultimoMail: 0, acumulados: 0 };
    r.acumulados++;
    if (ahora - r.ultimoMail < VENTANA_MS) { rutas.set(clave, r); return; }

    const repetidos = r.acumulados;
    r.ultimoMail = ahora; r.acumulados = 0;
    rutas.set(clave, r);

    const { enviarCorreo, mailConfigurado } = require('./mailer');
    if (!mailConfigurado()) return;
    const cuerpo = `
      <p><b>Error 500 en producción</b></p>
      <p><b>Ruta:</b> ${clave}<br>
      <b>Ocurrencias en la ventana:</b> ${repetidos}<br>
      <b>Hora (Chile):</b> ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}</p>
      <p><b>Detalle técnico:</b></p>
      <pre style="background:#f4f4f4;padding:10px;border-radius:6px;white-space:pre-wrap">${String(detalle).slice(0, 2000)}</pre>
      <p style="color:#888;font-size:12px">Máx. 1 correo por ruta cada 10 min. Revisa los logs de Render para el stack completo.</p>`;
    // fire-and-forget: jamás bloquear ni romper la respuesta al usuario
    enviarCorreo({ to: DESTINO, subject: `⚠️ Error 500 — ${clave}`, html: cuerpo }).catch(() => {});
  } catch (e) { /* la alerta nunca debe causar otro error */ }
}

module.exports = alertar500;
