'use strict';
const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/seguros-autofacil.controller');

// Lectura y motor de prima: los consumen simulador/cartas → sin permiso de pestaña.
router.get('/',                      verifyToken, ctrl.listar);
router.get('/prima',                 verifyToken, ctrl.prima);
// Edición: exclusiva del mantenedor.
router.put('/:seguro/tramos',        verifyToken, requireFunc('mant_seguros_autofacil'), ctrl.setTramos);
router.put('/:seguro/comisiones',    verifyToken, requireFunc('mant_seguros_autofacil'), ctrl.setComisiones);
router.put('/:seguro',               verifyToken, requireFunc('mant_seguros_autofacil'), ctrl.actualizar);

module.exports = router;
