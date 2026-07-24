const router = require('express').Router();
const ctrl = require('../controllers/vendedores-dealer.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Listar: lo necesita el Generador de Cartas (cualquier usuario autenticado con acceso al form)
router.get('/', verifyToken, ctrl.listar);
// Crear: desde la carta (ejecutivo con cartas_generador) o desde el mantenedor
router.post('/', verifyToken, requireFunc('cartas_generador', 'aprob_vendedores'), ctrl.crear);
// Editar/desactivar: solo el mantenedor
router.put('/:id', verifyToken, requireFunc('aprob_vendedores'), ctrl.editar);

module.exports = router;
