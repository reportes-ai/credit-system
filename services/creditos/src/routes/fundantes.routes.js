const router = require('express').Router();
const ctrl   = require('../controllers/fundantes.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/',              verifyToken, ctrl.getByOperacion);
router.get('/:id/download',  verifyToken, ctrl.download);
router.post('/',             verifyToken, requireFunc('creditos_fundantes_cargar'), ctrl.upload);
router.put('/:id/validar',   verifyToken, requireFunc('creditos_fundantes_validar'), ctrl.validar);
router.delete('/:id',        verifyToken, requireFunc('creditos_fundantes_cargar'), ctrl.remove);

module.exports = router;
