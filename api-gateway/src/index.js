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
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
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
app.use('/api/bd-operaciones',            require('../../services/mantenedores/src/routes/bd-operaciones.routes'));
app.use('/api/bd-clientes',               require('../../services/mantenedores/src/routes/bd-clientes.routes'));
app.use('/api/bd-antecedentes',           require('../../services/mantenedores/src/routes/bd-antecedentes.routes'));
app.use('/api/bd-informacion-comercial',  require('../../services/mantenedores/src/routes/bd-informacion-comercial.routes'));
app.use('/api/productos-financiera',      require('../../services/mantenedores/src/routes/productos-financiera.routes'));
app.use('/api/noticias',                  require('../../services/mantenedores/src/routes/noticias.routes'));
app.use('/api/servidor-hora',             require('../../services/mantenedores/src/routes/servidor-hora.routes'));
app.use('/api/db-maintenance',            require('../../services/mantenedores/src/routes/db-maintenance.routes'));
app.use('/api/alertas',                   require('../../services/mantenedores/src/routes/alertas.routes'));
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

// Motor de alertas configurable
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

// Login
app.get(['/login', '/login/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/login.html')));

// Health check
app.get('/health', (req, res) => res.json({ status: 'Sistema operativo', timestamp: new Date() }));

// Mantenedor comisiones seguro SPA
app.get(['/mantenedores/comisiones-seguro', '/mantenedores/comisiones-seguro/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/comisiones-seguro/index.html')));

// Carga masiva SPA
app.get(['/carga-masiva', '/carga-masiva/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/carga-masiva/index.html')));
app.get(['/carga-masiva/digitacion', '/carga-masiva/digitacion/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/carga-masiva/digitacion/index.html')));
app.get(['/carga-masiva/digitacion/cola', '/carga-masiva/digitacion/cola/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/carga-masiva/digitacion/cola.html')));
app.get(['/carga-masiva/digitacion/estadisticas', '/carga-masiva/digitacion/estadisticas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/carga-masiva/digitacion/estadisticas.html')));

// Comisiones SPA
app.get(['/comisiones', '/comisiones/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/comisiones/index.html')));
app.get(['/comisiones/revision', '/comisiones/revision/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/comisiones/revision/index.html')));
app.get(['/comisiones/variables', '/comisiones/variables/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/comisiones/variables/index.html')));

// SPA fallbacks
app.get(['/simulador', '/simulador/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/simulador/index.html')));
app.get(['/usuarios', '/usuarios/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/usuarios/index.html')));
app.get(['/mantenedores', '/mantenedores/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/index.html')));
app.get(['/mantenedores/comunas', '/mantenedores/comunas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/comunas/index.html')));
app.get(['/mantenedores/presupuesto', '/mantenedores/presupuesto/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/presupuesto/index.html')));
app.get(['/mantenedores/ayuda', '/mantenedores/ayuda/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/ayuda/index.html')));
app.get(['/mantenedores/alertas', '/mantenedores/alertas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/alertas/index.html')));
app.get(['/mantenedores/correos-programados', '/mantenedores/correos-programados/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/correos-programados/index.html')));
app.get(['/mantenedores/backups', '/mantenedores/backups/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/backups/index.html')));
app.get(['/mantenedores/tasas', '/mantenedores/tasas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/tasas/index.html')));
app.get(['/mantenedores/uf', '/mantenedores/uf/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/uf/index.html')));
app.get(['/mantenedores/vehiculos', '/mantenedores/vehiculos/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/vehiculos/index.html')));
// La card "Dealers" vive en el Home (no en Mantenedores) → URL limpia /dealers/; la antigua redirige.
app.get(['/dealers', '/dealers/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/dealers/index.html')));
app.get(['/mantenedores/dealers', '/mantenedores/dealers/'], (req, res) => res.redirect('/dealers/'));
app.get(['/mantenedores/potencial-dealer', '/mantenedores/potencial-dealer/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/potencial-dealer/index.html')));
app.get(['/mantenedores/mantencion-sistema', '/mantenedores/mantencion-sistema/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/mantencion-sistema/index.html')));
app.get(['/mantenedores/inteligencia-artificial', '/mantenedores/inteligencia-artificial/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/inteligencia-artificial/index.html')));
app.get(['/ia/liquidaciones', '/ia/liquidaciones/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/ia/liquidaciones/index.html')));
app.get(['/ia/informe-dealernet', '/ia/informe-dealernet/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/ia/informe-dealernet/index.html')));
app.get(['/mantenedores/respuestas-rapidas', '/mantenedores/respuestas-rapidas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/respuestas-rapidas/index.html')));
app.get(['/mantenedores/dealernet-productos', '/mantenedores/dealernet-productos/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/dealernet-productos/index.html')));
app.get(['/mantenedores/dealernet-costos', '/mantenedores/dealernet-costos/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/dealernet-costos/index.html')));
app.get(['/mantenedores/dealernet', '/mantenedores/dealernet/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/dealernet/index.html')));
app.get(['/mantenedores/parametros', '/mantenedores/parametros/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/parametros/index.html')));
app.get(['/mantenedores/cobranza-parametros', '/mantenedores/cobranza-parametros/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/cobranza-parametros/index.html')));
app.get(['/mantenedores/definiciones', '/mantenedores/definiciones/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/definiciones/index.html')));
app.get(['/mantenedores/alertas-saldos', '/mantenedores/alertas-saldos/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/alertas-saldos/index.html')));
app.get(['/mantenedores/factores-seguro', '/mantenedores/factores-seguro/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/factores-seguro/index.html')));
app.get(['/mantenedores/financieras', '/mantenedores/financieras/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/financieras/index.html')));

app.get(['/mantenedores/solo-dios', '/mantenedores/solo-dios/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/solo-dios/index.html')));

app.get(['/mantenedores/servidor-hora', '/mantenedores/servidor-hora/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/servidor-hora/index.html')));

app.get(['/mantenedores/db-maintenance', '/mantenedores/db-maintenance/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/db-maintenance/index.html')));

app.get(['/mantenedores/tipos-documento', '/mantenedores/tipos-documento/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/tipos-documento/index.html')));

app.get(['/mantenedores/actividades-economicas', '/mantenedores/actividades-economicas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/actividades-economicas/index.html')));

app.get(['/clientes', '/clientes/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/clientes/index.html')));

app.get(['/creditos', '/creditos/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/creditos/index.html')));

app.get(['/creditos/revisar', '/creditos/revisar/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/creditos/revisar.html')));

app.get(['/creditos/respaldos', '/creditos/respaldos/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/creditos/respaldos.html')));

app.get(['/creditos/documentos', '/creditos/documentos/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/creditos/documentos.html')));

app.get(['/mantenedores/pagares', '/mantenedores/pagares/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/pagares/index.html')));

app.get(['/mantenedores/cuentas-bancarias', '/mantenedores/cuentas-bancarias/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/cuentas-bancarias/index.html')));

app.get(['/mantenedores/parques', '/mantenedores/parques/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/parques/index.html')));

app.get(['/mantenedores/dealers-mapa', '/mantenedores/dealers-mapa/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/dealers-mapa/index.html')));

app.get(['/dealers-visitas', '/dealers-visitas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/dealers-visitas/index.html')));

app.get(['/mantenedores/dealers-direcciones', '/mantenedores/dealers-direcciones/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/dealers-direcciones/index.html')));

app.get(['/juegos', '/juegos/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/juegos/index.html')));

// Submódulo "Flujo Crédito Brokerage" eliminado: era un espejo de solo lectura del
// mantenedor Estado Créditos (pestaña Brokerage). Se redirige por si queda algún link viejo.
app.get(['/mantenedores/flujo-brokerage', '/mantenedores/flujo-brokerage/'], (req, res) =>
  res.redirect(302, '/mantenedores/estado-creditos/'));

app.get(['/mantenedores/estado-creditos', '/mantenedores/estado-creditos/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/estado-creditos/index.html')));

app.get(['/mantenedores/estado-cartera', '/mantenedores/estado-cartera/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/estado-cartera/index.html')));

app.get(['/mantenedores/broker-validaciones', '/mantenedores/broker-validaciones/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/broker-validaciones/index.html')));

app.get(['/creditos/digitacion-autofin', '/creditos/digitacion-autofin/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/creditos/digitacion-autofin.html')));

app.get(['/creditos/digitacion-unidad', '/creditos/digitacion-unidad/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/creditos/digitacion-unidad.html')));

app.get(['/creditos/carga-documentos-af', '/creditos/carga-documentos-af/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/creditos/carga-documentos-af.html')));

app.get(['/creditos/validacion-firma', '/creditos/validacion-firma/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/creditos/validacion-firma.html')));

app.get(['/creditos/pagar-cuotas', '/creditos/pagar-cuotas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/creditos/pagar-cuotas.html')));

app.get(['/creditos/auditoria', '/creditos/auditoria/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/creditos/auditoria.html')));

app.get(['/antecedentes-laborales', '/antecedentes-laborales/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/antecedentes-laborales/index.html')));

app.get(['/informacion-comercial', '/informacion-comercial/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/informacion-comercial/index.html')));

app.get(['/cotizaciones', '/cotizaciones/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cotizaciones/index.html')));

app.get(['/tesoreria', '/tesoreria/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/tesoreria/index.html')));
app.get(['/tesoreria/caja', '/tesoreria/caja/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/tesoreria/caja.html')));
app.get(['/tesoreria/cajas', '/tesoreria/cajas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/tesoreria/cajas.html')));
app.get(['/tesoreria/cierre-caja', '/tesoreria/cierre-caja/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/tesoreria/cierre-caja.html')));

app.get(['/tesoreria/cuentas-transitorias', '/tesoreria/cuentas-transitorias/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/tesoreria/cuentas-transitorias.html')));

// Flujo brokerage/fundantes VIEJO retirado (jun-2026): reemplazado por Seguimiento
// Fundantes (/fundantes/) y Post Venta. Tablas en 0, sin uso. Páginas legacy quedan
// en el repo pero las rutas redirigen para no dejar pantallas muertas accesibles.
app.get(['/tesoreria/brokerage', '/tesoreria/brokerage/'], (req, res) => res.redirect('/tesoreria/'));

app.get(['/creditos/fundantes', '/creditos/fundantes/'], (req, res) => res.redirect('/fundantes/'));

app.get(['/crm', '/crm/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/crm/index.html')));

app.get(['/crm/gestiones', '/crm/gestiones/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/crm/gestiones.html')));
app.get(['/crm/estadisticas', '/crm/estadisticas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/crm/estadisticas.html')));
app.get(['/crm/campanas', '/crm/campanas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/crm/campanas/index.html')));
app.get(['/crm/campanas/crear', '/crm/campanas/crear/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/crm/campanas/crear.html')));
app.get(['/crm/campanas/gestion', '/crm/campanas/gestion/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/crm/campanas/gestion.html')));
app.get(['/crm/campanas/resultados', '/crm/campanas/resultados/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/crm/campanas/resultados.html')));

app.get(['/cobranza', '/cobranza/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cobranza/index.html')));

app.get(['/cobranza/prejudicial', '/cobranza/prejudicial/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cobranza/prejudicial.html')));

app.get(['/cobranza/judicial', '/cobranza/judicial/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cobranza/judicial.html')));

app.get(['/cobranza/mis-cobranza', '/cobranza/mis-cobranza/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cobranza/mis-cobranza.html')));

app.get(['/cobranza/reporteria', '/cobranza/reporteria/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cobranza/reporteria.html')));

app.get(['/cobranza/migracion-indexa', '/cobranza/migracion-indexa/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cobranza/migracion-indexa/index.html')));

// Página PÚBLICA de verificación de documentos (la abre el QR): /verificar/<codigo>
app.get(['/verificar', '/verificar/', '/verificar/:codigo'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/verificar/index.html')));

// Módulo Certificados (constancias)
app.get(['/certificados', '/certificados/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/certificados/index.html')));

// Mantenedor de textos de certificados
app.get(['/mantenedores/certificados-textos', '/mantenedores/certificados-textos/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/certificados-textos/index.html')));

// Cola de Órdenes de Pago de Cuotas (Tesorería)
app.get(['/tesoreria/odp-cuotas', '/tesoreria/odp-cuotas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/tesoreria/odp-cuotas.html')));

app.get(['/reporteria', '/reporteria/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/reporteria/index.html')));

app.get(['/reporteria/tablas-dinamicas', '/reporteria/tablas-dinamicas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/reporteria/tablas-dinamicas/index.html')));

app.get(['/reporteria/bitacora-credito', '/reporteria/bitacora-credito/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/reporteria/bitacora-credito/index.html')));

app.get(['/politica', '/politica/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/politica/index.html')));

app.get(['/dashboard', '/dashboard/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/dashboard/index.html')));

app.get(['/auditoria', '/auditoria/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/auditoria/index.html')));

// Atención Remota — consola del ejecutivo (interno) y portal del dealer (externo)
app.get(['/atencion-remota', '/atencion-remota/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/atencion-remota/index.html')));
app.get(['/portal-dealer', '/portal-dealer/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/portal-dealer/index.html')));

app.get(['/cartas-aprobacion', '/cartas-aprobacion/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cartas-aprobacion/index.html')));

app.get(['/aprobaciones', '/aprobaciones/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/aprobaciones/index.html')));
app.get(['/aprobaciones/mantenedor', '/aprobaciones/mantenedor/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/aprobaciones/mantenedor/index.html')));

// Card en Mantenedores → abre la pestaña Parámetros de Aprobaciones
app.get(['/mantenedores/preferencia-financiera', '/mantenedores/preferencia-financiera/'], (req, res) =>
  res.redirect('/aprobaciones/?tab=params'));

// Post Venta
app.get(['/postventa', '/postventa/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/postventa/index.html')));
app.get(['/postventa/seguimiento', '/postventa/seguimiento/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/postventa/seguimiento/index.html')));
app.get(['/postventa/mantenedores', '/postventa/mantenedores/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/postventa/mantenedores/index.html')));
app.get(['/postventa/saldos-a-pagar', '/postventa/saldos-a-pagar/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/postventa/saldos-a-pagar/index.html')));
app.get(['/postventa/orden-pago', '/postventa/orden-pago/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/postventa/orden-pago/index.html')));
app.get(['/postventa/fundantes-pendientes', '/postventa/fundantes-pendientes/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/postventa/fundantes-pendientes/index.html')));
app.get(['/postventa/consulta-saldos', '/postventa/consulta-saldos/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/postventa/consulta-saldos/index.html')));
app.get(['/postventa/consulta-factura', '/postventa/consulta-factura/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/postventa/consulta-factura/index.html')));

// Órdenes de Pago (módulo general de cuentas por pagar a proveedores)
app.get(['/ordenes-pago', '/ordenes-pago/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/ordenes-pago/index.html')));
app.get(['/ordenes-pago/emision', '/ordenes-pago/emision/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/ordenes-pago/emision/index.html')));
app.get(['/ordenes-pago/historial', '/ordenes-pago/historial/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/ordenes-pago/historial/index.html')));
app.get(['/ordenes-pago/proveedores', '/ordenes-pago/proveedores/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/ordenes-pago/proveedores/index.html')));
app.get(['/ordenes-pago/estadisticas', '/ordenes-pago/estadisticas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/ordenes-pago/estadisticas/index.html')));

// Soporte (Home) + Compras de oficina + su mantenedor
app.get(['/soporte', '/soporte/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/soporte/index.html')));
app.get(['/soporte/compras', '/soporte/compras/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/soporte/compras/index.html')));
app.get(['/mantenedores/compras', '/mantenedores/compras/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/compras/index.html')));

app.get(['/edicion-creditos', '/edicion-creditos/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/edicion-creditos/index.html')));
app.get(['/edicion-creditos/otorgados', '/edicion-creditos/otorgados/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/edicion-creditos/otorgados/index.html')));
app.get(['/edicion-creditos/otros', '/edicion-creditos/otros/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/edicion-creditos/otros/index.html')));

app.get(['/informes-dealernet', '/informes-dealernet/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/informes-dealernet/index.html')));

app.get(['/dealernet-informes', '/dealernet-informes/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/dealernet-informes/index.html')));

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
