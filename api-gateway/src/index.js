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
app.use('/api/clientes', require('../../services/clientes/src/routes/clientes.routes'));

// Mantenedores
app.use('/api/tasas',      require('../../services/mantenedores/src/routes/tasas.routes'));
app.use('/api/uf',         require('../../services/mantenedores/src/routes/uf.routes'));
app.use('/api/geografico', require('../../services/mantenedores/src/routes/geografico.routes'));
app.use('/api/vehiculos',  require('../../services/mantenedores/src/routes/vehiculos.routes'));
app.use('/api/dealers',    require('../../services/mantenedores/src/routes/dealers.routes'));

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

app.use((req, res) => res.status(404).json({ success: false, error: 'Ruta no encontrada' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ API Gateway en http://localhost:${PORT}`);
  console.log(`✓ Login: http://localhost:${PORT}/login.html`);
});
