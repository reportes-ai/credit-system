const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/broker-validaciones.controller');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/:creditId',  verifyToken, ctrl.getValidaciones);
router.post('/:creditId', verifyToken, requireFunc('creditos_fundantes_validar','fundantes_validar'), ctrl.saveValidaciones);

module.exports = router;
