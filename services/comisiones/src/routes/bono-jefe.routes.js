const router = require('express').Router();
const ctrl = require('../controllers/bono-jefe.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

router.get('/bsc',       verifyToken, requireFunc('bono_jefe'), ctrl.getBSC);
router.get('/curva',     verifyToken, requireFunc('bono_jefe_variables'), ctrl.getCurva);
router.get('/variables', verifyToken, requireFunc('bono_jefe_variables'), ctrl.getVariables);
router.put('/variables', verifyToken, requireFunc('bono_jefe_variables'), ctrl.setVariables);

module.exports = router;
