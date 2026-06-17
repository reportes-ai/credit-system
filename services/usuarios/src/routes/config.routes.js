const router = require('express').Router();
const ctrl      = require('../controllers/seguridad.controller');
const uiCtrl    = require('../controllers/ui-config.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Config de seguridad por matriz (Perfiles y Permisos), no por nombre de perfil.
// Admin pasa por bypass; el resto requiere 'usuarios_seguridad'.
const configSeguridad = requireFunc('usuarios_seguridad');

router.get('/seguridad',      verifyToken,                ctrl.getConfig);
router.put('/seguridad',      verifyToken, configSeguridad, ctrl.putConfig);

router.get('/ui/ping',        verifyToken,            uiCtrl.ping);
router.get('/ui/:clave',      verifyToken,            uiCtrl.getUiConfig);
router.put('/ui/:clave',      verifyToken,            uiCtrl.putUiConfig);

module.exports = router;
