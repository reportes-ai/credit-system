const express = require('express');
const router  = express.Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/antecedentes.controller');

// Auditoría 03-08-2026 (A-2): el PUT quedaba abierto a CUALQUIER autenticado —
// sin permiso ni verificación de pertenencia se podía sobrescribir el empleador
// y la RENTA de cualquier RUT, que es lo que alimenta la evaluación crediticia.
router.get('/:rut', verifyToken, requireFunc('clientes_antecedentes', 'clientes_antecedentes_lab', 'clientes.ver', 'mant_bd_antecedentes'), ctrl.getByRut);
router.put('/:rut', verifyToken, requireFunc('clientes.editar', 'clientes.crear', 'mant_bd_antecedentes'), ctrl.upsert);

module.exports = router;
