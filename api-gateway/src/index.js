const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

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

// Cotizaciones
app.use('/api/cotizaciones', require('../../services/cotizaciones/src/routes/cotizaciones.routes'));

// Créditos
app.use('/api/creditos',            require('../../services/creditos/src/routes/creditos.routes'));
app.use('/api/credito-documentos',  require('../../services/creditos/src/routes/credito-documentos.routes'));

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

app.get(['/antecedentes-laborales', '/antecedentes-laborales/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/antecedentes-laborales/index.html')));

app.get(['/informacion-comercial', '/informacion-comercial/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/informacion-comercial/index.html')));

app.get(['/cotizaciones', '/cotizaciones/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cotizaciones/index.html')));

app.get(['/tesoreria', '/tesoreria/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/tesoreria/index.html')));

app.get(['/crm', '/crm/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/crm/index.html')));

app.get(['/cobranza', '/cobranza/'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/cobranza/index.html')));

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
