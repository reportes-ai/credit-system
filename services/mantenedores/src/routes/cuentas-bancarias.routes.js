const router = require('express').Router();
const ctrl   = require('../controllers/cuentas-bancarias.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

const puedeGestionar = [verifyToken, requireFunc('mantenedores_cuentas_bancarias')];

router.get('/',     verifyToken,  ctrl.list);
router.get('/:id',  verifyToken,  ctrl.getOne);
router.post('/',    ...puedeGestionar, ctrl.create);
router.put('/:id',  ...puedeGestionar, ctrl.update);
router.delete('/:id', ...puedeGestionar, ctrl.remove);

module.exports = router;
