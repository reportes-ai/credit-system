const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/informacion-comercial.controller');

// Auditoría 03-08-2026 (A-2): mismo hueco que antecedentes — el perfil de deudas
// de cualquier RUT era escribible por cualquier usuario autenticado.
router.get('/:rut', verifyToken, requireFunc('clientes_info_comercial', 'clientes_info_comercial2', 'clientes.ver', 'mant_bd_info_comercial'), ctrl.getByRut);
router.put('/:rut', verifyToken, requireFunc('clientes.editar', 'clientes.crear', 'mant_bd_info_comercial'), ctrl.upsert);

module.exports = router;
