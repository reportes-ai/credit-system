const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Importar rutas
const clientesRoutes = require('../../services/clientes/src/routes/clientes.routes');

// Registrar rutas
app.use('/api/clientes', clientesRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'Sistema operativo', timestamp: new Date() });
});

// Error 404
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Ruta no encontrada'
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✓ API Gateway ejecutándose en http://localhost:${PORT}`);
  console.log(`✓ Prueba: http://localhost:${PORT}/health`);
  console.log(`✓ API Clientes: http://localhost:${PORT}/api/clientes`);
});
