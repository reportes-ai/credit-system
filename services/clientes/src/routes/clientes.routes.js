const express = require('express');
const router = express.Router();
const {
  getAllClientes,
  getClienteById,
  createCliente,
  updateCliente,
  deleteCliente
} = require('../controllers/clientes.controller');

// GET todos los clientes
router.get('/', getAllClientes);

// GET cliente por ID
router.get('/:id', getClienteById);

// POST crear cliente
router.post('/', createCliente);

// PUT actualizar cliente
router.put('/:id', updateCliente);

// DELETE eliminar cliente
router.delete('/:id', deleteCliente);

module.exports = router;