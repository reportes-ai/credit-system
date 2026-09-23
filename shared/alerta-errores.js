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

/* ── En cristiano (Pato, 23-09-2026): qué pasó, dónde, qué hacer ─────────────── */
const MODULOS = [
  ['/api/mando', 'Cuadro de Mando (TV)'], ['/api/dashboard', 'Dashboard'], ['/api/creditos', 'Créditos'],
  ['/api/clientes', 'Clientes'], ['/api/comisiones', 'Comisiones'], ['/api/cartas', 'Cartas de Aprobación'],
  ['/api/cartolas', 'Cartolas'], ['/api/postventa', 'Post Venta'], ['/api/tesoreria', 'Tesorería'],
  ['/api/ordenes-pago', 'Órdenes de Pago'], ['/api/contabilidad', 'Contabilidad'], ['/api/rrhh', 'Recursos Humanos'],
  ['/api/cobranza', 'Cobranza'], ['/api/reporteria', 'Reportería'], ['/api/usuarios', 'Usuarios'], ['/api/auth', 'Ingreso al sistema'],
  ['/api/mantenedores', 'Mantenedores'], ['/api/crm', 'CRM'], ['/api/cotizaciones', 'Simulador'], ['/api/notif', 'Campanita'],
  ['/api/portal', 'Portal'], ['/api/dealers', 'Dealers'], ['/api/certificados', 'Certificados'], ['/api/evaluacion', 'Evaluación Crediticia'],
];
function moduloDe(ruta) { const m = MODULOS.find(([p]) => ruta.startsWith(p)); return m ? m[1] : 'Sistema'; }
const CAUSAS = [
  [/ETIMEDOUT|ECONNRESET|PROTOCOL_CONNECTION_LOST|read ECONNRESET|Connection lost/i,
    'La base de datos no respondió a tiempo (se cortó la conexión). Suele ser un corte momentáneo de la base o de la red: el sistema se reconecta solo.',
    'Si vuelve a pasar en los próximos minutos, revisa el estado de TiDB Cloud y /api/health. Si es uno solo, no hay nada que hacer.'],
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i,
    'No se pudo conectar a un servicio externo (base de datos, correo o una API).',
    'Revisa que el servicio esté arriba y las credenciales en Render.'],
  [/ER_LOCK_WAIT_TIMEOUT|Deadlock/i,
    'Dos procesos intentaron escribir el mismo registro al mismo tiempo y uno esperó demasiado.',
    'Reintentar la operación normalmente lo resuelve.'],
  [/ER_NO_SUCH_TABLE|ER_BAD_FIELD_ERROR|Unknown column|doesn't exist/i,
    'El código pide una tabla o columna que no existe en la base (falta una migración o hay un nombre mal escrito).',
    'Es un error de programación: hay que corregirlo en el código.'],
  [/ER_DUP_ENTRY|Duplicate entry/i,
    'Se intentó guardar un registro que ya existe (clave duplicada).',
    'Revisa si la operación se hizo dos veces; el dato no se guardó de nuevo.'],
  [/Too many connections|ER_CON_COUNT_ERROR/i,
    'La base de datos se quedó sin conexiones disponibles.',
    'Revisa si hay otro host con motores encendidos (/api/health → doble_host) o un proceso pegado.'],
  [/heap out of memory|ENOMEM/i,
    'El servidor se quedó sin memoria.',
    'Render lo reinicia solo; si se repite, hay que revisar qué proceso consume tanto.'],
  [/is not a function|Cannot read propert|undefined|null/i,
    'Un error de programación: el código intentó usar un dato que venía vacío.',
    'Es un bug: hay que corregirlo en el código. El detalle técnico de abajo dice dónde.'],
  [/JSON|Unexpected token/i,
    'Llegó una respuesta o un archivo con un formato que el sistema no entendió.',
    'Suele venir de una API externa que devolvió algo distinto a lo esperado.'],
];
function enCristiano(detalle) {
  const d = String(detalle || '');
  const c = CAUSAS.find(([re]) => re.test(d));
  return c ? { que: c[1], hacer: c[2] } : { que: 'Un error inesperado del servidor.', hacer: 'Revisa el detalle técnico de abajo o pídele a Claude que lo mire.' };
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
    const modulo = moduloDe(rutaBase(req.originalUrl));
    const { que, hacer } = enCristiano(detalle);
    const quien = req.usuario ? [req.usuario.nombre, req.usuario.apellido].filter(Boolean).join(' ') || req.usuario.email || '' : '';
    const veces = repetidos > 1 ? `Pasó <b>${repetidos} veces</b> en los últimos 10 minutos.` : 'Pasó <b>una vez</b>.';
    const cuerpo = `
      <p style="font-size:15px"><b>Falló algo en ${modulo}</b></p>
      <p><b>¿Qué pasó?</b> ${que}</p>
      <p><b>¿Dónde?</b> En ${modulo}${quien ? `, cuando ${quien} estaba usándolo` : ''}. ${veces}<br>
      <b>¿Cuándo?</b> ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })} (hora de Chile)</p>
      <p><b>¿Qué hacer?</b> ${hacer}</p>
      <p style="color:#888;font-size:12px;margin-top:18px">Detalle técnico (para Claude o el programador): <code>${clave}</code></p>
      <pre style="background:#f4f4f4;padding:10px;border-radius:6px;white-space:pre-wrap;font-size:12px;color:#555">${String(detalle).slice(0, 2000)}</pre>
      <p style="color:#888;font-size:12px">Se manda como máximo un correo por pantalla cada 10 minutos.</p>`;
    // fire-and-forget: jamás bloquear ni romper la respuesta al usuario
    enviarCorreo({ to: DESTINO, subject: `⚠️ Falló algo en ${modulo}: ${que.split(/[.(:]/)[0].trim()}`, html: cuerpo }).catch(() => {});
  } catch (e) { /* la alerta nunca debe causar otro error */ }
}

module.exports = alertar500;
