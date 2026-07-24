const router = require('express').Router();
const ctrl = require('../controllers/vendedores-dealer.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Listar: lo necesita el Generador de Cartas (cualquier usuario autenticado con acceso al form)
router.get('/', verifyToken, ctrl.listar);
// Crear: desde la carta — mismo criterio que POST /api/cartas (solo autenticado),
// porque cualquier usuario que digita cartas debe poder registrar al vendedor.
router.post('/', verifyToken, ctrl.crear);
// Editar/desactivar: solo el mantenedor
router.put('/:id', verifyToken, requireFunc('aprob_vendedores'), ctrl.editar);

module.exports = router;
