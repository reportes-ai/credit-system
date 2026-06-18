const router = require('express').Router();
const ctrl = require('../controllers/estado-cartera.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

const FUNC = 'mantenedores_estado_cartera';

router.get('/',                     verifyToken, ctrl.getAll);
router.put('/parametros',           verifyToken, requireFunc(FUNC), ctrl.setParametros);
router.post('/',                    verifyToken, requireFunc(FUNC), ctrl.crear);
router.put('/:codigo/transiciones', verifyToken, requireFunc(FUNC), ctrl.setTransiciones);
router.put('/:codigo',              verifyToken, requireFunc(FUNC), ctrl.actualizar);
router.delete('/:codigo',           verifyToken, requireFunc(FUNC), ctrl.eliminar);

module.exports = router;
