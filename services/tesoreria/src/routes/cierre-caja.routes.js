const router = require('express').Router();
const ctrl   = require('../controllers/cierre-caja.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Acceso por matriz (Perfiles y Permisos), no por nombre de perfil. Admin pasa por bypass.
const puede = [verifyToken, requireFunc('tesoreria_cierre_caja')];

router.get('/cajeros', ...puede, ctrl.getCajeros);
router.get('/',        ...puede, ctrl.getCierre);

module.exports = router;
