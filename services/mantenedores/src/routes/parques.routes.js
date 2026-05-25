const router = require('express').Router();
const ctrl = require('../controllers/parques.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const soloAdmin = requirePerfil('Administrador');

router.get('/',       verifyToken, ctrl.getAll);
router.post('/',      verifyToken, soloAdmin, ctrl.create);
router.put('/:id',    verifyToken, soloAdmin, ctrl.update);
router.delete('/:id', verifyToken, soloAdmin, ctrl.remove);

module.exports = router;
