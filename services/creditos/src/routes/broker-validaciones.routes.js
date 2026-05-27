const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const ctrl = require('../controllers/broker-validaciones.controller');

router.get('/:creditId',  verifyToken, ctrl.getValidaciones);
router.post('/:creditId', verifyToken, ctrl.saveValidaciones);

module.exports = router;
