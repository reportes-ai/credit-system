const router = require('express').Router();
const ctrl   = require('../controllers/bd-operaciones.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');
const soloAdmin = requirePerfil('Administrador', 'Gerente');

router.get('/columns',  verifyToken, ctrl.getColumns);
router.get('/',         verifyToken, ctrl.getAll);
router.put('/:id',      verifyToken, soloAdmin, ctrl.update);
router.delete('/',      verifyToken, soloAdmin, ctrl.deleteMany);

module.exports = router;
