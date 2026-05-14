const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Rutas de autenticación (públicas excepto donde verifyToken se aplica internamente)
app.use('/api/auth', require('../../services/usuarios/src/routes/auth.routes'));

// Rutas de usuarios y perfiles
app.use('/api/usuarios', require('../../services/usuarios/src/routes/usuarios.routes'));
app.use('/api/perfiles', require('../../services/usuarios/src/routes/perfiles.routes'));

// Rutas de clientes
app.use('/api/clientes', require('../../services/clientes/src/routes/clientes.routes'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Sistema operativo', timestamp: new Date() });
});

// SPA fallback: rutas de módulos sirven su index.html
app.get(['/usuarios/', '/usuarios'], (req, res) => {
  res.sendFile(path.join(__dirname, '../public/usuarios/index.html'));
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Ruta no encontrada' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ API Gateway en http://localhost:${PORT}`);
  console.log(`✓ Login: http://localhost:${PORT}/login.html`);
});
