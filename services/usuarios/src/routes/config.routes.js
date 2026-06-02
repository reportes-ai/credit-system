const router = require('express').Router();
const ctrl      = require('../controllers/seguridad.controller');
const uiCtrl    = require('../controllers/ui-config.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

const soloAdmin = requirePerfil('Administrador');

router.get('/seguridad',      verifyToken,            ctrl.getConfig);
router.put('/seguridad',      verifyToken, soloAdmin, ctrl.putConfig);

router.get('/ui/ping',        verifyToken,            uiCtrl.ping);
router.get('/ui/:clave',      verifyToken,            uiCtrl.getUiConfig);
router.put('/ui/:clave',      verifyToken,            uiCtrl.putUiConfig);

module.exports = router;
