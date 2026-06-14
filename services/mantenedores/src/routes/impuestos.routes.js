const router = require('express').Router();
const ctrl = require('../controllers/impuestos.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/valores', verifyToken, ctrl.getValores);
router.get('/',        verifyToken, ctrl.getAll);
router.put('/:codigo', verifyToken, requireFunc('mantenedores_impuestos'), ctrl.update);

module.exports = router;
