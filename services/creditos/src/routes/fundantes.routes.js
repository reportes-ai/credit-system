const router = require('express').Router();
const ctrl   = require('../controllers/fundantes.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/',              verifyToken, ctrl.getByOperacion);
router.get('/:id/download',  verifyToken, ctrl.download);
router.post('/',             verifyToken, ctrl.upload);
router.put('/:id/validar',   verifyToken, ctrl.validar);
router.delete('/:id',        verifyToken, ctrl.remove);

module.exports = router;
