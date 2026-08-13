const router = require('express').Router();
const ctrl = require('../controllers/correos-plantillas.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

const puedeGestionar = requireFunc('mant_correos');

router.get('/',                    verifyToken, puedeGestionar, ctrl.listar);
router.put('/:codigo',             verifyToken, puedeGestionar, ctrl.guardar);
router.post('/:codigo/prueba',     verifyToken, puedeGestionar, ctrl.prueba);

module.exports = router;
