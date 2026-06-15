const router = require('express').Router();
const ctrl   = require('../controllers/plantillas.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/',                        verifyToken, ctrl.getAll);
router.get('/:codigo',                 verifyToken, ctrl.getByCodigo);
router.put('/:codigo',                 verifyToken, requireFunc('mantenedores_plantillas'), ctrl.update);
router.post('/:codigo/reset-default',  verifyToken, requireFunc('mantenedores_plantillas'), ctrl.resetDefault);

module.exports = router;
