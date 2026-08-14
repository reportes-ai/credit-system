const router = require('express').Router();
const ctrl = require('../controllers/dealer-campos.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Cada usuario consulta SUS permisos (sin permiso especial: es su propia foto).
router.get('/mios', verifyToken, ctrl.mios);
// La matriz vive en Creación/Mantenedor de Dealer › Permisos de Edición.
router.get('/',     verifyToken, requireFunc('dealer_campos_permisos'), ctrl.getMatriz);
router.put('/',     verifyToken, requireFunc('dealer_campos_permisos'), ctrl.guardar);

module.exports = router;
