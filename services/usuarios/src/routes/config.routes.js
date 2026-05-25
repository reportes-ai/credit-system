const router = require('express').Router();
const ctrl   = require('../controllers/seguridad.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const soloAdmin = requirePerfil('Administrador');

router.get('/seguridad',  verifyToken,             ctrl.getConfig);
router.put('/seguridad',  verifyToken, soloAdmin,  ctrl.putConfig);

module.exports = router;
