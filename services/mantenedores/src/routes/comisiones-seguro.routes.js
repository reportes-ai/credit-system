const router = require('express').Router();
const ctrl = require('../controllers/comisiones-seguro.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

router.get('/',        verifyToken,                              ctrl.getAll);
router.put('/:id',     verifyToken, requirePerfil('Administrador'), ctrl.update);

module.exports = router;
