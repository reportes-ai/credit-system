const router  = require('express').Router();
const ctrl    = require('../controllers/dashboard.controller');
const { verifyToken, requirePerfil } = require('../../../../shared/middleware/auth');

router.get('/datos',        verifyToken, ctrl.getDatos);
router.get('/permisos',     verifyToken, ctrl.getPermisos);
router.post('/permisos',    verifyToken, requirePerfil('Administrador'), ctrl.savePermisos);
router.get('/presupuesto',  verifyToken, ctrl.getPresupuesto);
router.post('/presupuesto', verifyToken, requirePerfil('Administrador'), ctrl.savePresupuesto);

module.exports = router;
