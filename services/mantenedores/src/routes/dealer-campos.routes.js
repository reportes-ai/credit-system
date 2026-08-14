const router = require('express').Router();
const ctrl = require('../controllers/dealer-campos.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Cada usuario consulta SUS permisos (sin permiso especial: es su propia foto).
router.get('/mios', verifyToken, ctrl.mios);
// La matriz completa y su edición son del mantenedor de Dealers.
router.get('/',     verifyToken, requireFunc('mantenedores_dealers'), ctrl.getMatriz);
router.put('/',     verifyToken, requireFunc('mantenedores_dealers'), ctrl.guardar);

module.exports = router;
