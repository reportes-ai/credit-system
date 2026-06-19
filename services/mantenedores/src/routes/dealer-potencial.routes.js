const router = require('express').Router();
const ctrl = require('../controllers/dealer-potencial.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');
const { requireFunc } = require('../../../../shared/middleware/permisos');

const FUNC = ['mantenedores_dealers', 'dealer_mantener'];

router.get('/',        verifyToken, ctrl.getPotencial);
router.get('/config',  verifyToken, ctrl.getConfigEndpoint);
router.put('/config',  verifyToken, requireFunc(...FUNC), ctrl.setConfig);
router.put('/:id',     verifyToken, requireFunc(...FUNC), ctrl.savePotencialDealer);

module.exports = router;
