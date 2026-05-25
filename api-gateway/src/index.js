const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

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

// Mantenedores
app.use('/api/tasas',           require('../../services/mantenedores/src/routes/tasas.routes'));
app.use('/api/uf',              require('../../services/mantenedores/src/routes/uf.routes'));
app.use('/api/geografico',      require('../../services/mantenedores/src/routes/geografico.routes'));
app.use('/api/vehiculos',       require('../../services/mantenedores/src/routes/vehiculos.routes'));
app.use('/api/dealers',         require('../../services/mantenedores/src/routes/dealers.routes'));
app.use('/api/parametros-credito', require('../../services/mantenedores/src/routes/parametros.routes'));
app.use('/api/tipos-documento',      require('../../services/mantenedores/src/routes/tipos-documento.routes'));
app.use('/api/plantillas-documento', require('../../services/mantenedores/src/routes/plantillas.routes'));
app.use('/api/cuentas-bancarias',    require('../../services/mantenedores/src/routes/cuentas-bancarias.routes'));

// Cotizaciones
app.use('/api/cotizaciones', require('../../services/cotizaciones/src/routes/cotizaciones.routes'));

// Créditos
app.use('/api/creditos',            require('../../services/creditos/src/routes/creditos.routes'));
app.use('/api/credito-documentos',  require('../../services/creditos/src/routes/credito-documentos.routes'));
app.use('/api/documentos-af',       require('../../services/creditos/src/routes/documentos-af.routes'));
app.use('/api/pagos-credito',       require('../../services/creditos/src/routes/pagos-credito.routes'));
app.use('/api/auditoria-credito',   require('../../services/creditos/src/routes/auditoria.routes'));

// Tesorería
app.use('/api/cajas',                require('../../services/tesoreria/src/routes/cajas.routes'));
app.use('/api/cierre-caja',          require('../../services/tesoreria/src/routes/cierre-caja.routes'));
app.use('/api/cuentas-transitorias', require('../../services/tesoreria/src/routes/cuentas-transitorias.routes'));

// CRM
app.use('/api/crm', require('../../services/crm/src/routes/gestiones.routes'));

// Cobranza
app.use('/api/cobranza', require('../../services/cobranza/src/routes/cobranza.routes'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'Sistema operativo', timestamp: new Date() }));

// SPA fallbacks
app.get(['/usuarios', '/usuarios/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/usuarios/index.html')));
app.get(['/mantenedores', '/mantenedores/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/index.html')));
app.get(['/mantenedores/comunas', '/mantenedores/comunas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/comunas/index.html')));
app.get(['/mantenedores/tasas', '/mantenedores/tasas/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/tasas/index.html')));
app.get(['/mantenedores/uf', '/mantenedores/uf/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/uf/index.html')));
app.get(['/mantenedores/vehiculos', '/mantenedores/vehiculos/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/vehiculos/index.html')));
app.get(['/mantenedores/dealers', '/mantenedores/dealers/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/dealers/index.html')));
app.get(['/mantenedores/parametros', '/mantenedores/parametros/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/parametros/index.html')));
app.get(['/mantenedores/factores-seguro', '/mantenedores/factores-seguro/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/factores-seguro/index.html')));

app.get(['/mantenedores/tipos-documento', '/mantenedores/tipos-documento/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/mantenedores/tipos-documento/index.html')));

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

app.get(['/cobranza', '/cobranza/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cobranza/index.html')));

app.get(['/cobranza/prejudicial', '/cobranza/prejudicial/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cobranza/prejudicial.html')));

app.get(['/cobranza/judicial', '/cobranza/judicial/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cobranza/judicial.html')));

app.get(['/cobranza/mis-cobranza', '/cobranza/mis-cobranza/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cobranza/mis-cobranza.html')));

app.get(['/reporteria', '/reporteria/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/reporteria/index.html')));

app.get(['/politica', '/politica/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/politica/index.html')));

app.use((req, res) => res.status(404).json({ success: false, error: 'Ruta no encontrada' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ API Gateway en http://localhost:${PORT}`);
  console.log(`✓ Login: http://localhost:${PORT}/login.html`);
});
