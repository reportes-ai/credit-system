const router = require('express').Router();
const ctrl   = require('../controllers/plantillas.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/',                        verifyToken, ctrl.getAll);
router.get('/:codigo',                 verifyToken, ctrl.getByCodigo);
router.put('/:codigo',                 verifyToken, ctrl.update);
router.post('/:codigo/reset-default',  verifyToken, ctrl.resetDefault);

module.exports = router;
