const router  = require('express').Router();
const ctrl    = require('../controllers/dashboard.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

// Configuración del dashboard (tabs/permisos y presupuesto) por matriz, no por
// nombre de perfil. Admin pasa por bypass; el resto requiere 'dashboard_config'.
const configurar = requireFunc('dashboard_config');

router.get('/datos',        verifyToken, ctrl.getDatos);
router.get('/permisos',     verifyToken, ctrl.getPermisos);
router.post('/permisos',    verifyToken, configurar, ctrl.savePermisos);
router.get('/presupuesto',  verifyToken, ctrl.getPresupuesto);
router.get('/seguros-historico', verifyToken, ctrl.getSegurosHistorico);
router.post('/presupuesto', verifyToken, configurar, ctrl.savePresupuesto);

module.exports = router;
