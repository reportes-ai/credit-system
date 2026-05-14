const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Auth
app.use('/api/auth', require('../../services/usuarios/src/routes/auth.routes'));

// Usuarios y perfiles
app.use('/api/usuarios', require('../../services/usuarios/src/routes/usuarios.routes'));
app.use('/api/perfiles', require('../../services/usuarios/src/routes/perfiles.routes'));

// Clientes
app.use('/api/clientes', require('../../services/clientes/src/routes/clientes.routes'));

// Mantenedores
app.use('/api/tasas',     require('../../services/mantenedores/src/routes/tasas.routes'));
app.use('/api/uf',        require('../../services/mantenedores/src/routes/uf.routes'));
app.use('/api/geografico',require('../../services/mantenedores/src/routes/geografico.routes'));

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

app.use((req, res) => res.status(404).json({ success: false, error: 'Ruta no encontrada' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ API Gateway en http://localhost:${PORT}`);
  console.log(`✓ Login: http://localhost:${PORT}/login.html`);
});
