const router = require('express').Router();
const ctrl = require('../controllers/politica-aprobacion.controller');
const { verifyToken } = require('../../../../shared/middleware/auth');

router.get('/matriz',  verifyToken, ctrl.getMatriz);
router.put('/matriz',  verifyToken, ctrl.updateMatriz);

module.exports = router;
