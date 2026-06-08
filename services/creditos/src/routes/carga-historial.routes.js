const router = require('express').Router();
const ctrl   = require('../controllers/carga-historial.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/sesiones',              verifyToken, ctrl.getSesiones);
router.get('/sesiones/:id',          verifyToken, ctrl.getDetalleSesion);
router.get('/sesiones/:id/download', verifyToken, ctrl.downloadDetalle);
router.get('/cambios',               verifyToken, ctrl.getCambios);
router.get('/cambios/download',      verifyToken, ctrl.downloadCambios);

module.exports = router;
