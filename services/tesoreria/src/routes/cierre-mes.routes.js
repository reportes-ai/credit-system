const router = require('express').Router();
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');
const ctrl = require('../controllers/cierre-mes.controller');

const ver     = requireFunc('cierre_mes', 'cierre_mes_cerrar');
const cerrar  = requireFunc('cierre_mes_cerrar');
const configurar = requireFunc('cierre_mes_config');

router.get('/estado',   verifyToken, ver, ctrl.getEstado);
router.post('/ok',      verifyToken, ver, ctrl.marcarOk);       // autorización fina en el controller (responsable o admin)
router.post('/cerrar',  verifyToken, cerrar, ctrl.cerrarMes);

router.get('/config',   verifyToken, configurar, ctrl.getConfig);
router.post('/items',   verifyToken, configurar, ctrl.guardarItem);
router.put('/config',   verifyToken, configurar, ctrl.guardarConfig);

module.exports = router;
