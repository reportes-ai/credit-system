const router = require('express').Router();
const ctrl = require('../controllers/config.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

router.get('/:clave',  verifyToken, ctrl.getConfig);
router.put('/:clave',  verifyToken, requirePerfil('Administrador'), ctrl.setConfig);

module.exports = router;
