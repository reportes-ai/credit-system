const router = require('express').Router();
const ctrl   = require('../controllers/cuentas-bancarias.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const soloAdmin = [verifyToken, requirePerfil('Administrador', 'Gerente')];

router.get('/',     verifyToken,  ctrl.list);
router.get('/:id',  verifyToken,  ctrl.getOne);
router.post('/',    ...soloAdmin, ctrl.create);
router.put('/:id',  ...soloAdmin, ctrl.update);
router.delete('/:id', ...soloAdmin, ctrl.remove);

module.exports = router;
