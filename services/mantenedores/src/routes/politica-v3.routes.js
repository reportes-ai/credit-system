const router = require('express').Router();
const ctrl = require('../controllers/politica-v3.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/tablas',         verifyToken, ctrl.getTablas);
router.put('/tablas/:clave',  verifyToken, requireFunc('política_ver'), ctrl.updateTabla);

module.exports = router;
