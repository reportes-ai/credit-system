const router = require('express').Router();
const ctrl = require('../controllers/politica-aprobacion.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/matriz',  verifyToken, ctrl.getMatriz);
router.put('/matriz',  verifyToken, requireFunc('política_ver'), ctrl.updateMatriz);

module.exports = router;
