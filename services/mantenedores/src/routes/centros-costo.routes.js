const router = require('express').Router();
const ctrl = require('../controllers/centros-costo.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

const puedeGestionar = [verifyToken, requireFunc('mantenedores_centros_costo')];

router.get('/', verifyToken, ctrl.list);
router.post('/', ...puedeGestionar, ctrl.create);
router.put('/:codigo', ...puedeGestionar, ctrl.update);
router.delete('/:codigo', ...puedeGestionar, ctrl.remove);

module.exports = router;
