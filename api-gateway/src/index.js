// Forzar timezone Chile antes de cualquier operación de fecha
process.env.TZ = 'America/Santiago';

const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'https://credit-system-45em.onrender.com',
  credentials: true
}));
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
app.use(express.json({ limit: '10mb' }));

// ── Sanitizar errores 500: el detalle técnico va al log, nunca al cliente ──
// (los 4xx pasan intactos: son mensajes de negocio como "mes cerrado")
app.use((req, res, next) => {
  const _json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500 && body && body.error) {
      console.error(`[500] ${req.method} ${req.originalUrl} →`, body.error);
      body = { ...body, error: 'Error interno del servidor. Si persiste, contacta al administrador.' };
    }
    return _json(body);
  };
  next();
});

// Los HTML (páginas) nunca se cachean: así un cambio (permisos, gating, etc.) aplica al recargar.
// Los assets con extensión (.js/.css/.png…) mantienen su caché normal para performance.
app.use((req, res, next) => {
  if (req.method === 'GET') {
    const p = req.path;
    const esHtml = p.endsWith('/') || p.endsWith('.html') || !path.extname(p);
    if (esHtml) res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js'))
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// Favicon
app.get('/favicon.ico', (req, res) =>
  res.sendFile(path.join(__dirname, '../public/img/favicon.png')));

// Auth
app.use('/api/auth', require('../../services/usuarios/src/routes/auth.routes'));

// Usuarios y perfiles
app.use('/api/usuarios', require('../../services/usuarios/src/routes/usuarios.routes'));
app.use('/api/perfiles', require('../../services/usuarios/src/routes/perfiles.routes'));
app.use('/api/config',   require('../../services/usuarios/src/routes/config.routes'));

// Clientes
app.use('/api/clientes',               require('../../services/clientes/src/routes/clientes.routes'));
app.use('/api/antecedentes-laborales', require('../../services/clientes/src/routes/antecedentes.routes'));
app.use('/api/informacion-comercial',  require('../../services/clientes/src/routes/informacion-comercial.routes'));
app.use('/api/informes-dealernet',     require('../../services/clientes/src/routes/informes-dealernet.routes'));
app.use('/api/dealernet',              require('../../services/clientes/src/routes/dealernet-ws.routes'));

// Mantenedores
app.use('/api/impuestos',       require('../../services/mantenedores/src/routes/impuestos.routes'));
app.use('/api/actividades-economicas', require('../../services/mantenedores/src/routes/actividades-economicas.routes'));
app.use('/api/estado-creditos', require('../../services/mantenedores/src/routes/estado-creditos.routes'));
app.use('/api/estado-cartera',  require('../../services/mantenedores/src/routes/estado-cartera.routes'));
app.use('/api/tasas',           require('../../services/mantenedores/src/routes/tasas.routes'));
app.use('/api/uf',              require('../../services/mantenedores/src/routes/uf.routes'));
app.use('/api/utm',             require('../../services/mantenedores/src/routes/utm.routes'));
app.use('/api/dolar',           require('../../services/mantenedores/src/routes/dolar.routes'));
app.use('/api/ipc',             require('../../services/mantenedores/src/routes/ipc.routes'));
app.use('/api/geografico',      require('../../services/mantenedores/src/routes/geografico.routes'));
app.use('/api/vehiculos',       require('../../services/mantenedores/src/routes/vehiculos.routes'));
app.use('/api/dealers',         require('../../services/mantenedores/src/routes/dealers.routes'));
app.use('/api/dealer-potencial', require('../../services/mantenedores/src/routes/dealer-potencial.routes'));
app.use('/api/mantenimiento',    require('../../services/mantenedores/src/routes/mantenimiento.routes'));
app.use('/api/ia-config',        require('../../services/mantenedores/src/routes/ia-config.routes'));
app.use('/api/ia',               require('../../services/ia/src/routes/ia.routes'));
app.use('/api/dealer-incorporacion', require('../../services/dealers-incorporacion/src/routes/fichas.routes'));
app.use('/api/dealer-liquidez',      require('../../services/dealers-liquidez/src/routes/liquidez.routes'));
app.use('/api/tickets',              require('../../services/tickets/src/routes/tickets.routes'));
app.use('/api/rrhh',                 require('../../services/rrhh/src/routes/rrhh.routes'));
app.use('/api/dealer-categorias',    require('../../services/mantenedores/src/routes/dealer-categorias.routes'));
app.use('/api/visitas',              require('../../services/mantenedores/src/routes/visitas.routes'));
app.use('/api/parametros-credito', require('../../services/mantenedores/src/routes/parametros.routes'));
app.use('/api/definiciones',       require('../../services/mantenedores/src/routes/definiciones.routes'));
app.use('/api/feriados',           require('../../services/mantenedores/src/routes/feriados.routes'));
app.use('/api/politica-aprobacion', require('../../services/mantenedores/src/routes/politica-aprobacion.routes'));
app.use('/api/politica-v3',         require('../../services/mantenedores/src/routes/politica-v3.routes'));
app.use('/api/workflow-estados',  require('../../services/mantenedores/src/routes/workflow.routes'));
app.use('/api/tipos-documento',      require('../../services/mantenedores/src/routes/tipos-documento.routes'));
app.use('/api/plantillas-documento', require('../../services/mantenedores/src/routes/plantillas.routes'));
app.use('/api/cuentas-bancarias',    require('../../services/mantenedores/src/routes/cuentas-bancarias.routes'));
app.use('/api/parques-comisiones',   require('../../services/mantenedores/src/routes/parques.routes'));
app.use('/api/sql-console',               require('../../services/mantenedores/src/routes/sql-console.routes'));
app.use('/api/recalculo-programado',      require('../../services/mantenedores/src/routes/recalculo-programado.routes'));
app.use('/api/bd-operaciones',            require('../../services/mantenedores/src/routes/bd-operaciones.routes'));
app.use('/api/bd-clientes',               require('../../services/mantenedores/src/routes/bd-clientes.routes'));
app.use('/api/bd-antecedentes',           require('../../services/mantenedores/src/routes/bd-antecedentes.routes'));
app.use('/api/bd-informacion-comercial',  require('../../services/mantenedores/src/routes/bd-informacion-comercial.routes'));
app.use('/api/productos-financiera',      require('../../services/mantenedores/src/routes/productos-financiera.routes'));
app.use('/api/noticias',                  require('../../services/mantenedores/src/routes/noticias.routes'));
app.use('/api/servidor-hora',             require('../../services/mantenedores/src/routes/servidor-hora.routes'));
app.use('/api/db-maintenance',            require('../../services/mantenedores/src/routes/db-maintenance.routes'));
app.use('/api/alertas-vencimiento',       require('../../services/mantenedores/src/routes/alertas.routes'));
app.use('/api/meses-cerrados',            require('../../services/mantenedores/src/routes/meses-cerrados.routes'));
app.use('/api/tablas-dinamicas',          require('../../services/reporteria/src/routes/tablas-dinamicas.routes'));
app.use('/api/bitacora',                  require('../../services/reporteria/src/routes/bitacora.routes'));

// Cotizaciones
app.use('/api/cotizaciones', require('../../services/cotizaciones/src/routes/cotizaciones.routes'));

// Evaluación Crediticia (ficha por RUT + módulo Home)
app.use('/api/evaluacion-crediticia', require('../../services/evaluacion-crediticia/src/routes/evaluacion.routes'));

// Créditos
app.use('/api/creditos',            require('../../services/creditos/src/routes/creditos.routes'));
app.use('/api/edicion-creditos',    require('../../services/creditos/src/routes/edicion.routes'));
app.use('/api/digitacion-faltantes', require('../../services/creditos/src/routes/digitacion-faltantes.routes'));
app.use('/api/credito-documentos',  require('../../services/creditos/src/routes/credito-documentos.routes'));
app.use('/api/documentos-af',       require('../../services/creditos/src/routes/documentos-af.routes'));
app.use('/api/pagos-credito',       require('../../services/creditos/src/routes/pagos-credito.routes'));
app.use('/api/operaciones',         require('../../services/creditos/src/routes/operaciones.routes'));
app.use('/api/auditoria-credito',   require('../../services/creditos/src/routes/auditoria.routes'));
app.use('/api/broker-validation-items', require('../../services/creditos/src/routes/broker-validation-items.routes'));
app.use('/api/broker-validaciones',     require('../../services/creditos/src/routes/broker-validaciones.routes'));
app.use('/api/fundantes',               require('../../services/creditos/src/routes/fundantes.routes'));
app.use('/api/comision-dealer',         require('../../services/creditos/src/routes/comision-dealer.routes'));

// Tesorería
app.use('/api/cajas',                require('../../services/tesoreria/src/routes/cajas.routes'));
app.use('/api/cierre-caja',          require('../../services/tesoreria/src/routes/cierre-caja.routes'));
app.use('/api/cuentas-transitorias', require('../../services/tesoreria/src/routes/cuentas-transitorias.routes'));
app.use('/api/brokerage',            require('../../services/tesoreria/src/routes/brokerage.routes'));

// Cartas de Aprobación
app.use('/api/cartas',            require('../../services/cartas/src/routes/cartas.routes'));
app.use('/api/cartolas',          require('../../services/cartas/src/routes/cartolas.routes'));

// Notificaciones (in-app + web push)
app.use('/api/notif', require('../../services/notificaciones/src/routes/notificaciones.routes'));

// Atención Remota (chat + videollamada WebRTC + documentos)
app.use('/api/atencion-remota', require('../../services/atencion-remota/src/routes/atencion.routes'));

// Portal del Dealer (self-service read-only: sus operaciones, estado, pagos, chat)
app.use('/api/portal-dealer', require('../../services/portal-dealer/src/routes/portal.routes'));

// Post Venta
app.use('/api/postventa', require('../../services/postventa/src/routes/postventa.routes'));
app.use('/api/correos-programados', require('../../services/correos-programados/src/routes/correos.routes'));
app.use('/api/backups', require('../../services/backups/src/routes/backups.routes'));
app.use('/api/ordenes-pago', require('../../services/ordenes-pago/src/routes/ordenes-pago.routes'));
app.use('/api/compras', require('../../services/compras/src/routes/compras.routes'));
app.use('/api/fundantes-seguimiento', require('../../services/fundantes-seguimiento/src/routes/fundantes-seg.routes'));
app.use('/api/cartas-ejecutivos', require('../../services/cartas/src/routes/ejecutivos.routes'));
app.use('/api/cartas-params',     require('../../services/cartas/src/routes/parametros.routes'));

// Dashboard analytics
app.use('/api/dashboard', require('../../services/dashboard/src/routes/dashboard.routes'));

// Ayuda contextual (botón "?")
app.use('/api/ayuda', require('../../services/ayuda/src/routes/ayuda.routes'));

// Motor de alertas configurable (campana + comunicados). Dueño único de /api/alertas;
// las alertas de VENCIMIENTO de crédito van aparte en /api/alertas-vencimiento (arriba).
app.use('/api/alertas', require('../../services/alertas/src/routes/alertas.routes'));

// Desempeño analistas (sesiones + eventos de carta + informe)
app.use('/api/desempeno', require('../../services/desempeno/src/routes/desempeno.routes'));

// CRM
app.use('/api/crm', require('../../services/crm/src/routes/gestiones.routes'));

// Cobranza
app.use('/api/cobranza', require('../../services/cobranza/src/routes/cobranza.routes'));
app.use('/api/cobranza-mora', require('../../services/cobranza/src/routes/mora-motor.routes'));
app.use('/api/migracion-indexa', require('../../services/cobranza/src/routes/migracion-indexa.routes'));
app.use('/api/odp-cuotas', require('../../services/cobranza/src/routes/odp-cuotas.routes'));

// Verificación pública de documentos por QR (SIN auth: se escanea desde afuera)
app.use('/api/verificar', require('../../services/certificados/src/routes/verificacion.routes'));

// Emisión de certificados (constancias) con QR de verificación
app.use('/api/certificados', require('../../services/certificados/src/routes/certificados.routes'));

// Comisiones ejecutivos
app.use('/api/comisiones', require('../../services/comisiones/src/routes/comisiones.routes'));

// Auditoría de movimientos (logins + bitácora transversal)
app.use('/api/auditoria-mov', require('../../services/auditoria/src/routes/auditoria.routes'));

// Carga masiva de operaciones
app.use('/api/carga-masiva',    require('../../services/creditos/src/routes/carga-masiva.routes'));
app.use('/api/carga-trinidad',   require('../../services/creditos/src/routes/carga-trinidad.routes'));
app.use('/api/trinidad-config',  require('../../services/creditos/src/routes/trinidad-config.routes'));
app.use('/api/carga-historial',  require('../../services/creditos/src/routes/carga-historial.routes'));

// Mantenedor comisiones de seguro
app.use('/api/comisiones-seguro', require('../../services/mantenedores/src/routes/comisiones-seguro.routes'));

// Ranking de colocaciones (popup mensual del podio)
app.use('/api/ranking-ventas', require('../../services/mantenedores/src/routes/ranking-ventas.routes'));

// Carrera de colocaciones (popup diario con la pista)
app.use('/api/carrera', require('../../services/mantenedores/src/routes/carrera.routes'));

// Mi Día (panel personal de pendientes + Google Calendar)
app.use('/api/mi-dia', require('../../services/mi-dia/src/routes/mi-dia.routes'));

// Login
app.get(['/login', '/login/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/login.html')));

// Health check (valida BD: si TiDB no responde → 503, así Render/monitoreo lo detectan)
app.get('/health', async (req, res) => {
  try {
    const pool = require('../../shared/config/database');
    await pool.query('SELECT 1');
    res.json({ status: 'Sistema operativo', db: true, uptime: Math.round(process.uptime()), timestamp: new Date() });
  } catch (e) {
    res.status(503).json({ status: 'BD no disponible', db: false, uptime: Math.round(process.uptime()), timestamp: new Date() });
  }
});

// ── Páginas estáticas (SPA) ──────────────────────────────────────────────────
// Cada entrada: [ruta, archivo-bajo-public]. Una ruta string '/x' se expande a
// '/x' y '/x/'; un array explícito permite paths extra (ej. el :codigo público de
// verificar). El archivo se mapea explícito porque algunas rutas no lo derivan de
// la URL (ej. /dealers vive en mantenedores/dealers/). Agregar página = 1 línea.
const PAGINAS = [
  ['/mantenedores/comisiones-seguro', 'mantenedores/comisiones-seguro/index.html'],
  ['/mantenedores/rrhh-saludos', 'mantenedores/rrhh-saludos/index.html'],
  ['/mantenedores/ranking-ventas', 'mantenedores/ranking-ventas/index.html'],
  ['/mantenedores/carrera', 'mantenedores/carrera/index.html'],
  ['/mantenedores/mi-dia', 'mantenedores/mi-dia/index.html'],
  ['/mi-dia', 'mi-dia/index.html'],
  ['/carga-masiva', 'carga-masiva/index.html'],
  ['/carga-masiva/digitacion', 'carga-masiva/digitacion/index.html'],
  ['/carga-masiva/digitacion/cola', 'carga-masiva/digitacion/cola.html'],
  ['/carga-masiva/digitacion/estadisticas', 'carga-masiva/digitacion/estadisticas.html'],
  ['/comisiones', 'comisiones/index.html'],
  ['/comisiones/revision', 'comisiones/revision/index.html'],
  ['/comisiones/variables', 'comisiones/variables/index.html'],
  ['/simulador', 'simulador/index.html'],
  ['/usuarios', 'usuarios/index.html'],
  ['/mantenedores', 'mantenedores/index.html'],
  ['/mantenedores/comunas', 'mantenedores/comunas/index.html'],
  ['/mantenedores/presupuesto', 'mantenedores/presupuesto/index.html'],
  ['/mantenedores/ayuda', 'mantenedores/ayuda/index.html'],
  ['/mantenedores/alertas', 'mantenedores/alertas/index.html'],
  ['/mantenedores/correos-programados', 'mantenedores/correos-programados/index.html'],
  ['/mantenedores/backups', 'mantenedores/backups/index.html'],
  ['/mantenedores/tasas', 'mantenedores/tasas/index.html'],
  ['/mantenedores/uf', 'mantenedores/uf/index.html'],
  ['/mantenedores/vehiculos', 'mantenedores/vehiculos/index.html'],
  // La card "Dealers" vive en el Home (no en Mantenedores) → URL limpia /dealers/.
  ['/dealers', 'mantenedores/dealers/index.html'],
  ['/mantenedores/potencial-dealer', 'mantenedores/potencial-dealer/index.html'],
  ['/mantenedores/mantencion-sistema', 'mantenedores/mantencion-sistema/index.html'],
  ['/mantenedores/inteligencia-artificial', 'mantenedores/inteligencia-artificial/index.html'],
  ['/ia/liquidaciones', 'ia/liquidaciones/index.html'],
  ['/ia/informe-dealernet', 'ia/informe-dealernet/index.html'],
  ['/ia/pregunta', 'ia/pregunta/index.html'],
  ['/mantenedores/respuestas-rapidas', 'mantenedores/respuestas-rapidas/index.html'],
  ['/mantenedores/dealernet-productos', 'mantenedores/dealernet-productos/index.html'],
  ['/mantenedores/dealernet-costos', 'mantenedores/dealernet-costos/index.html'],
  ['/mantenedores/dealernet', 'mantenedores/dealernet/index.html'],
  ['/mantenedores/parametros', 'mantenedores/parametros/index.html'],
  ['/mantenedores/cobranza-parametros', 'mantenedores/cobranza-parametros/index.html'],
  ['/mantenedores/definiciones', 'mantenedores/definiciones/index.html'],
  ['/mantenedores/alertas-saldos', 'mantenedores/alertas-saldos/index.html'],
  ['/mantenedores/factores-seguro', 'mantenedores/factores-seguro/index.html'],
  ['/mantenedores/financieras', 'mantenedores/financieras/index.html'],
  ['/mantenedores/solo-dios', 'mantenedores/solo-dios/index.html'],
  ['/mantenedores/sql-console', 'mantenedores/sql-console/index.html'],
  ['/mantenedores/recalculo-programado', 'mantenedores/recalculo-programado/index.html'],
  // Vista analista (misma página, sin Nivel Dios ni eliminar; detecta '-edicion' en la URL)
  ['/mantenedores/bd-clientes-edicion', 'mantenedores/bd-clientes/index.html'],
  ['/mantenedores/bd-operaciones-edicion', 'mantenedores/bd-operaciones/index.html'],
  ['/mantenedores/bd-antecedentes-edicion', 'mantenedores/bd-antecedentes/index.html'],
  ['/mantenedores/bd-informacion-comercial-edicion', 'mantenedores/bd-informacion-comercial/index.html'],
  ['/mantenedores/servidor-hora', 'mantenedores/servidor-hora/index.html'],
  ['/mantenedores/db-maintenance', 'mantenedores/db-maintenance/index.html'],
  ['/mantenedores/tipos-documento', 'mantenedores/tipos-documento/index.html'],
  ['/mantenedores/actividades-economicas', 'mantenedores/actividades-economicas/index.html'],
  ['/clientes', 'clientes/index.html'],
  ['/creditos', 'creditos/index.html'],
  ['/creditos/revisar', 'creditos/revisar.html'],
  ['/creditos/respaldos', 'creditos/respaldos.html'],
  ['/creditos/documentos', 'creditos/documentos.html'],
  ['/mantenedores/pagares', 'mantenedores/pagares/index.html'],
  ['/mantenedores/cuentas-bancarias', 'mantenedores/cuentas-bancarias/index.html'],
  ['/mantenedores/parques', 'mantenedores/parques/index.html'],
  ['/mantenedores/dealers-mapa', 'mantenedores/dealers-mapa/index.html'],
  ['/dealers-visitas', 'dealers-visitas/index.html'],
  ['/dealers-liquidez', 'dealers-liquidez/index.html'],
  ['/dealers-liquidez/hojas', 'dealers-liquidez/hojas/index.html'],
  ['/mantenedores/dealers-direcciones', 'mantenedores/dealers-direcciones/index.html'],
  ['/juegos', 'juegos/index.html'],
  ['/mantenedores/estado-creditos', 'mantenedores/estado-creditos/index.html'],
  ['/mantenedores/estado-cartera', 'mantenedores/estado-cartera/index.html'],
  ['/mantenedores/broker-validaciones', 'mantenedores/broker-validaciones/index.html'],
  ['/creditos/digitacion-autofin', 'creditos/digitacion-autofin.html'],
  ['/creditos/digitacion-unidad', 'creditos/digitacion-unidad.html'],
  ['/creditos/carga-documentos-af', 'creditos/carga-documentos-af.html'],
  ['/creditos/validacion-firma', 'creditos/validacion-firma.html'],
  ['/creditos/pagar-cuotas', 'creditos/pagar-cuotas.html'],
  ['/creditos/auditoria', 'creditos/auditoria.html'],
  ['/antecedentes-laborales', 'antecedentes-laborales/index.html'],
  ['/informacion-comercial', 'informacion-comercial/index.html'],
  ['/cotizaciones', 'cotizaciones/index.html'],
  ['/tesoreria', 'tesoreria/index.html'],
  ['/tesoreria/caja', 'tesoreria/caja.html'],
  ['/tesoreria/cajas', 'tesoreria/cajas.html'],
  ['/tesoreria/cierre-caja', 'tesoreria/cierre-caja.html'],
  ['/tesoreria/cuentas-transitorias', 'tesoreria/cuentas-transitorias.html'],
  ['/crm', 'crm/index.html'],
  ['/crm/gestiones', 'crm/gestiones.html'],
  ['/crm/estadisticas', 'crm/estadisticas.html'],
  ['/crm/campanas', 'crm/campanas/index.html'],
  ['/crm/campanas/crear', 'crm/campanas/crear.html'],
  ['/crm/campanas/gestion', 'crm/campanas/gestion.html'],
  ['/crm/campanas/resultados', 'crm/campanas/resultados.html'],
  ['/cobranza', 'cobranza/index.html'],
  ['/cobranza/prejudicial', 'cobranza/prejudicial.html'],
  ['/cobranza/judicial', 'cobranza/judicial.html'],
  ['/cobranza/mis-cobranza', 'cobranza/mis-cobranza.html'],
  ['/cobranza/reporteria', 'cobranza/reporteria.html'],
  ['/cobranza/migracion-indexa', 'cobranza/migracion-indexa/index.html'],
  // Página PÚBLICA (la abre el QR): /verificar/<codigo>. El array agrega el path con param.
  [['/verificar', '/verificar/', '/verificar/:codigo'], 'verificar/index.html'],
  ['/certificados', 'certificados/index.html'],
  ['/mantenedores/certificados-textos', 'mantenedores/certificados-textos/index.html'],
  ['/tesoreria/odp-cuotas', 'tesoreria/odp-cuotas.html'],
  ['/reporteria', 'reporteria/index.html'],
  ['/reporteria/tablas-dinamicas', 'reporteria/tablas-dinamicas/index.html'],
  ['/reporteria/bitacora-credito', 'reporteria/bitacora-credito/index.html'],
  ['/politica', 'politica/index.html'],
  ['/dashboard', 'dashboard/index.html'],
  ['/auditoria', 'auditoria/index.html'],
  ['/atencion-remota', 'atencion-remota/index.html'],
  ['/portal-dealer', 'portal-dealer/index.html'],
  ['/cartas-aprobacion', 'cartas-aprobacion/index.html'],
  ['/aprobaciones', 'aprobaciones/index.html'],
  ['/aprobaciones/mantenedor', 'aprobaciones/mantenedor/index.html'],
  ['/postventa', 'postventa/index.html'],
  ['/postventa/seguimiento', 'postventa/seguimiento/index.html'],
  ['/postventa/mantenedores', 'postventa/mantenedores/index.html'],
  ['/postventa/saldos-a-pagar', 'postventa/saldos-a-pagar/index.html'],
  ['/postventa/orden-pago', 'postventa/orden-pago/index.html'],
  ['/postventa/fundantes-pendientes', 'postventa/fundantes-pendientes/index.html'],
  ['/postventa/consulta-saldos', 'postventa/consulta-saldos/index.html'],
  ['/postventa/consulta-factura', 'postventa/consulta-factura/index.html'],
  ['/ordenes-pago', 'ordenes-pago/index.html'],
  ['/ordenes-pago/emision', 'ordenes-pago/emision/index.html'],
  ['/ordenes-pago/historial', 'ordenes-pago/historial/index.html'],
  ['/ordenes-pago/proveedores', 'ordenes-pago/proveedores/index.html'],
  ['/ordenes-pago/estadisticas', 'ordenes-pago/estadisticas/index.html'],
  ['/soporte', 'soporte/index.html'],
  ['/soporte/compras', 'soporte/compras/index.html'],
  ['/soporte/tickets-ti', 'soporte/tickets-ti/index.html'],
  ['/recursos-humanos', 'recursos-humanos/index.html'],
  ['/soporte/recursos-humanos', 'recursos-humanos/index.html'],
  ['/recursos-humanos/vacaciones', 'recursos-humanos/vacaciones/index.html'],
  ['/recursos-humanos/antiguedad', 'recursos-humanos/antiguedad/index.html'],
  ['/mantenedores/tickets-ti', 'mantenedores/tickets-ti/index.html'],
  ['/soporte/compras-admin', 'soporte/compras-admin/index.html'],
  ['/mantenedores/compras', 'mantenedores/compras/index.html'],
  ['/edicion-creditos', 'edicion-creditos/index.html'],
  ['/edicion-creditos/otorgados', 'edicion-creditos/otorgados/index.html'],
  ['/edicion-creditos/otros', 'edicion-creditos/otros/index.html'],
  ['/informes-dealernet', 'informes-dealernet/index.html'],
  ['/dealernet-informes', 'dealernet-informes/index.html'],
];
for (const [ruta, archivo] of PAGINAS) {
  const urls = Array.isArray(ruta) ? ruta : [ruta, ruta + '/'];
  app.get(urls, (req, res) => res.sendFile(path.join(__dirname, '../public/' + archivo)));
}

// ── Redirecciones de rutas legacy (302) ──────────────────────────────────────
// - /mantenedores/dealers: la card se movió al Home (/dealers/).
// - /mantenedores/flujo-brokerage: submódulo eliminado (espejo de Estado Créditos).
// - /tesoreria/brokerage y /creditos/fundantes: flujo viejo retirado (jun-2026),
//   reemplazado por Seguimiento Fundantes (/fundantes/) y Post Venta.
// - /mantenedores/preferencia-financiera: ahora es una pestaña de Aprobaciones.
const REDIRECTS = [
  ['/mantenedores/dealers', '/dealers/'],
  ['/mantenedores/flujo-brokerage', '/mantenedores/estado-creditos/'],
  ['/tesoreria/brokerage', '/tesoreria/'],
  ['/creditos/fundantes', '/fundantes/'],
  ['/mantenedores/preferencia-financiera', '/aprobaciones/?tab=params'],
];
for (const [desde, hacia] of REDIRECTS) {
  app.get([desde, desde + '/'], (req, res) => res.redirect(hacia));
}

app.use((req, res) => res.status(404).json({ success: false, error: 'Ruta no encontrada' }));

// ── Errores no capturados por los controllers (ej: JSON malformado, throw síncrono) ──
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed')
    return res.status(400).json({ success: false, data: null, error: 'JSON inválido en el body' });
  if (err.type === 'entity.too.large')
    return res.status(413).json({ success: false, data: null, error: 'Archivo o body demasiado grande (máx 10mb)' });
  console.error(`[ERROR] ${req.method} ${req.originalUrl} →`, err.stack || err.message);
  res.status(500).json({ success: false, data: null, error: 'Error interno del servidor. Si persiste, contacta al administrador.' });
});

// ── El servidor no debe caerse por una promesa sin catch ──
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.stack || err.message);
});

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
require('../../services/atencion-remota/src/ws').initAtencionWS(server);
server.listen(PORT, () => {
  console.log(`✓ API Gateway en http://localhost:${PORT}`);
  console.log(`✓ Login: http://localhost:${PORT}/login.html`);
});
